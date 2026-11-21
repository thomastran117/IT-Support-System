import { describe, expect, it } from 'vitest';
import { buildRetrievalQuery } from '../../../src/modules/ai/analysisService.js';
import { buildUserMessage } from '../../../src/modules/ai/prompt.js';
import { redactText } from '../../../src/modules/ai/redact.js';

describe('redactText', () => {
  it.each([
    ['email', 'contact erin.k@example.com now', 'erin.k@example.com'],
    ['bearer token', 'Authorization: Bearer abcdef1234567890xyz', 'abcdef1234567890xyz'],
    ['jwt', 'token eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4', 'eyJzdWIiOiIx'],
    ['api key', 'key sk-proj-abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['password assignment', 'my password is Hunter2Hunter2', 'Hunter2Hunter2'],
    ['quoted password', 'password: "correct horse battery"', 'correct horse battery'],
    ['url credentials', 'git clone https://bob:s3cret@host.example/repo', 's3cret'],
    ['card number', 'card 4111 1111 1111 1111 declined', '4111 1111 1111 1111'],
    ['ssn', 'ssn 123-45-6789', '123-45-6789'],
    ['hex secret', 'hash 0123456789abcdef0123456789abcdef0123', '0123456789abcdef0123456789abcdef'],
    [
      'private key',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
      'MIIabc',
    ],
  ])('removes %s', (_n, input, secret) => {
    const out = redactText(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('REDACTED');
  });

  it('keeps ordinary troubleshooting text intact', () => {
    const t = 'Print jobs stay queued on floor 3 and the printer shows a paper jam error.';
    expect(redactText(t)).toBe(t);
  });

  it('strips control characters', () => {
    expect(redactText('a\u0000b\u0007c\nd')).toBe('abc\nd');
  });
});

describe('buildRetrievalQuery', () => {
  it('uses distinctive words, drops stop words and redaction markers, and caps terms', () => {
    const q = buildRetrievalQuery(
      'VPN keeps disconnecting',
      'please help the vpn drops [REDACTED_EMAIL] every hour with certificate errors again again',
    );
    expect(q.split(' or ')[0]).toBe('vpn');
    expect(q).toContain('vpn');
    expect(q).not.toContain('please');
    expect(q).not.toMatch(/redacted/);
    expect(q.split(' or ').length).toBeLessThanOrEqual(12);
    expect(new Set(q.split(' or ')).size).toBe(q.split(' or ').length);
  });

  it('is empty when there is nothing searchable', () => {
    expect(buildRetrievalQuery('??', '!!')).toBe('');
  });
});

describe('buildUserMessage', () => {
  const req = {
    ticket: { title: 't', description: 'd'.repeat(500) },
    allowedCategories: [{ id: 'c', name: 'C' }],
    allowedTeams: [{ id: 't', name: 'T' }],
    articles: [
      { id: 'a1', title: 'one', body: 'x'.repeat(300) },
      { id: 'a2', title: 'two', body: 'y'.repeat(300) },
    ],
  };

  it('stays valid JSON and within the limit, dropping trailing articles first', () => {
    const msg = buildUserMessage(req, 1100);
    expect(msg.length).toBeLessThanOrEqual(1100);
    const parsed = JSON.parse(msg);
    expect(parsed.articles.map((a: { id: string }) => a.id)).toEqual(['a1']);
    expect(parsed.ticket.description).toHaveLength(500);
  });

  it('trims the description when articles alone do not fit', () => {
    const msg = buildUserMessage(req, 400);
    expect(msg.length).toBeLessThanOrEqual(400);
    expect(JSON.parse(msg).articles).toEqual([]);
  });
});
