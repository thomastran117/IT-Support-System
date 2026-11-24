import type { preHandlerAsyncHookHandler } from 'fastify';
import type { Prisma, PrismaClient } from '@smartdesk/db';
import type { AuthUser, Role } from '@smartdesk/contracts';
import { HttpError } from '../plugins/errors.js';
import type { TokenClaims, TokenService } from './tokens.js';

type User = Prisma.UserGetPayload<object>;

/**
 * The caller as the server knows them right now. Every field is read from the database on each
 * request; nothing here comes from the client, and the token only supplies the user id.
 */
export interface Principal extends AuthUser {
  /** Active support teams the user belongs to. */
  teamIds: readonly string[];
}

export interface AuthGuards {
  /** preHandler: a valid access token for an active user. 401 otherwise. */
  requireAuth: preHandlerAsyncHookHandler;
  /** preHandlers: `requireAuth`, then a role check (403 for any other role). */
  requireRole: (...roles: Role[]) => preHandlerAsyncHookHandler[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`. Absent on public routes. */
    principal?: Principal;
  }
  interface FastifyInstance {
    /** Route guards; present when the app was built with a database client. */
    authGuards: AuthGuards;
  }
}

export const toAuthUser = (u: {
  id: string;
  email: string;
  displayName: string;
  role: string;
}): AuthUser => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role as Role });

/**
 * Load the user a token claims to be and confirm the token is still honoured: the account exists,
 * is active and its token_version has not moved on. Returns null otherwise.
 */
export async function loadValidUser(
  prisma: PrismaClient,
  claims: TokenClaims,
): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  if (!user || !user.isActive || user.tokenVersion !== claims.tv) return null;
  return user;
}

const UNAUTHENTICATED = () => new HttpError(401, 'Authentication required');

export const readBearerToken = (header: string | undefined) =>
  header ? /^Bearer (\S+)$/i.exec(header)?.[1] : undefined;

/** Current account and team scope, shared by the request guard and deferred search hydration. */
export async function loadActivePrincipal(prisma: Pick<PrismaClient, 'user'>, id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      isActive: true,
      tokenVersion: true,
      teamMemberships: { where: { team: { isActive: true } }, select: { teamId: true } },
    },
  });
  if (!user?.isActive) return null;
  const principal: Principal = {
    ...toAuthUser(user),
    teamIds: user.teamMemberships.map((membership) => membership.teamId),
  };
  return { principal, tokenVersion: user.tokenVersion };
}

export async function authenticatePrincipal(
  prisma: Pick<PrismaClient, 'user'>,
  tokens: TokenService,
  accessToken: string,
): Promise<Principal | null> {
  const claims = await tokens.verify('access', accessToken);
  if (!claims) return null;
  const current = await loadActivePrincipal(prisma, claims.sub);
  return current && current.tokenVersion === claims.tv ? current.principal : null;
}

export function createAuthGuards(prisma: PrismaClient, tokens: TokenService): AuthGuards {
  const requireAuth: preHandlerAsyncHookHandler = async (req) => {
    const token = readBearerToken(req.headers.authorization);
    const principal = token && (await authenticatePrincipal(prisma, tokens, token));
    if (!principal) throw UNAUTHENTICATED();
    req.principal = principal;
  };

  const requireRole = (...roles: Role[]): preHandlerAsyncHookHandler[] => [
    requireAuth,
    async (req) => {
      if (!req.principal || !roles.includes(req.principal.role)) {
        throw new HttpError(403, 'You do not have permission to perform this action');
      }
    },
  ];

  return { requireAuth, requireRole };
}
