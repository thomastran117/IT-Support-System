import type { PrismaClient } from '@smartdesk/db';
import { createInternalGuard as makeGuard, type TokenService } from '@smartdesk/identity';
import type { VerifyServiceToken } from './serviceTokens.js';
import { createTicketAuthenticator } from './guard.js';

export { DELEGATED_USER_TOKEN_HEADER } from '@smartdesk/identity';

export function createInternalGuard(
  prisma: Pick<PrismaClient, 'user'>,
  tokens: TokenService,
  verify: VerifyServiceToken,
) {
  return makeGuard(createTicketAuthenticator(prisma, tokens), verify);
}
