import { describe, expect, it, vi } from 'vitest';
import { createCommentSchema, createTicketSchema } from '@smartdesk/contracts';
import type { TicketTimelineEntry } from '@smartdesk/contracts';
import { ApiError, createApiClient, NetworkError } from '../../src/lib/auth/client';
import { pollIntervalMs } from '../../src/lib/config';
import { ticketsApi } from '../../src/lib/tickets/api';
import {
  describeError,
  describeEvent,
  formatDateTime,
  shortId,
} from '../../src/lib/tickets/format';
import {
  LIMITS,
  clearDraft,
  createSubmissionKeys,
  loadDraft,
  saveDraft,
  validateReply,
  validateTicket,
} from '../../src/lib/tickets/validation';

const ok = { title: 'Printer jams', description: 'Tray 2 jams.' };

describe('validateTicket uses the API schema', () => {
  it('accepts what the API accepts', () => {
    expect(validateTicket(ok)).toEqual({});
    expect(validateTicket({ title: 'x'.repeat(150), description: 'y'.repeat(5000) })).toEqual({});
    // Trimmed first, exactly like the server.
    expect(validateTicket({ title: '  a  ', description: '  b  ' })).toEqual({});
  });

  it('asks for blank fields, one message per field', () => {
    expect(validateTicket({ title: '', description: '' })).toEqual({
      title: 'Enter a title.',
      description: 'Enter a description.',
    });
    expect(validateTicket({ title: '   ', description: ' \n\t ' })).toEqual({
      title: 'Enter a title.',
      description: 'Enter a description.',
    });
  });

  it('states the limit when a field is too long', () => {
    expect(validateTicket({ title: 'x'.repeat(151), description: 'ok' })).toEqual({
      title: 'Title must be 150 characters or fewer.',
    });
    expect(validateTicket({ title: 'ok', description: 'y'.repeat(5001) })).toEqual({
      description: 'Description must be 5,000 characters or fewer.',
    });
  });

  it('never disagrees with the schema the server runs', () => {
    const cases = [
      ok,
      { title: '', description: 'd' },
      { title: 'x'.repeat(150), description: 'd' },
      { title: 'x'.repeat(151), description: 'd' },
      { title: ' ', description: 'd' },
      { title: 't', description: 'y'.repeat(5000) },
      { title: 't', description: 'y'.repeat(5001) },
      { title: ' t ', description: ' ' },
    ];
    for (const c of cases) {
      expect(Object.keys(validateTicket(c)).length === 0).toBe(
        createTicketSchema.safeParse(c).success,
      );
    }
    expect(LIMITS).toEqual({ title: 150, description: 5000, reply: 5000 });
  });

  it('is strict about unknown fields in the shared schema, so privileged data cannot ride along', () => {
    for (const extra of [{ role: 'ADMIN' }, { requesterId: 'x' }, { status: 'CLOSED' }]) {
      expect(createTicketSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
    }
    expect(createCommentSchema.safeParse({ body: 'hi', authorId: 'x' }).success).toBe(false);
  });
});

describe('validateReply', () => {
  it('accepts a normal reply and rejects blank and oversized ones', () => {
    expect(validateReply('Thanks')).toBeNull();
    expect(validateReply('x'.repeat(5000))).toBeNull();
    expect(validateReply('')).toBe('Enter a reply.');
    expect(validateReply('  \n ')).toBe('Enter a reply.');
    expect(validateReply('x'.repeat(5001))).toBe('Reply must be 5,000 characters or fewer.');
  });
});

describe('submission keys', () => {
  it('reuses one key while the content is unchanged, so a retry cannot duplicate', () => {
    let n = 0;
    const keys = createSubmissionKeys(() => `key-${++n}`);
    const a = keys.keyFor(ok);
    expect(keys.keyFor(ok)).toBe(a);
    expect(keys.keyFor({ title: ` ${ok.title} `, description: ok.description })).toBe(a);
  });

  it('issues a new key for different content and after a successful submission', () => {
    let n = 0;
    const keys = createSubmissionKeys(() => `key-${++n}`);
    const a = keys.keyFor(ok);
    expect(keys.keyFor({ ...ok, title: 'Something else' })).not.toBe(a);
    const b = keys.keyFor(ok);
    keys.reset();
    expect(keys.keyFor(ok)).not.toBe(b);
  });

  it('produces header-valid keys by default (8-100 printable characters)', () => {
    const key = createSubmissionKeys().keyFor(ok);
    expect(key).toMatch(/^[\x21-\x7e]{8,100}$/);
  });
});

describe('drafts', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      data,
    };
  };

  it('round-trips per user and clears', () => {
    const s = memory();
    saveDraft('u1', ok, s);
    expect(loadDraft('u1', s)).toEqual(ok);
    expect(loadDraft('u2', s)).toEqual({ title: '', description: '' });
    clearDraft('u1', s);
    expect(loadDraft('u1', s)).toEqual({ title: '', description: '' });
  });

  it('stores nothing for an empty form', () => {
    const s = memory();
    saveDraft('u1', { title: '', description: '' }, s);
    expect(s.data.size).toBe(0);
  });

  it('tolerates missing, broken or throwing storage', () => {
    expect(loadDraft('u1', null)).toEqual({ title: '', description: '' });
    expect(loadDraft('u1', { getItem: () => '{not json' })).toEqual({ title: '', description: '' });
    expect(loadDraft('u1', { getItem: () => '{"title":42}' })).toEqual({
      title: '',
      description: '',
    });
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDraft('u1', throwing)).toEqual({ title: '', description: '' });
    expect(() => saveDraft('u1', ok, throwing)).not.toThrow();
    expect(() => clearDraft('u1', throwing)).not.toThrow();
  });
});

