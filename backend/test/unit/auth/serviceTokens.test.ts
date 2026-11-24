import { describe, expect, it } from 'vitest';
import { createServiceTokenVerifier, loadServiceKeys } from '../../../src/auth/serviceTokens.js';
import {
  createServiceFixture,
  delegatedActor,
  systemScope,
  ticketAudience,
  workScope,
} from '../../fixtures/serviceCredentials.js';

describe('service credentials', () => {
  it('verifies an audience, a service and one explicitly granted scope and actor', async () => {
    const caller = await createServiceFixture();
    const verify = await createServiceTokenVerifier(ticketAudience, [caller.config]);
    expect(await verify(await caller.sign(), systemScope, 'system')).toEqual({
      result: 'authorized',
      service: caller.config.service,
      actor: { kind: 'system' },
    });
    const actor = delegatedActor('bound-access-token');
    const delegated = await caller.sign({ scope: workScope, actor });
    expect(await verify(delegated, workScope, 'user')).toEqual({
      result: 'authorized',
      service: caller.config.service,
      actor,
    });
    expect(await verify(delegated, systemScope, 'system')).toEqual({ result: 'forbidden' });
    expect(await verify(await caller.sign({ scope: workScope }), workScope, 'system')).toEqual({
      result: 'forbidden',
    });
    const ungrantedScope = 'ticket:write';
    expect(
      await verify(await caller.sign({ scope: ungrantedScope }), ungrantedScope, 'system'),
    ).toEqual({ result: 'forbidden' });
  });

  it('rejects foreign audiences, caller substitution, wrong JWT types and invalid lifetimes', async () => {
    const caller = await createServiceFixture();
    const verify = await createServiceTokenVerifier(ticketAudience, [caller.config]);
    const now = Math.floor(Date.now() / 1000);
    const other = await createServiceFixture('untrusted-test');
    const invalid = [
      caller.sign({ aud: 'smartdesk-ai' }),
      caller.sign({ aud: [ticketAudience, 'smartdesk-ai'] }),
      caller.sign({ sub: 'different-caller' }),
      caller.sign({ iss: 'smartdesk-api' }),
      caller.sign({ iat: now - 20, exp: now - 1 }),
      caller.sign({ iat: now + 30, exp: now + 40 }),
      caller.sign({ iat: now, exp: now + 61 }),
      caller.sign({ iat: now + 1, exp: now }),
      caller.sign({ actor: { kind: 'user' } }),
      caller.sign({}, { kid: caller.config.kid, typ: 'JWT' }),
      other.sign(),
      other.sign(
        { sub: caller.config.service },
        { kid: caller.config.kid, typ: 'smartdesk-service+jwt' },
      ),
    ];
    for (const token of await Promise.all(invalid)) {
      expect(await verify(token, systemScope, 'system')).toEqual({ result: 'unauthenticated' });
    }
  });

  it('supports overlapping key rotation and removes trust in a retired key', async () => {
    const old = await createServiceFixture('caller-old');
    const next = await createServiceFixture('caller-next');
    const overlapping = await createServiceTokenVerifier(ticketAudience, [old.config, next.config]);
    const replacement = await createServiceTokenVerifier(ticketAudience, [next.config]);
    const oldToken = await old.sign();
    const newToken = await next.sign();
    expect((await overlapping(oldToken, systemScope, 'system')).result).toBe('authorized');
    expect((await overlapping(newToken, systemScope, 'system')).result).toBe('authorized');
    expect((await replacement(oldToken, systemScope, 'system')).result).toBe('unauthenticated');
    expect((await replacement(newToken, systemScope, 'system')).result).toBe('authorized');
  });

  it('rejects malformed registries, duplicate keys, and invalid public key material', async () => {
    expect(loadServiceKeys(undefined)).toEqual([]);
    expect(loadServiceKeys('[]')).toEqual([]);
    expect(() => loadServiceKeys('broken-json')).toThrow(/INTERNAL_SERVICE_KEYS/);
    const caller = await createServiceFixture();
    const other = await createServiceFixture();
    expect(() => loadServiceKeys(JSON.stringify([caller.config, other.config]))).toThrow(
      /unique IDs and keys/,
    );
    expect(() =>
      loadServiceKeys(JSON.stringify([caller.config, { ...caller.config, kid: 'copied' }])),
    ).toThrow(/unique IDs and keys/);
    expect(() =>
      loadServiceKeys(JSON.stringify([{ ...caller.config, grants: { [workScope]: 'admin' } }])),
    ).toThrow(/INTERNAL_SERVICE_KEYS/);
    const badKeys = loadServiceKeys(
      JSON.stringify([{ ...caller.config, publicKey: '-----BEGIN PUBLIC KEY-----\ninvalid' }]),
    );
    await expect(createServiceTokenVerifier(ticketAudience, badKeys)).rejects.toThrow(
      /valid P-256 public keys/,
    );
  });
});
