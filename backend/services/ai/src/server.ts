import { buildAiService } from './app.js';
import { loadServiceConfig } from './config.js';

const config = loadServiceConfig();
const app = buildAiService(config);
const stop = () => {
  void app.close().catch((err: unknown) => {
    app.log.error({ err }, 'AI service shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.listen({ host: config.host, port: config.port });
