import {
  ProviderError,
  validateProposal,
  type AIProvider,
  type AnalysisRequest,
  type ValidatedProposal,
} from '../provider.js';
import { SYSTEM_INSTRUCTIONS, buildUserMessage } from '../prompt.js';
import { proposalJsonSchema } from '../schema.js';

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  maxInputChars: number;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

interface ChatResponse {
  choices?: { message?: { content?: unknown }; finish_reason?: string }[];
}

/** OpenAI Chat Completions with strict JSON-schema output. The API key only ever appears in the Authorization header. */
export function createOpenAiProvider(opts: OpenAiOptions): AIProvider {
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
  return {
    name: 'openai',
    async analyse(request: AnalysisRequest): Promise<ValidatedProposal> {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          signal: AbortSignal.timeout(opts.timeoutMs),
          body: JSON.stringify({
            model: opts.model,
            max_completion_tokens: opts.maxOutputTokens,
            messages: [
              { role: 'system', content: SYSTEM_INSTRUCTIONS },
              { role: 'user', content: buildUserMessage(request, opts.maxInputChars) },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'ticket_recommendation',
                strict: true,
                schema: proposalJsonSchema,
              },
            },
          }),
        });
      } catch (err) {
        const name = (err as { name?: string }).name;
        throw new ProviderError(
          name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable',
        );
      }
      if (res.status === 429) throw new ProviderError('rate_limited');
      if (res.status >= 500 || res.status === 408) throw new ProviderError('unavailable');
      if (!res.ok) {
        throw new ProviderError(
          'unavailable',
          `AI provider rejected the request (HTTP ${res.status})`,
        );
      }

      let body: ChatResponse;
      try {
        body = (await res.json()) as ChatResponse;
      } catch {
        throw new ProviderError('malformed', 'AI response was not valid JSON');
      }
      const choice = body.choices?.[0];
      if (choice?.finish_reason === 'length') {
        throw new ProviderError('malformed', 'AI response was truncated');
      }
      return validateProposal(choice?.message?.content, request, `openai:${opts.model}`);
    },
  };
}
