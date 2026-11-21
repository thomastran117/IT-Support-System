import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';
import { createProvider } from '../../../src/modules/ai/index.js';
import {
  ProviderError,
  validateProposal,
  type AnalysisRequest,
} from '../../../src/modules/ai/provider.js';
import { createFakeProvider } from '../../../src/modules/ai/providers/fake.js';
import { createOpenAiProvider } from '../../../src/modules/ai/providers/openai.js';

const CAT = '00000001-0000-4000-8000-000000000001';
const TEAM = '00000001-0000-4000-8000-000000000002';
const ART = '00000001-0000-4000-8000-000000000003';
const OTHER = '00000001-0000-4000-8000-0000000000ff';
const KEY = 'sk-test-super-secret-key-123';

const request: AnalysisRequest = {
  ticket: { title: 'VPN down', description: 'Cannot connect to the VPN from home.' },
  allowedCategories: [{ id: CAT, name: 'Network' }],
  allowedTeams: [{ id: TEAM, name: 'Network team' }],
  articles: [{ id: ART, title: 'VPN troubleshooting', body: 'Restart the client.' }],
};

const valid = {
  categoryId: CAT,
  teamId: TEAM,
  priority: 'HIGH',
  troubleshooting: 'Restart the VPN client, then check credentials.',
  confidence: 0.8,
  citedArticleIds: [ART],
};

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return (e as ProviderError).kind;
  }
  return 'resolved';
};

describe('validateProposal', () => {
  it('parses a valid response into the canonical DTO', () => {
    expect(validateProposal(JSON.stringify(valid), request, 'fake:v1')).toEqual({
      ...valid,
      modelVersion: 'fake:v1',
    });
  });

  it('defaults absent optional fields', () => {
    const min = { categoryId: CAT, teamId: TEAM, priority: 'LOW', troubleshooting: 'Reboot.' };
    expect(validateProposal(min, request, 'm')).toMatchObject({
      confidence: null,
      citedArticleIds: [],
    });
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['non-object', '"hello"'],
    ['missing field', { ...valid, teamId: undefined }],
    ['empty troubleshooting', { ...valid, troubleshooting: '  ' }],
    ['invalid priority', { ...valid, priority: 'URGENT' }],
    ['UNSET priority', { ...valid, priority: 'UNSET' }],
    ['confidence out of range', { ...valid, confidence: 1.5 }],
    ['non-uuid id', { ...valid, categoryId: 'network' }],
    ['unexpected key', { ...valid, action: 'delete_ticket' }],
  ])('rejects %s as malformed', (_name, raw) => {
    expect(() => validateProposal(raw, request, 'm')).toThrowError(
      expect.objectContaining({ kind: 'malformed', retryable: false }),
    );
  });

  it.each([
    ['unknown category', { ...valid, categoryId: OTHER }],
    ['unknown team', { ...valid, teamId: OTHER }],
    ['article not retrieved', { ...valid, citedArticleIds: [OTHER] }],
  ])('rejects %s as invalid_reference', (_name, raw) => {
    expect(() => validateProposal(raw, request, 'm')).toThrowError(
      expect.objectContaining({ kind: 'invalid_reference', retryable: false }),
    );
  });

  it('de-duplicates cited articles', () => {
    const out = validateProposal({ ...valid, citedArticleIds: [ART, ART] }, request, 'm');
    expect(out.citedArticleIds).toEqual([ART]);
  });
});

describe('fake provider', () => {
  it('is deterministic and valid by default', async () => {
    const p = createFakeProvider();
    const a = await p.analyse(request);
    expect(a).toEqual(await p.analyse(request));
    expect(a).toMatchObject({ categoryId: CAT, teamId: TEAM, citedArticleIds: [ART] });
  });

  it('runs scripted output through validation', async () => {
    const p = createFakeProvider(() => ({ ...valid, categoryId: OTHER }));
    expect(await kindOf(p.analyse(request))).toBe('invalid_reference');
  });

  it('can simulate provider failures', async () => {
    const p = createFakeProvider(() => new ProviderError('rate_limited'));
    await expect(p.analyse(request)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    });
  });
});

