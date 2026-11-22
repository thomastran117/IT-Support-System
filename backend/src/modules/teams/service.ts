import type { PrismaClient } from '@smartdesk/db';
import type {
  AdminTeamDto,
  AdminTeamMemberDto,
  CategoryRefDto,
  TeamMemberRefDto,
  TeamRefDto,
} from '@smartdesk/contracts';
import { DbError, notFoundError } from '../../db/errors.js';
import * as teamMembers from '../../db/repositories/teamMembers.js';
import { withTransaction } from '../../db/transaction.js';

const conflict = (message: string, details: unknown = null) =>
  new DbError('CONFLICT', 409, message, details);

const toRef = (t: { id: string; name: string; description: string | null }): TeamRefDto => ({
  id: t.id,
  name: t.name,
  description: t.description,
});

/**
 * Support-team reference data and administration.
 *
 * Rules (see docs/api.md):
 *  - Only an active TECHNICIAN account can be a member, and only of an active team.
 *  - Teams are deactivated, never deleted, so historical tickets keep their team.
 *  - A member cannot be removed while any ticket is assigned to them within the team: the
 *    ticket's (team, assignee) pair is a foreign key to the membership. Reassign the tickets first.
 *  - A technician may belong to several teams and works the union of their queues.
 */
export function createTeamService(prisma: PrismaClient) {
  const loadTeam = async (db: Parameters<typeof teamMembers.findTeam>[0], id: string) => {
    const team = await teamMembers.findTeam(db, id);
    if (!team) throw notFoundError('Team');
    return team;
  };

  const toAdminTeam = (
    t: { id: string; name: string; description: string | null; isActive: boolean },
    memberCount: number,
    ticketCount: number,
  ): AdminTeamDto => ({ ...toRef(t), isActive: t.isActive, memberCount, ticketCount });

  const ticketCounts = async (): Promise<Map<string | null, number>> => {
    const rows = await prisma.ticket.groupBy({
      by: ['assignedTeamId'],
      where: { assignedTeamId: { not: null } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.assignedTeamId, r._count._all]));
  };

  return {
    // --- Read-only reference data for staff assignment forms ---------------------------------

    async listActiveTeams(): Promise<TeamRefDto[]> {
      const teams = await prisma.supportTeam.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      });
      return teams.map(toRef);
    },

    async listActiveCategories(): Promise<CategoryRefDto[]> {
      const categories = await prisma.ticketCategory.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      });
      return categories.map((c) => ({ id: c.id, name: c.name, description: c.description }));
    },

    /** Active technicians of an active team: the only people a ticket can be assigned to. */
    async listAssignableMembers(teamId: string): Promise<TeamMemberRefDto[]> {
      const team = await teamMembers.findTeam(prisma, teamId);
      // An inactive team is indistinguishable from an unknown one to a technician.
      if (!team?.isActive) throw notFoundError('Team');
      const rows = await prisma.teamMember.findMany({
        where: { teamId, user: { isActive: true, role: 'TECHNICIAN' } },
        select: { user: { select: { id: true, displayName: true } } },
        orderBy: { user: { displayName: 'asc' } },
      });
      return rows.map((r) => ({ id: r.user.id, displayName: r.user.displayName }));
    },

    // --- Administration -----------------------------------------------------------------------

    async listTeams(): Promise<AdminTeamDto[]> {
      const teams = await prisma.supportTeam.findMany({
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        include: { _count: { select: { members: true } } },
      });
      const counts = await ticketCounts();
      return teams.map((t) => toAdminTeam(t, t._count.members, counts.get(t.id) ?? 0));
    },

    async getTeam(id: string): Promise<AdminTeamDto> {
      const team = await prisma.supportTeam.findUnique({
        where: { id },
        include: { _count: { select: { members: true } } },
      });
      if (!team) throw notFoundError('Team');
      const tickets = await prisma.ticket.count({ where: { assignedTeamId: id } });
      return toAdminTeam(team, team._count.members, tickets);
    },

    async createTeam(input: { name: string; description?: string | null }): Promise<AdminTeamDto> {
      const team = await withTransaction(prisma, async (tx) => {
        if (await tx.supportTeam.findUnique({ where: { name: input.name } })) {
          throw conflict('A team with this name already exists');
        }
        return tx.supportTeam.create({
          data: { name: input.name, description: input.description || null },
        });
      });
      return toAdminTeam(team, 0, 0);
    },

    async updateTeam(
      id: string,
      input: { name?: string; description?: string | null },
    ): Promise<AdminTeamDto> {
      await withTransaction(prisma, async (tx) => {
        await loadTeam(tx, id);
        if (input.name !== undefined) {
          const clash = await tx.supportTeam.findUnique({ where: { name: input.name } });
          if (clash && clash.id !== id) throw conflict('A team with this name already exists');
        }
        await tx.supportTeam.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description || null } : {}),
          },
        });
      });
      return this.getTeam(id);
    },

    /** Idempotent. Deactivation keeps members and ticket history; the team just stops being offered. */
    async setTeamActive(id: string, isActive: boolean): Promise<AdminTeamDto> {
      await withTransaction(prisma, async (tx) => {
        await loadTeam(tx, id);
        await tx.supportTeam.update({ where: { id }, data: { isActive } });
      });
      return this.getTeam(id);
    },

    async listMembers(teamId: string): Promise<AdminTeamMemberDto[]> {
      await loadTeam(prisma, teamId);
      const rows = await prisma.teamMember.findMany({
        where: { teamId },
        include: { user: { select: { id: true, displayName: true, email: true, isActive: true } } },
        orderBy: { user: { displayName: 'asc' } },
      });
      const assigned = await prisma.ticket.groupBy({
        by: ['assigneeId'],
        where: { assignedTeamId: teamId, assigneeId: { not: null } },
        _count: { _all: true },
      });
      const counts = new Map(assigned.map((a) => [a.assigneeId, a._count._all]));
      return rows.map((r) => ({
        id: r.user.id,
        displayName: r.user.displayName,
        email: r.user.email,
        isActive: r.user.isActive,
        joinedAt: r.joinedAt.toISOString(),
        assignedTicketCount: counts.get(r.userId) ?? 0,
      }));
    },

    async addMember(teamId: string, userId: string): Promise<AdminTeamMemberDto> {
      await withTransaction(prisma, async (tx) => {
        const team = await loadTeam(tx, teamId);
        const user = await teamMembers.findUser(tx, userId);
        if (!user) throw notFoundError('User');
        if (!team.isActive) throw conflict('Members cannot be added to an inactive team');
        if (!user.isActive) throw conflict('An inactive account cannot join a team');
        if (user.role !== 'TECHNICIAN') {
          throw conflict('Only technicians can be team members');
        }
        if (await teamMembers.isMember(tx, teamId, userId)) {
          throw conflict('This technician is already a member of the team');
        }
        await teamMembers.addMember(tx, teamId, userId);
      });
      const member = (await this.listMembers(teamId)).find((m) => m.id === userId);
      return member!;
    },

    async removeMember(teamId: string, userId: string): Promise<void> {
      await withTransaction(prisma, async (tx) => {
        await loadTeam(tx, teamId);
        if (!(await teamMembers.isMember(tx, teamId, userId))) throw notFoundError('Membership');
        const assigned = await tx.ticket.count({
          where: { assignedTeamId: teamId, assigneeId: userId },
        });
        if (assigned > 0) {
          throw conflict(
            'This member still has tickets assigned within the team. Reassign them first.',
            { assignedTicketCount: assigned },
          );
        }
        await teamMembers.removeMember(tx, teamId, userId);
      });
    },
  };
}

export type TeamService = ReturnType<typeof createTeamService>;
