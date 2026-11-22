import type { Env } from '../../config/env.js';
import type { AIProvider } from './provider.js';
import { disabledProvider } from './providers/disabled.js';
import { createFakeProvider } from './providers/fake.js';
import { createOpenAiProvider } from './providers/openai.js';

export * from './provider.js';
export * from './schema.js';

/** Select the provider from configuration. The API key is only passed to the live adapter. */
export function createProvider(env: Pick<Env, 'ai'>): AIProvider {
  const { ai } = env;
  switch (ai.provider) {
    case 'fake':
      return createFakeProvider();
    case 'openai':
      return createOpenAiProvider({
        apiKey: ai.apiKey,
        model: ai.model,
        timeoutMs: ai.timeoutMs,
        maxOutputTokens: ai.maxOutputTokens,
        maxInputChars: ai.maxInputChars,
      });
    default:
      return disabledProvider;
  }
}
export * from './analysisService.js';
export { redactText } from './redact.js';
export { PROMPT_VERSION } from './prompt.js';
export * from './recommendationService.js';