describe('openai provider (mocked fetch)', () => {
  const make = (fetchImpl: typeof fetch, timeoutMs = 1000) =>
    createOpenAiProvider({
      apiKey: KEY,
      model: 'test-model',
      timeoutMs,
      maxOutputTokens: 500,
      maxInputChars: 10_000,
      fetch: fetchImpl,
    });
  const reply = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const completion = (content: unknown, finish = 'stop') => ({
    choices: [{ message: { content }, finish_reason: finish }],
  });

  it('sends the key only in the Authorization header and returns a validated proposal', async () => {
    const f = reply(completion(JSON.stringify(valid)));
    const out = await make(f).analyse(request);
    expect(out).toMatchObject({ priority: 'HIGH', modelVersion: 'openai:test-model' });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(String(init.body)).not.toContain(KEY);
    expect(JSON.parse(String(init.body))).toMatchObject({ max_completion_tokens: 500 });
  });

  it('classifies HTTP 429 as retryable rate_limited', async () => {
    await expect(
      make(reply({ error: { message: KEY } }, 429)).analyse(request),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    });
  });

  it('classifies 5xx as retryable unavailable and keeps provider bodies out of the message', async () => {
    const err = await make(reply({ error: { message: `bad key ${KEY}` } }, 503))
      .analyse(request)
      .catch((e: unknown) => e as ProviderError);
    expect(err).toMatchObject({ kind: 'unavailable', retryable: true });
    expect((err as ProviderError).message).not.toContain(KEY);
  });

  it('classifies other 4xx as non-secret-leaking unavailable', async () => {
    const err = (await make(reply({ error: KEY }, 401))
      .analyse(request)
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('unavailable');
    expect(err.message).not.toContain(KEY);
  });

  it('classifies a timeout', async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) =>
        init.signal?.addEventListener('abort', () => rej(init.signal?.reason)),
      )) as unknown as typeof fetch;
    expect(await kindOf(make(hang, 20).analyse(request))).toBe('timeout');
  });

  it('classifies network failure as unavailable without leaking the cause', async () => {
    const f = vi.fn(async () => {
      throw new Error(`connect failed with ${KEY}`);
    }) as unknown as typeof fetch;
    const err = (await make(f)
      .analyse(request)
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('unavailable');
    expect(err.message).not.toContain(KEY);
  });

  it.each([
    ['malformed content', completion('{oops')],
    ['truncated output', completion(JSON.stringify(valid), 'length')],
    ['no choices', {}],
    ['hallucinated team', completion(JSON.stringify({ ...valid, teamId: OTHER }))],
  ])('rejects %s without a proposal', async (_n, body) => {
    const kind = await kindOf(make(reply(body)).analyse(request));
    expect(['malformed', 'invalid_reference']).toContain(kind);
  });
});

describe('configuration and factory', () => {
  it('defaults to a disabled provider that fails without side effects', async () => {
    const env = loadEnv({});
    expect(env.ai.provider).toBe('none');
    await expect(createProvider(env).analyse(request)).rejects.toMatchObject({
      kind: 'disabled',
      retryable: false,
    });
  });

  it('selects the fake provider', async () => {
    const p = createProvider(loadEnv({ AI_PROVIDER: 'fake' }));
    expect(p.name).toBe('fake');
  });

  it('requires a key for openai and rejects unknown providers or bad numbers', () => {
    expect(() => loadEnv({ AI_PROVIDER: 'openai' })).toThrow(/AI_API_KEY/);
    expect(() => loadEnv({ AI_PROVIDER: 'skynet' })).toThrow(/AI_PROVIDER/);
    expect(() => loadEnv({ AI_TIMEOUT_MS: '0' })).toThrow(/AI_TIMEOUT_MS/);
    const env = loadEnv({ AI_PROVIDER: 'openai', AI_API_KEY: KEY, AI_MODEL: 'm' });
    expect(createProvider(env).name).toBe('openai');
  });
});
