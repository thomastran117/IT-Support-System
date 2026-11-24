import { TICKET_IDENTITY, ticketIdentityStateSchema } from '@smartdesk/contracts';
import type { PrismaClient } from '@smartdesk/db';
import { HttpError } from '@smartdesk/db/errors';
import type { AuthenticatePrincipal } from '@smartdesk/identity';
import {
  createDelegatedIdentityResolver,
  ServiceRequestError,
} from '@smartdesk/service-runtime/delegated-identity';
import { loadActivePrincipal } from './guard.js';

export async function createRemoteIdentityAuthenticator(
  prisma: Pick<PrismaClient, 'user'>,
  config: { identityOrigin: URL; keyId: string; privateKey: string },
): Promise<AuthenticatePrincipal> {
  const resolve = await createDelegatedIdentityResolver({
    ...config,
    service: 'ticket',
    keySetting: 'TICKET_IDENTITY_PRIVATE_KEY',
    route: TICKET_IDENTITY,
    decode: (body) => ticketIdentityStateSchema.parse(body),
  });
  return async (token, requestId) => {
    let account;
    try {
      account = await resolve(`Bearer ${token}`, requestId);
    } catch (error) {
      if (error instanceof ServiceRequestError && error.status === 401) return null;
      throw new HttpError(503, 'Identity temporarily unavailable');
    }
    // Ticket owns membership. Recheck the account version against the same snapshot used for scope.
    const current = await loadActivePrincipal(prisma, account.id);
    return current?.tokenVersion === account.tokenVersion ? current : null;
  };
}
