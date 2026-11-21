import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@smartdesk/db';
import { addTeamMemberSchema, createTeamSchema, updateTeamSchema } from '@smartdesk/contracts';
import { z } from 'zod';
import { envelope } from '../../plugins/errors.js';
import { parse } from '../../plugins/validate.js';
import { createTeamService } from './service.js';

const TeamParams = z.object({ id: z.uuid() });
const MemberParams = z.object({ id: z.uuid(), userId: z.uuid() });

/**
 * Read-only reference data for assignment forms. Mounted under /api/teams. Staff only: employees
 * never choose a team, so they get 403.
 */
export const teamRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const service = createTeamService(prisma);
    const staff = { preHandler: app.authGuards.requireRole('TECHNICIAN', 'ADMIN') };

    app.get('/', staff, async () => envelope('Teams', await service.listActiveTeams()));

    app.get('/:id/members', staff, async (req) =>
      envelope(
        'Team members',
        await service.listAssignableMembers(parse(TeamParams, req.params).id),
      ),
    );
  };

/** Mounted under /api/categories. */
export const categoryRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const service = createTeamService(prisma);
    const staff = { preHandler: app.authGuards.requireRole('TECHNICIAN', 'ADMIN') };

    app.get('/', staff, async () => envelope('Categories', await service.listActiveCategories()));
  };

/** Administrator-only team management. Mounted under /api/admin/teams. */
export const adminTeamRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    const service = createTeamService(prisma);
    const opts = { preHandler: app.authGuards.requireRole('ADMIN') };
    const teamId = (params: unknown) => parse(TeamParams, params).id;

    app.get('/', opts, async () => envelope('Teams', await service.listTeams()));

    app.post('/', opts, async (req, reply) => {
      const team = await service.createTeam(parse(createTeamSchema, req.body));
      return reply.code(201).send(envelope('Team created', team));
    });

    app.get('/:id', opts, async (req) =>
      envelope('Team', await service.getTeam(teamId(req.params))),
    );

    app.patch('/:id', opts, async (req) =>
      envelope(
        'Team updated',
        await service.updateTeam(teamId(req.params), parse(updateTeamSchema, req.body)),
      ),
    );

    app.post('/:id/activate', opts, async (req) =>
      envelope('Team activated', await service.setTeamActive(teamId(req.params), true)),
    );
    app.post('/:id/deactivate', opts, async (req) =>
      envelope('Team deactivated', await service.setTeamActive(teamId(req.params), false)),
    );

    app.get('/:id/members', opts, async (req) =>
      envelope('Team members', await service.listMembers(teamId(req.params))),
    );

    app.post('/:id/members', opts, async (req, reply) => {
      const { userId } = parse(addTeamMemberSchema, req.body);
      const member = await service.addMember(teamId(req.params), userId);
      return reply.code(201).send(envelope('Member added', member));
    });

    app.delete('/:id/members/:userId', opts, async (req) => {
      const p = parse(MemberParams, req.params);
      await service.removeMember(p.id, p.userId);
      return envelope('Member removed');
    });
  };
