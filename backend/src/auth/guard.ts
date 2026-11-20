import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '@smartdesk/db';
import type { AuthUser, Role } from '@smartdesk/contracts';
import { HttpError } from '../plugins/errors.js';
import type { TokenClaims, TokenService } from './tokens.js';

type User = Prisma.UserGetPayload<object>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by {@link createRequireAuth}; always loaded from the database, never from the token. */
    auth?: AuthUser;
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

/** preHandler: requires a valid access token. Policies and role guards build on this (SD-015). */
export function createRequireAuth(prisma: PrismaClient, tokens: TokenService) {
  return async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const match = header ? /^Bearer (\S+)$/i.exec(header) : null;
    if (!match) throw UNAUTHENTICATED();
    const claims = await tokens.verify('access', match[1]!);
    if (!claims) throw UNAUTHENTICATED();
    const user = await loadValidUser(prisma, claims);
    if (!user) throw UNAUTHENTICATED();
    req.auth = toAuthUser(user);
  };
}
