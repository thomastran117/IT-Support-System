import { createHash } from 'node:crypto';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { HttpError } from './http.js';
import { readBearerToken, type AuthenticatePrincipal, type Principal } from './guard.js';
import type { VerifyServiceToken } from '@smartdesk/service-runtime/service-tokens';

export const DELEGATED_USER_TOKEN_HEADER = 'x-smartdesk-internal-user-token';

type InternalActor =
  | { kind: 'system'; service: string }
  | { kind: 'user'; service: string; principal: Principal; tokenVersion: number };

declare module 'fastify' {
  interface FastifyRequest {
    internalActor?: InternalActor;
  }
}

const invalidService = () => new HttpError(401, 'Service authentication required');
const invalidUser = () => new HttpError(401, 'Delegated user authentication required');

export function createInternalGuard(
  authenticate: AuthenticatePrincipal,
  verifyServiceToken: VerifyServiceToken,
) {
  return (scope: string, kind: InternalActor['kind']): preHandlerAsyncHookHandler =>
    async (req) => {
      const token = readBearerToken(req.headers.authorization);
      if (!token) throw invalidService();
      const verifier = await verifyServiceToken(token, scope, kind);
      if (verifier.result === 'forbidden') throw new HttpError(403, 'Service scope not allowed');
      if (verifier.result !== 'authorized') throw invalidService();

      const { service, actor } = verifier;
      const userToken = req.headers[DELEGATED_USER_TOKEN_HEADER];
      if (actor.kind === 'system') {
        if (userToken !== undefined) {
          throw new HttpError(403, 'System calls cannot carry delegated user credentials');
        }
        req.internalActor = { kind: 'system', service };
        return;
      }

      if (
        typeof userToken !== 'string' ||
        createHash('sha256').update(userToken).digest('base64url') !== actor.tokenHash
      ) {
        throw invalidUser();
      }
      const user = await authenticate(userToken, req.id);
      if (!user) throw invalidUser();
      req.internalActor = { kind: 'user', service, ...user };
    };
}
