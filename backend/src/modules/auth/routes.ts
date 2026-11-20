import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import type { AuthSession } from '@smartdesk/contracts';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { createRequireAuth, loadValidUser, toAuthUser } from '../../auth/guard.js';
import { verifyDummy, verifyPassword } from '../../auth/password.js';
import type { TokenService } from '../../auth/tokens.js';
import { envelope, HttpError } from '../../plugins/errors.js';

export const REFRESH_COOKIE = 'sd_refresh';
const COOKIE_PATH = '/api/auth';

export interface AuthRouteOptions {
  prisma: PrismaClient;
  env: Env;
  tokens: TokenService;
  rateLimit: { login: number; refresh: number; windowMs: number };
}

const LoginBody = z.object({
  email: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(1024),
});

const INVALID_CREDENTIALS = () => new HttpError(401, 'Invalid email or password');
const INVALID_SESSION = () => new HttpError(401, 'Session is invalid or expired');

export const authRoutes =
  ({ prisma, env, tokens, rateLimit }: AuthRouteOptions): FastifyPluginAsync =>
  async (app) => {
    const requireAuth = createRequireAuth(prisma, tokens);

    const setRefreshCookie = (reply: FastifyReply, token: string) =>
      reply.setCookie(REFRESH_COOKIE, token, {
        httpOnly: true,
        secure: env.cookieSecure,
        sameSite: 'strict',
        path: COOKIE_PATH,
        maxAge: tokens.refreshTtlSeconds,
      });
    const clearRefreshCookie = (reply: FastifyReply) =>
      reply.clearCookie(REFRESH_COOKIE, {
        httpOnly: true,
        secure: env.cookieSecure,
        sameSite: 'strict',
        path: COOKIE_PATH,
      });

    /** Cookie-authenticated mutations must come from the configured frontend origin (CSRF). */
    const requireTrustedOrigin = async (req: FastifyRequest) => {
      if (req.headers.origin !== env.frontendOrigin) throw new HttpError(403, 'Origin not allowed');
    };

    const issue = async (
      reply: FastifyReply,
      user: { id: string; email: string; displayName: string; role: string; tokenVersion: number },
    ): Promise<AuthSession> => {
      const [accessToken, refreshToken] = await Promise.all([
        tokens.sign('access', user.id, user.tokenVersion),
        tokens.sign('refresh', user.id, user.tokenVersion),
      ]);
      setRefreshCookie(reply, refreshToken);
      reply.header('cache-control', 'no-store');
      return { accessToken, expiresIn: tokens.accessTtlSeconds, user: toAuthUser(user) };
    };

    const limit = (max: number) => ({ rateLimit: { max, timeWindow: rateLimit.windowMs } });

    app.post('/login', { config: limit(rateLimit.login) }, async (req, reply) => {
      const parsed = LoginBody.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'Validation failed', z.flattenError(parsed.error).fieldErrors);
      }
      const { email, password } = parsed.data;
      const user = await prisma.user.findUnique({ where: { email } });
      // Unknown or credential-less accounts still pay for one verification (no timing oracle).
      const ok = user?.passwordHash
        ? await verifyPassword(user.passwordHash, password)
        : await verifyDummy(password);
      if (!user || !user.passwordHash || !user.isActive || !ok) throw INVALID_CREDENTIALS();
      return envelope('Signed in', await issue(reply, user));
    });

    app.post(
      '/refresh',
      { config: limit(rateLimit.refresh), preHandler: requireTrustedOrigin },
      async (req, reply) => {
        const token = req.cookies[REFRESH_COOKIE];
        const claims = token ? await tokens.verify('refresh', token) : null;
        const user = claims ? await loadValidUser(prisma, claims) : null;
        if (!claims || !user) {
          clearRefreshCookie(reply);
          throw INVALID_SESSION();
        }
        return envelope('Session refreshed', await issue(reply, user));
      },
    );

    // Idempotent. Stateless tokens cannot be revoked individually, so this clears the cookie only;
    // see docs/auth.md for the accepted tradeoff.
    app.post('/logout', { preHandler: requireTrustedOrigin }, async (_req, reply) => {
      clearRefreshCookie(reply);
      return envelope('Signed out');
    });

    app.get('/me', { preHandler: requireAuth }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return envelope('Current user', req.auth);
    });
  };
