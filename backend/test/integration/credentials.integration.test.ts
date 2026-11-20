import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/auth/password.js';
import { DEMO_PASSWORD, USERS } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';
import {
  createTestPrisma,
  expectViolation,
  insertRow,
  resetDatabase,
  testDatabaseUrl,
} from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('account credentials (integration)', () => {
  const prisma = createTestPrisma();
  const seed = () => seedDatabase(prisma, { profile: 'test', databaseUrl: testDatabaseUrl! });

  beforeEach(() => resetDatabase(prisma));
  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('a new user has no credential and token_version 0', async () => {
    const row = await insertRow(prisma, 'users', {
      email: 'new@smartdesk.test',
      display_name: 'New User',
      role: 'EMPLOYEE',
    });
    expect(row.password_hash).toBeNull();
    expect(row.token_version).toBe(0);
  });

  it('rejects anything that is not an Argon2id hash (no plaintext or weaker hashes)', async () => {
    const base = { display_name: 'X', role: 'EMPLOYEE' };
    await expectViolation(
      insertRow(prisma, 'users', { ...base, email: 'a@x.test', password_hash: 'hunter2' }),
      'ck_users_password_hash_argon2id',
    );
    await expectViolation(
      insertRow(prisma, 'users', { ...base, email: 'b@x.test', password_hash: '$2b$10$abcdef' }),
      'ck_users_password_hash_argon2id',
    );
  });

  it('rejects a negative token_version', async () => {
    await expectViolation(
      insertRow(prisma, 'users', {
        email: 'c@x.test',
        display_name: 'X',
        role: 'EMPLOYEE',
        token_version: -1,
      }),
      'ck_users_token_version_nonnegative',
    );
  });

  it('seeds an Argon2id credential for every demo account, and never the plaintext', async () => {
    await seed();
    const rows = await prisma.user.findMany({ orderBy: { email: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => r.role))).toEqual(new Set(['EMPLOYEE', 'TECHNICIAN', 'ADMIN']));
    for (const r of rows) {
      expect(r.passwordHash).toMatch(/^\$argon2id\$/);
      expect(r.passwordHash).not.toContain(DEMO_PASSWORD);
      expect(r.tokenVersion).toBe(0);
    }
    // Every account gets its own salt.
    expect(new Set(rows.map((r) => r.passwordHash)).size).toBe(rows.length);
  });

  it('seeded hashes verify against the documented demo password', async () => {
    await seed();
    for (const id of [USERS.admin, USERS.erin, USERS.tara]) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(await verifyPassword(u.passwordHash!, DEMO_PASSWORD)).toBe(true);
      expect(await verifyPassword(u.passwordHash!, 'wrong')).toBe(false);
    }
  });

  it('re-seeding keeps existing credentials but fills missing ones', async () => {
    await seed();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: USERS.erin } });
    await prisma.user.update({ where: { id: USERS.omar }, data: { passwordHash: null } });
    await seed();
    const erin = await prisma.user.findUniqueOrThrow({ where: { id: USERS.erin } });
    const omar = await prisma.user.findUniqueOrThrow({ where: { id: USERS.omar } });
    expect(erin.passwordHash).toBe(before.passwordHash);
    expect(omar.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('bumping token_version is how all of a user’s tokens are invalidated', async () => {
    await seed();
    const u = await prisma.user.update({
      where: { id: USERS.erin },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(u.tokenVersion).toBe(1);
  });
});
