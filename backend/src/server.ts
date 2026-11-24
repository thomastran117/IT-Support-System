import { loadEnv } from './config/env.js';
import { startHttpServer } from './httpServer.js';

await startHttpServer(loadEnv());
