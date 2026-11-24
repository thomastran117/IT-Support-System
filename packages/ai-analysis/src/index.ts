import type { AiConfig } from './config.js';
import type { AIProvider } from './provider.js';
import { disabledProvider } from './providers/disabled.js';
import { createFakeProvider } from './providers/fake.js';
import { createOpenAiProvider } from './providers/openai.js';

export * from './analysis.js';
export * from './config.js';
export * from './jobRunner.js';
export * from './provider.js';
export * from './schema.js';
export * from './prompt.js';
export * from './redact.js';
export { createFakeProvider, createOpenAiProvider };

export function createProvider(config: AiConfig): AIProvider {
  switch (config.provider) {
    case 'fake':
      return createFakeProvider();
    case 'openai':
      return createOpenAiProvider(config);
    default:
      return disabledProvider;
  }
}
