import type { PrismaClient } from '@smartdesk/db';
import {
  toAuthUser,
  type AuthenticatePrincipal,
  type Principal,
  type TokenService,
} from '@smartdesk/identity';

export {
  loadValidUser,
  readBearerToken,
  toAuthUser,
  type AuthGuards,
  type Principal,
} from '@smartdesk/identity';

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

export function createTicketAuthenticator(
  prisma: Pick<PrismaClient, 'user'>,
  tokens: TokenService,
): AuthenticatePrincipal {
  return async (accessToken) => {
    const claims = await tokens.verify('access', accessToken);
    if (!claims) return null;
    const current = await loadActivePrincipal(prisma, claims.sub);
    return current?.tokenVersion === claims.tv ? current : null;
  };
}
