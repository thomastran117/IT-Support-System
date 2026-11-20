import { describe, expect, it } from 'vitest';
import { hashPassword, verifyDummy, verifyPassword } from '../../../src/auth/password.js';

describe('password hashing', () => {
  it('produces a salted Argon2id PHC string that is not the plaintext', async () => {
    const [a, b] = await Promise.all([
      hashPassword('correct horse'),
      hashPassword('correct horse'),
    ]);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toContain('correct horse');
    expect(a).not.toBe(b); // random salt per hash
  });

  it('verifies the right password and rejects wrong ones', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword(h, 'correct horse')).toBe(true);
    expect(await verifyPassword(h, 'Correct horse')).toBe(false);
    expect(await verifyPassword(h, '')).toBe(false);
  });

  it('treats malformed hashes as a mismatch instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await verifyPassword('', 'x')).toBe(false);
  });

  it('verifyDummy always fails', async () => {
    expect(await verifyDummy('anything')).toBe(false);
  });
});