describe('formatting', () => {
  const entry = (type: TicketTimelineEntry['type'], details: TicketTimelineEntry['details']) =>
    ({
      id: '1',
      type,
      occurredAt: '2026-01-01T00:00:00Z',
      actor: null,
      details,
    }) as TicketTimelineEntry;

  it('describes the events a requester can see in plain language', () => {
    expect(describeEvent(entry('CREATED', null))).toBe('Ticket submitted');
    expect(describeEvent(entry('STATUS_CHANGED', { from: 'OPEN', to: 'IN_PROGRESS' }))).toBe(
      'Status changed from Open to In progress',
    );
    expect(describeEvent(entry('PRIORITY_UPDATED', { from: 'UNSET', to: 'HIGH' }))).toBe(
      'Priority set to High',
    );
    expect(describeEvent(entry('RESOLVED', null))).toBe('Marked as resolved');
    expect(describeEvent(entry('REOPENED', null))).toBe('Reopened');
    expect(describeEvent(entry('TEAM_ASSIGNED', null))).toBe('Assigned to a support team');
    expect(describeEvent(entry('STATUS_CHANGED', null))).toBe('Status changed');
  });

  it('never throws on an unexpected event or value', () => {
    expect(describeEvent(entry('AI_REVIEWED', null))).toBe('Ticket updated');
    expect(describeEvent(entry('STATUS_CHANGED', { from: 'WEIRD', to: 'OPEN' }))).toContain(
      'Unknown',
    );
  });

  it('formats dates and short ids', () => {
    expect(formatDateTime('2026-03-02T14:30:00Z')).toMatch(/2026/);
    expect(formatDateTime('not a date')).toBe('');
    expect(shortId('0abc1234-0000-4000-8000-000000000001')).toBe('0ABC1234');
  });

  it('maps failures to safe messages that never echo server text', () => {
    expect(describeError(new NetworkError(), 'ticket')).toContain('Unable to reach the server');
    expect(describeError(new ApiError(404, 'SQL exploded', null), 'ticket')).toBe(
      'This ticket could not be found.',
    );
    expect(describeError(new ApiError(400, 'secret detail', { x: 1 }), 'ticket')).not.toContain(
      'secret',
    );
    expect(describeError(new ApiError(429, 'x', null), 'ticket')).toContain('Too many requests');
    expect(describeError(new ApiError(500, 'stack trace here', null), 'ticket')).not.toContain(
      'stack',
    );
    expect(describeError(new Error('boom'), 'ticket')).toContain('Something went wrong');
  });
});

describe('ticketsApi', () => {
  const user = { id: 'u1', email: 'a@x.test', displayName: 'A', role: 'EMPLOYEE' as const };
  const envelope = (status: number, data: unknown) =>
    new Response(JSON.stringify({ message: 'm', error: null, details: null, data }), { status });

  function setup(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/api/auth/login')) {
        return envelope(200, { accessToken: 'tok', expiresIn: 900, user });
      }
      calls.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch;
    const client = createApiClient({ url: (p) => `http://api.test${p}`, fetchImpl });
    return { client, calls };
  }

  it('creates a ticket with the idempotency key header and only the allowed fields', async () => {
    const { client, calls } = setup(() => envelope(201, { id: 't1' }));
    await client.login('a@x.test', 'pw');
    const created = await ticketsApi(client).create(ok, 'key-12345678');
    expect(created).toEqual({ id: 't1' });
    const call = calls[0]!;
    expect(call.url).toBe('http://api.test/api/tickets');
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('idempotency-key')).toBe('key-12345678');
    expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(call.init.body as string)).toEqual(ok);
  });

  it('builds list queries, omitting empty filters and a zero offset', async () => {
    const { client, calls } = setup(() => envelope(200, { items: [] }));
    await client.login('a@x.test', 'pw');
    const api = ticketsApi(client);
    await api.list();
    await api.list({ status: 'OPEN', priority: 'HIGH', limit: 10, offset: 20 });
    await api.list({ limit: 10, offset: 0 });
    expect(calls.map((c) => c.url)).toEqual([
      'http://api.test/api/tickets',
      'http://api.test/api/tickets?status=OPEN&priority=HIGH&limit=10&offset=20',
      'http://api.test/api/tickets?limit=10',
    ]);
  });

  it('encodes ids and never sends isInternal when replying', async () => {
    const { client, calls } = setup(() => envelope(200, {}));
    await client.login('a@x.test', 'pw');
    const api = ticketsApi(client);
    await api.get('a/b?c');
    await api.reply('t1', 'hello');
    expect(calls[0]!.url).toBe('http://api.test/api/tickets/a%2Fb%3Fc');
    expect(calls[1]!.url).toBe('http://api.test/api/tickets/t1/comments');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ body: 'hello' });
  });

  it('surfaces a 404 as an ApiError', async () => {
    const { client } = setup(() => envelope(404, null));
    await client.login('a@x.test', 'pw');
    await expect(ticketsApi(client).get('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('pollIntervalMs', () => {
  it('uses a valid setting and falls back otherwise', () => {
    expect(pollIntervalMs('1000')).toBe(1000);
    expect(pollIntervalMs('30000')).toBe(30000);
    for (const bad of [undefined, '', 'abc', '999', '0', '-5', '1500.5']) {
      expect(pollIntervalMs(bad)).toBe(15000);
    }
  });
});
