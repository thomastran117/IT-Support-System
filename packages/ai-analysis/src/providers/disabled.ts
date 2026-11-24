import { ProviderError, type AIProvider } from '../provider.js';

/** Used when `AI_PROVIDER=none`: analysis is unavailable but nothing else is affected. */
export const disabledProvider: AIProvider = {
  name: 'none',
  async analyse() {
    throw new ProviderError('disabled', 'AI analysis is disabled');
  },
};
