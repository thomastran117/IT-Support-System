import {
  KNOWLEDGE_IDENTITY,
  KNOWLEDGE_RETRIEVAL,
  knowledgePrincipalSchema,
} from '@smartdesk/contracts';
import { createPrisma } from '@smartdesk/db';
import { createDelegatedIdentityResolver } from '@smartdesk/service-runtime/delegated-identity';
import { createServiceTokenVerifier } from '@smartdesk/service-runtime/service-tokens';
import { buildKnowledgeApp } from './app.js';
import { loadServiceConfig } from './config.js';

const config = loadServiceConfig();
const resolvePrincipal = await createDelegatedIdentityResolver({
  ...config,
  keySetting: 'KNOWLEDGE_PRIVATE_KEY',
  service: 'knowledge',
  route: KNOWLEDGE_IDENTITY,
  decode: (body) => knowledgePrincipalSchema.parse(body),
});
const verifyRetrievalToken = await createServiceTokenVerifier(
  KNOWLEDGE_RETRIEVAL.audience,
  config.retrievalKeys,
);
const prisma = createPrisma(config.databaseUrl);
const app = await buildKnowledgeApp({ ...config, prisma, resolvePrincipal, verifyRetrievalToken });
app.addHook('onClose', () => prisma.$disconnect());
const stop = () => {
  void app.close().catch(() => {
    app.log.error('Knowledge shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.listen({ host: config.host, port: config.port });
