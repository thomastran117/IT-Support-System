import { createProvider as selectProvider } from '@smartdesk/ai-analysis';
import type { Env } from '../../config/env.js';

export const createProvider = (env: Pick<Env, 'ai'>) => selectProvider(env.ai);
export * from './analysisService.js';
export * from './recommendationService.js';
export { runEvaluation } from './evaluation/run.js';
