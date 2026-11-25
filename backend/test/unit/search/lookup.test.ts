import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nonBlockingLookup } from '@smartdesk/service-runtime';
import { describe, expect, it } from 'vitest';
import { createSearchTransport } from '../../../src/modules/search/transport.js';

/**
 * SD-058 risk R6: a stopped dependency's name must not occupy the libuv threadpool. The isolated
 * gate reproduces the outage itself; these tests pin the resolver contract and that the search
 * transport's default fetch really connects through it.
 */
const lookup = (host: string, options: object) =>
  new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }>(
    (resolve) =>
      nonBlockingLookup(host, options, (error, address, family) =>
        resolve({ error, address, family }),
      ),
  );

describe('nonBlockingLookup', () => {
  it('passes literal addresses and localhost to the system resolver', async () => {
    expect(await lookup('127.0.0.1', {})).toMatchObject({
      error: null,
      address: '127.0.0.1',
      family: 4,
    });
    const all = await lookup('localhost', { all: true });
    expect(all.error).toBeNull();
    expect(Array.isArray(all.address)).toBe(true);
  });

  it('accepts the legacy family-number and callback-only signatures', async () => {
    await new Promise<void>((resolve) =>
      nonBlockingLookup('127.0.0.1', 4, (error, address) => {
        expect(error).toBeNull();
        expect(address).toBe('127.0.0.1');
        resolve();
      }),
    );
    await new Promise<void>((resolve) =>
      nonBlockingLookup('127.0.0.1', (error, address) => {
        expect(error).toBeNull();
        expect(address).toBe('127.0.0.1');
        resolve();
      }),
    );
  });
});

describe('search transport default fetch', () => {
  it('connects through the non-blocking dispatcher', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address() as AddressInfo;
      const request = createSearchTransport({
        enabled: true,
        url: `http://127.0.0.1:${port}/`,
      } as Parameters<typeof createSearchTransport>[0]);
      const body = await request({
        path: 'tickets/_search',
        method: 'POST',
        body: { size: 1 },
        retry: false,
        decode: (value) => value,
      });
      expect(body).toEqual({ path: '/tickets/_search', method: 'POST' });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
