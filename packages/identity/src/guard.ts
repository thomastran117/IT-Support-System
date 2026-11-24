import type { preHandlerAsyncHookHandler } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import type { AuthUser, Role } from '@smartdesk/contracts';
import { HttpError } from './http.js';
import type { TokenClaims, TokenService } from './tokens.js';

export interface Principal extends AuthUser {
  /** Ticket supplies active team membership for requests to its routes. */
  teamIds: readonly string[];
}

export type AuthenticatePrincipal = (
  accessToken: string,
  requestId: string,
) => Promise<{ principal: Principal; tokenVersion: number } | null>;

export interface AuthGuards {
  requireAuth: preHandlerAsyncHookHandler;
  requireRole: (...roles: Role[]) => preHandlerAsyncHookHandler[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
  interface FastifyInstance {
    authGuards: AuthGuards;
  }
}

export const toAuthUser = (u: {
  id: string;
  email: string;
  displayName: string;
  role: string;
}): AuthUser => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role as Role });

export const readBearerToken = (header: string | undefined) =>
  header ? /^Bearer (\S+)$/i.exec(header)?.[1] : undefined;

/** Confirm that the current account still honours the token. */
export async function loadValidUser(prisma: Pick<PrismaClient, 'user'>, claims: TokenClaims) {
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      isActive: true,
      tokenVersion: true,
    },
  });
  if (!user?.isActive || user.tokenVersion !== claims.tv) return null;
  return user;
}

/** Account lookups never query or grant team membership. */
export function createAccountAuthenticator(
  prisma: Pick<PrismaClient, 'user'>,
  tokens: TokenService,
): AuthenticatePrincipal {
  return async (token) => {
    const claims = await tokens.verify('access', token);
    const user = claims && (await loadValidUser(prisma, claims));
    return (
      user && { principal: { ...toAuthUser(user), teamIds: [] }, tokenVersion: user.tokenVersion }
    );
  };
}

export function createAuthGuards(authenticate: AuthenticatePrincipal): AuthGuards {
  const requireAuth: preHandlerAsyncHookHandler = async (req) => {
    const token = readBearerToken(req.headers.authorization);
    const user = token && (await authenticate(token, req.id));
    if (!user) throw new HttpError(401, 'Authentication required');
    req.principal = user.principal;
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
