import { argon2id, hash, verify } from 'argon2';

/**
 * Argon2id parameters (OWASP "minimum" profile: 19 MiB, 2 iterations, 1 lane). The salt is random
 * per hash and the parameters are embedded in the PHC string, so they can be raised later and old
 * hashes keep verifying.
 */
export const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** True/false only; a malformed or foreign hash is treated as a mismatch, never thrown. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verify against a throwaway hash so a login for an unknown or credential-less account costs the
 * same as a real one (used by SD-014 to avoid account enumeration through timing).
 */
export async function verifyDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('not-a-real-password');
  await verifyPassword(await dummyHash, password);
  return false;
}
