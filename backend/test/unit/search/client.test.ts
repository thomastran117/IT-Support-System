import { describe, expect, it, vi } from 'vitest';
import { createSearchClient } from '../../../src/modules/search/client.js';

const config = { enabled: true, url: 'https://search.example.test/cluster' } as const;
const request = { query: { match_all: {} }, size: 10 };
const hits = () =>
  Response.json({ timed_out: false, hits: { hits: [{ _id: 'ticket-1', sort: [1, 'ticket-1'] }] } });

describe('OpenSearch client', () => {
  it('creates no client when disabled', () => {
    const send = vi.fn<typeof fetch>();
    expect(createSearchClient({ enabled: false }, { fetch: send })).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(0);
  });

  it('uses only the read alias and returns candidate IDs and sort values', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        timed_out: false,
        hits: {
          total: { value: 57 },
          hits: [{ _id: 'ticket-1', _source: { title: 'upstream text' }, sort: [1, 'ticket-1'] }],
        },
      }),
    );
    const client = createSearchClient(
      { ...config, auth: { username: 'reader', password: 'test-only' } },
      { fetch: send },
    )!;
    expect(
      await client.search('tickets', { ...request, sort: [{ id: 'asc' }], searchAfter: ['older'] }),
    ).toEqual([{ id: 'ticket-1', sort: [1, 'ticket-1'] }]);
    const [url, options] = send.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://search.example.test/cluster/smartdesk-tickets-read/_search?allow_partial_search_results=false',
    );
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(new Headers(options?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('reader:test-only').toString('base64')}`,
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      ...request,
      query: { bool: { must: [request.query], filter: [{ exists: { field: 'status' } }] } },
      sort: [{ id: 'asc' }],
      search_after: ['older'],
      _source: false,
      track_total_hits: false,
    });
  });

  it('retries a transient failure once', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(hits());
    const client = createSearchClient(config, { fetch: send })!;
    expect(await client.search('tickets', request)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reads the requested revision while dropping source, highlights, facets, suggestions and totals', async () => {
    const body = {
      timed_out: false,
      aggregations: { private: {} },
      suggest: { private: [] },
      hits: {
        total: { value: 20 },
        hits: [
          {
            _id: 'current',
            fields: { version: [3], body: ['private'] },
            highlight: { title: ['private'] },
            _source: { title: 'private' },
          },
          { _id: 'invalid', fields: { version: ['3'] } },
          { _id: 'missing' },
        ],
      },
    };
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
    const client = createSearchClient(config, { fetch: send })!;
    expect(await client.search('tickets', { ...request, includeRevision: true })).toEqual([
      { id: 'current', revision: 3 },
      { id: 'invalid' },
      { id: 'missing' },
    ]);
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({
      docvalue_fields: ['version'],
      _source: false,
      track_total_hits: false,
    });
    expect(await client.search('tickets', request)).toEqual([
      { id: 'current' },
      { id: 'invalid' },
      { id: 'missing' },
    ]);
  });

  it('rejects partial results when OpenSearch reports a timeout', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ timed_out: true, hits: { hits: [{ _id: 'partial' }] } }),
      );
    const client = createSearchClient(config, { fetch: send })!;
    await expect(client.search('tickets', request)).rejects.toMatchObject({ code: 'timeout' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('aborts slow requests, bounds retries, and strips upstream errors', async () => {
    const send = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('upstream credentials')));
        }),
    );
    const client = createSearchClient(config, { fetch: send, timeoutMs: 10 })!;
    await expect(client.search('tickets', request)).rejects.toMatchObject({
      code: 'timeout',
      message: 'OpenSearch timeout',
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it.each([301, 400, 401, 403, 404])('fails closed on HTTP %s without retrying', async (status) => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private content', { status }));
    const client = createSearchClient(config, { fetch: send })!;
    await expect(client.search('knowledge', request)).rejects.toMatchObject({
      code: 'http_error',
      status,
      message: `OpenSearch http_error (HTTP ${status})`,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed search responses and out-of-bounds page sizes', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ hits: [] }));
    const client = createSearchClient(config, { fetch: send })!;
    await expect(client.search('tickets', { ...request, size: 101 })).rejects.toThrow(RangeError);
    await expect(client.search('tickets', request)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('opens after three failures and permits only one recovery probe', async () => {
    let now = 0;
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 503 }));
    const client = createSearchClient(config, { fetch: send, now: () => now })!;
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(client.search('tickets', request)).rejects.toMatchObject({
        code: 'unavailable',
      });
    }
    await expect(client.search('tickets', request)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(send).toHaveBeenCalledTimes(6);

    now = 10_000;
    await expect(client.search('tickets', request)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.search('tickets', request)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(send).toHaveBeenCalledTimes(7);

    now = 20_000;
    send.mockImplementation(async () => hits());
    const probe = client.search('tickets', request);
    await expect(client.search('tickets', request)).rejects.toMatchObject({ code: 'circuit_open' });
    await expect(probe).resolves.toHaveLength(1);
    await expect(client.search('tickets', request)).resolves.toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(9);
  });
});
