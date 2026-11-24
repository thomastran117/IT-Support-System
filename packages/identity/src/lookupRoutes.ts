import type { FastifyContextConfig, FastifyPluginAsync } from 'fastify';
import {
  ANALYTICS_IDENTITY,
  KNOWLEDGE_IDENTITY,
  NOTIFICATION_IDENTITY,
  TICKET_IDENTITY,
} from '@smartdesk/contracts';
import {
  createServiceTokenVerifier,
  type loadServiceKeys,
} from '@smartdesk/service-runtime/service-tokens';
import { createInternalGuard } from './internalGuard.js';
import type { AuthenticatePrincipal } from './guard.js';
import { HttpError } from './http.js';

const privateRoute: FastifyContextConfig & { cors: false } = { cors: false };
type Lookup =
  | typeof ANALYTICS_IDENTITY
  | typeof KNOWLEDGE_IDENTITY
  | typeof NOTIFICATION_IDENTITY
  | typeof TICKET_IDENTITY;

export const identityLookupRoutes =
  (options: {
    authenticate: AuthenticatePrincipal;
    keys: ReturnType<typeof loadServiceKeys>;
    lookups: readonly Lookup[];
  }): FastifyPluginAsync =>
  async (app) => {
    const { authenticate, keys, lookups } = options;
    if (keys.length === 0 || lookups.length === 0) return;
    const verify = await createServiceTokenVerifier(TICKET_IDENTITY.audience, keys);
    const guard = createInternalGuard(authenticate, verify);
    for (const lookup of lookups) {
      app.get(
        lookup.path,
        {
          config: privateRoute,
          exposeHeadRoute: false,
          preHandler: guard(lookup.scope, 'user'),
        },
        async (req, reply) => {
          const actor = req.internalActor;
          if (actor?.kind !== 'user') throw new HttpError(403, 'Delegated user required');
          const { id, role } = actor.principal;
          reply.header('cache-control', 'no-store');
          if (lookup === NOTIFICATION_IDENTITY) return { recipientId: id };
          if (lookup === TICKET_IDENTITY) return { id, tokenVersion: actor.tokenVersion };
          return { id, role };
        },
      );
      app.options(lookup.path, { config: privateRoute }, (_req, reply) => reply.callNotFound());
    }
  };
