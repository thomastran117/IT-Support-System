import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient, type TransactionClient } from '@smartdesk/db';
import type { AdminAuditAction, AdminAuditEntry, AdminUser, Role } from '@smartdesk/contracts';
import { hashPassword } from './password.js';
import { DbError, lifecycleError, notFoundError, withTransaction } from '@smartdesk/db/errors';

/** The only user fields that ever leave the service: no password hash, no token_version. */
const PUBLIC = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

type PublicRow = Prisma.UserGetPayload<{ select: typeof PUBLIC }>;

export const toAdminUser = (u: PublicRow): AdminUser => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role as Role,
  isActive: u.isActive,
  createdAt: u.createdAt.toISOString(),
});

/** 20 random URL-safe characters (about 120 bits). Shown once, stored only as an Argon2id hash. */
export const generateTemporaryPassword = (): string => randomBytes(15).toString('base64url');

const audit = (
  tx: TransactionClient,
  actorId: string,
  targetUserId: string,
  action: AdminAuditAction,
  details: Record<string, unknown> = {},
) =>
  tx.adminAuditLog.create({
    data: { actorId, targetUserId, action, details: details as Prisma.InputJsonObject },
  });

/**
 * Serialise every change that could remove an administrator: lock all active admin rows (in a
 * fixed order, so two requests cannot deadlock). The second of two concurrent demotions then
 * sees the first one's committed result and is refused if it would leave no administrator.
 */
async function lockActiveAdmins(tx: TransactionClient): Promise<string[]> {
  const rows = await tx.$queryRaw<{ user_id: string }[]>(
    Prisma.sql`SELECT user_id FROM users WHERE role = 'ADMIN' AND is_active ORDER BY user_id FOR UPDATE`,
  );
  return rows.map((r) => r.user_id);
}

async function loadTarget(tx: TransactionClient, id: string) {
  const user = await tx.user.findUnique({ where: { id }, select: PUBLIC });
  if (!user) throw notFoundError('User');
  return user;
}

const lastAdmin = () =>
  lifecycleError('This is the last active administrator. Another administrator must remain.');
const selfAction = (what: string) =>
  new DbError('FORBIDDEN', 403, `You cannot ${what} your own account.`);

export interface ListFilter {
  role?: Role;
  active?: boolean;
  q?: string;
  limit: number;
  offset: number;
}

export function createUserService(prisma: PrismaClient) {
  return {
    async list(filter: ListFilter) {
      const where: Prisma.UserWhereInput = {
        ...(filter.role ? { role: filter.role } : {}),
        ...(filter.active === undefined ? {} : { isActive: filter.active }),
        ...(filter.q
          ? {
              OR: [
                { email: { contains: filter.q.toLowerCase() } },
                { displayName: { contains: filter.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        prisma.user.findMany({
          where,
          select: PUBLIC,
          orderBy: [{ email: 'asc' }],
          take: filter.limit,
          skip: filter.offset,
        }),
        prisma.user.count({ where }),
      ]);
      return { items: items.map(toAdminUser), total };
    },

    async create(actorId: string, input: { email: string; displayName: string; role: Role }) {
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      const user = await withTransaction(prisma, async (tx) => {
        // Emails are stored lowercase (CHECK) and unique, so this is a case-insensitive check.
        const clash = await tx.user.findUnique({
          where: { email: input.email },
          select: { id: true },
        });
        if (clash) throw new DbError('CONFLICT', 409, 'A user with this email already exists.');
        const created = await tx.user.create({
          data: { ...input, passwordHash },
          select: PUBLIC,
        });
        await audit(tx, actorId, created.id, 'USER_CREATED', { role: input.role });
        return created;
      });
      return { user: toAdminUser(user), temporaryPassword };
    },

    async setRole(actorId: string, targetId: string, role: Role) {
      if (actorId === targetId) throw selfAction('change the role of');
      return withTransaction(prisma, async (tx) => {
        const admins = await lockActiveAdmins(tx);
        const target = await loadTarget(tx, targetId);
        if (target.role === role) return toAdminUser(target);
        const demotingActiveAdmin = target.role === 'ADMIN' && target.isActive;
        if (demotingActiveAdmin && admins.filter((id) => id !== targetId).length === 0) {
          throw lastAdmin();
        }
        const updated = await tx.user.update({
          where: { id: targetId },
          // Bumping token_version signs the user out everywhere, so no token outlives the old role.
          data: { role, tokenVersion: { increment: 1 } },
          select: PUBLIC,
        });
        await audit(tx, actorId, targetId, 'ROLE_CHANGED', { from: target.role, to: role });
        return toAdminUser(updated);
      });
    },

    async setActive(actorId: string, targetId: string, active: boolean) {
      if (!active && actorId === targetId) throw selfAction('deactivate');
      return withTransaction(prisma, async (tx) => {
        const admins = await lockActiveAdmins(tx);
        const target = await loadTarget(tx, targetId);
        if (target.isActive === active) return toAdminUser(target);
        if (
          !active &&
          target.role === 'ADMIN' &&
          admins.filter((id) => id !== targetId).length === 0
        ) {
          throw lastAdmin();
        }
        const updated = await tx.user.update({
          where: { id: targetId },
          data: { isActive: active, tokenVersion: { increment: 1 } },
          select: PUBLIC,
        });
        await audit(tx, actorId, targetId, active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED');
        return toAdminUser(updated);
      });
    },

    /** Rotation: replaces the credential with a new one-time password and revokes all tokens. */
    async resetPassword(actorId: string, targetId: string) {
      if (actorId === targetId) throw selfAction('reset the password of');
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      const user = await withTransaction(prisma, async (tx) => {
        await loadTarget(tx, targetId);
        const updated = await tx.user.update({
          where: { id: targetId },
          data: { passwordHash, tokenVersion: { increment: 1 } },
          select: PUBLIC,
        });
        await audit(tx, actorId, targetId, 'PASSWORD_RESET');
        return updated;
      });
      return { user: toAdminUser(user), temporaryPassword };
    },

    async auditLog(limit: number): Promise<AdminAuditEntry[]> {
      const rows = await prisma.adminAuditLog.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: {
          actor: { select: { id: true, email: true } },
          target: { select: { id: true, email: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        action: r.action as AdminAuditAction,
        actor: r.actor,
        target: r.target,
        details: r.details as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
