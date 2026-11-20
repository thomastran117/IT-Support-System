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

export function createAuthGuards(prisma: PrismaClient, tokens: TokenService): AuthGuards {
  const requireAuth: preHandlerAsyncHookHandler = async (req) => {
    const header = req.headers.authorization;
    const match = header ? /^Bearer (\S+)$/i.exec(header) : null;
    if (!match) throw UNAUTHENTICATED();
    const claims = await tokens.verify('access', match[1]!);
    if (!claims) throw UNAUTHENTICATED();
    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      include: {
        teamMemberships: { where: { team: { isActive: true } }, select: { teamId: true } },
      },
    });
    if (!user || !user.isActive || user.tokenVersion !== claims.tv) throw UNAUTHENTICATED();
    req.principal = {
      ...toAuthUser(user),
      teamIds: user.teamMemberships.map((m) => m.teamId),
    };
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
