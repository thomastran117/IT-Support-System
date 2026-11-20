import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import { z } from 'zod';
import { HttpError, envelope } from '../../plugins/errors.js';
import { createUserService } from './userService.js';

const RoleSchema = z.enum(['EMPLOYEE', 'TECHNICIAN', 'ADMIN']);

const CreateBody = z.strictObject({
  email: z
    .string()
    .trim()
    .max(255)
    .pipe(z.email())
    .transform((e) => e.toLowerCase()),
  displayName: z.string().trim().min(1).max(120),
  role: RoleSchema,
});
const RoleBody = z.strictObject({ role: RoleSchema });
const IdParams = z.object({ id: z.uuid() });
const ListQuery = z.object({
  role: RoleSchema.optional(),
  active: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'Validation failed', z.flattenError(result.error).fieldErrors);
  }
  return result.data;
}

const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

/** Administrator-only account management. Mounted under /api/admin. */
export const adminRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const service = createUserService(prisma);
    // Every route here is ADMIN-only (403 for anyone else, 401 when anonymous).
    const opts = { preHandler: app.authGuards.requireRole('ADMIN') };
    const actor = (req: { principal?: { id: string } }) => req.principal!.id;
    const targetId = (params: unknown) => parse(IdParams, params).id;

    app.get('/users', opts, async (req) => {
      const q = parse(ListQuery, req.query);
      return envelope(
        'Users',
        await service.list({
          role: q.role,
          active: q.active === undefined ? undefined : q.active === 'true',
          q: q.q || undefined,
          limit: q.limit,
          offset: q.offset,
        }),
      );
    });

    app.post('/users', opts, async (req, reply) => {
      const result = await service.create(actor(req), parse(CreateBody, req.body));
      noStore(reply);
      return reply.code(201).send(envelope('User created', result));
    });

    app.patch('/users/:id/role', opts, async (req) => {
      const { role } = parse(RoleBody, req.body);
      return envelope(
        'Role updated',
        await service.setRole(actor(req), targetId(req.params), role),
      );
    });

    app.post('/users/:id/deactivate', opts, async (req) =>
      envelope(
        'User deactivated',
        await service.setActive(actor(req), targetId(req.params), false),
      ),
    );
    app.post('/users/:id/activate', opts, async (req) =>
      envelope('User activated', await service.setActive(actor(req), targetId(req.params), true)),
    );

    app.post('/users/:id/reset-password', opts, async (req, reply) => {
      const result = await service.resetPassword(actor(req), targetId(req.params));
      noStore(reply);
      return envelope('Password reset', result);
    });

    app.get('/audit-log', opts, async (req) =>
      envelope('Audit log', await service.auditLog(parse(AuditQuery, req.query).limit)),
    );
  };
