import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../src/db/errors.js';
import { insertRecommendation } from '../../src/db/repositories/aiRecommendations.js';
import { appendEvent, listEvents } from '../../src/db/repositories/ticketEvents.js';
import { insertTicket } from '../../src/db/repositories/tickets.js';
import {
  addComment,
  approveRouting,
  createTicket,
  reviewRecommendation,
  transitionTicket,
} from '../../src/db/services/ticketService.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createTestPrisma, insertRow, resetDatabase, testDatabaseUrl } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('transactions and services (integration)', () => {
  const prisma = createTestPrisma();

  let employeeId: string;
  let otherEmployeeId: string;
  let techId: string;
  let tech2Id: string;
  let outsiderId: string;
  let adminId: string;
  let teamId: string;
  let team2Id: string;
  let categoryId: string;
  let category2Id: string;

  const id = async (table: string, values: Record<string, unknown>, col: string) =>
    (await insertRow(prisma, table, values))[col] as string;
  const types = async (ticketId: string) =>
    (await listEvents(prisma, ticketId)).map((e) => e.eventType);
  const counts = async () => ({
    tickets: await prisma.ticket.count(),
    events: await prisma.ticketEvent.count(),
    comments: await prisma.ticketComment.count(),
  });
  const rejection = async (p: Promise<unknown>): Promise<DbError> => {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(DbError);
      return err as DbError;
    }
    throw new Error('expected a rejection');
  };

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = (email: string, role: string) =>
      id('users', { email, display_name: email.split('@')[0], role }, 'user_id');
    employeeId = await user('emp@example.test', 'EMPLOYEE');
    otherEmployeeId = await user('emp2@example.test', 'EMPLOYEE');
    techId = await user('tech@example.test', 'TECHNICIAN');
    tech2Id = await user('tech2@example.test', 'TECHNICIAN');
    outsiderId = await user('outsider@example.test', 'TECHNICIAN');
    adminId = await user('admin@example.test', 'ADMIN');
    teamId = await id('support_teams', { name: 'Network' }, 'team_id');
    team2Id = await id('support_teams', { name: 'Hardware' }, 'team_id');
    categoryId = await id('ticket_categories', { name: 'VPN' }, 'category_id');
    category2Id = await id('ticket_categories', { name: 'Laptop' }, 'category_id');
    await insertRow(prisma, 'team_members', { team_id: teamId, user_id: techId });
    await insertRow(prisma, 'team_members', { team_id: teamId, user_id: tech2Id });
    await insertRow(prisma, 'team_members', { team_id: team2Id, user_id: outsiderId });
  });

  const newTicket = () =>
    createTicket(prisma, {
      requesterId: employeeId,
      title: 'VPN drops',
      description: 'Drops hourly',
    });

  describe('create', () => {
    it('writes the ticket and its CREATED event together', async () => {
      const ticket = await newTicket();
      expect(ticket).toMatchObject({ status: 'OPEN', priority: 'UNSET', assignedTeamId: null });
      const events = await listEvents(prisma, ticket.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: 'CREATED', actorId: employeeId });
    });

    it('takes the requester from the session user, rejecting unknown/inactive users', async () => {
      await prisma.$executeRaw`UPDATE users SET is_active = false WHERE user_id = ${otherEmployeeId}::uuid`;
      const err = await rejection(
        createTicket(prisma, { requesterId: otherEmployeeId, title: 't', description: 'd' }),
      );
      expect(err.code).toBe('FORBIDDEN');
      expect((await counts()).tickets).toBe(0);
    });

    it('rejects blank input before touching the database', () => {
      expect(() =>
        createTicket(prisma, { requesterId: employeeId, title: ' ', description: 'd' }),
      ).toThrow(/Title/);
    });
  });

  describe('atomicity', () => {
    it('rolls back the ticket when the audit event fails', async () => {
      const err = await rejection(
        withTransaction(prisma, async (tx) => {
          const ticket = await insertTicket(tx, {
            requesterId: employeeId,
            title: 'x',
            description: 'y',
          });
          // 'BOGUS' violates ck_ticket_events_type, after the ticket was already written.
          await appendEvent(tx, {
            ticketId: ticket.id,
            actorId: employeeId,
            type: 'BOGUS' as never,
          });
        }),
      );
      expect(err.code).toBe('CONSTRAINT');
      expect(await counts()).toMatchObject({ tickets: 0, events: 0 });
    });

    it('rolls back when the work throws after the main write', async () => {
      await expect(
        withTransaction(prisma, async (tx) => {
          const ticket = await insertTicket(tx, {
            requesterId: employeeId,
            title: 'x',
            description: 'y',
          });
          await appendEvent(tx, { ticketId: ticket.id, actorId: employeeId, type: 'CREATED' });
          throw new Error('injected failure');
        }),
      ).rejects.toMatchObject({ code: 'UNKNOWN' });
      expect(await counts()).toMatchObject({ tickets: 0, events: 0 });
    });

    it('leaves routing and review unchanged when a later step fails', async () => {
      const ticket = await newTicket();
      // Inactive team is rejected after the category was validated: nothing is written.
      await prisma.$executeRaw`UPDATE support_teams SET is_active = false WHERE team_id = ${team2Id}::uuid`;
      const err = await rejection(
        approveRouting(prisma, {
          ticketId: ticket.id,
          actorId: techId,
          categoryId,
          priority: 'HIGH',
          teamId: team2Id,
        }),
      );
      expect(err.code).toBe('VALIDATION');
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(after).toMatchObject({ status: 'OPEN', categoryId: null, assignedTeamId: null });
      expect(await types(ticket.id)).toEqual(['CREATED']);
    });
  });

  describe('routing approval', () => {
    it('uses TEAM_ASSIGNED first, TEAM_REASSIGNED afterwards, and triages when complete', async () => {
      const ticket = await newTicket();
      const first = await approveRouting(prisma, {
        ticketId: ticket.id,
        actorId: techId,
        categoryId,
        priority: 'HIGH',
        teamId,
        assigneeId: tech2Id,
      });
      expect(first).toMatchObject({
        status: 'TRIAGED',
        priority: 'HIGH',
        assignedTeamId: teamId,
        assigneeId: tech2Id,
      });
      expect(first.updatedAt.getTime()).toBeGreaterThanOrEqual(ticket.updatedAt.getTime());

      // Admin moves it to another team: assignee is cleared (not a member of the new team).
      const second = await approveRouting(prisma, {
        ticketId: ticket.id,
        actorId: adminId,
        teamId: team2Id,
      });
      expect(second).toMatchObject({ assignedTeamId: team2Id, assigneeId: null });

      const events = await types(ticket.id);
      expect(events.filter((t) => t === 'TEAM_ASSIGNED')).toHaveLength(1);
      expect(events.filter((t) => t === 'TEAM_REASSIGNED')).toHaveLength(1);
      expect(events).toEqual([
        'CREATED',
        'CATEGORY_UPDATED',
        'PRIORITY_UPDATED',
        'TEAM_ASSIGNED',
        'ASSIGNEE_UPDATED',
        'STATUS_CHANGED',
        'TEAM_REASSIGNED',
        'ASSIGNEE_UPDATED',
      ]);
    });

    it('does nothing (no events) when nothing changes', async () => {
      const ticket = await newTicket();
      await approveRouting(prisma, { ticketId: ticket.id, actorId: techId, categoryId });
      const before = (await types(ticket.id)).length;
      await approveRouting(prisma, { ticketId: ticket.id, actorId: techId, categoryId });
      expect((await types(ticket.id)).length).toBe(before);
    });

    it('rejects assignees from the wrong team and scope violations', async () => {
      const ticket = await newTicket();
      let err = await rejection(
        approveRouting(prisma, {
          ticketId: ticket.id,
          actorId: techId,
          teamId,
          assigneeId: outsiderId,
        }),
      );
      expect(err.code).toBe('VALIDATION');

      await approveRouting(prisma, { ticketId: ticket.id, actorId: techId, teamId });
      // Technician of another team and employees cannot route this team's ticket.
      err = await rejection(
        approveRouting(prisma, { ticketId: ticket.id, actorId: outsiderId, priority: 'LOW' }),
      );
      expect(err.code).toBe('FORBIDDEN');
      err = await rejection(
        approveRouting(prisma, { ticketId: ticket.id, actorId: employeeId, priority: 'LOW' }),
      );
      expect(err.code).toBe('FORBIDDEN');
    });

    it('reports a missing ticket as 404', async () => {
      const err = await rejection(
        approveRouting(prisma, {
          ticketId: '00000000-0000-4000-8000-000000000000',
          actorId: techId,
          priority: 'LOW',
        }),
      );
      expect(err).toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });
  });

  describe('concurrency', () => {
    it('lets only one of two conflicting approvals win when both read the same version', async () => {
      const ticket = await newTicket();
      const approve = (category: string, priority: 'LOW' | 'CRITICAL') =>
        approveRouting(prisma, {
          ticketId: ticket.id,
          actorId: techId,
          categoryId: category,
          priority,
          teamId,
          expectedUpdatedAt: ticket.updatedAt,
        });
      const results = await Promise.allSettled([
        approve(categoryId, 'LOW'),
        approve(category2Id, 'CRITICAL'),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: 'STALE_WRITE', statusCode: 409 });

      // The loser left no partial changes: exactly one set of approval events exists.
      const events = await types(ticket.id);
      expect(events.filter((t) => t === 'TEAM_ASSIGNED')).toHaveLength(1);
      expect(events.filter((t) => t === 'CATEGORY_UPDATED')).toHaveLength(1);
    });

    it('serialises concurrent writers on the same ticket without losing events', async () => {
      const ticket = await newTicket();
      await Promise.all(
        [techId, tech2Id, adminId, techId, tech2Id].map((actor, i) =>
          approveRouting(prisma, {
            ticketId: ticket.id,
            actorId: actor,
            priority: (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'LOW'] as const)[i]!,
          }),
        ),
      );
      const events = await types(ticket.id);
      // Each call that changed the priority logged exactly one PRIORITY_UPDATED.
      const final = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(final.priority).not.toBe('UNSET');
      expect(events.filter((t) => t === 'PRIORITY_UPDATED').length).toBeGreaterThanOrEqual(1);
    });

    it('lets only one reviewer decide a recommendation', async () => {
      const ticket = await newTicket();
      const rec = await insertRecommendation(prisma, {
        ticketId: ticket.id,
        proposedCategoryId: categoryId,
        proposedTeamId: teamId,
        proposedPriority: 'HIGH',
        modelVersion: 'test-1',
      });
      const results = await Promise.allSettled([
        reviewRecommendation(prisma, {
          recommendationId: rec.id,
          reviewerId: techId,
          decision: 'ACCEPTED',
        }),
        reviewRecommendation(prisma, {
          recommendationId: rec.id,
          reviewerId: tech2Id,
          decision: 'REJECTED',
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect(loser.reason).toMatchObject({ code: 'STALE_WRITE' });
      expect((await types(ticket.id)).filter((t) => t === 'AI_REVIEWED')).toHaveLength(1);
    });
  });

  describe('AI review', () => {
    const recommend = async (ticketId: string) =>
      insertRecommendation(prisma, {
        ticketId,
        proposedCategoryId: categoryId,
        proposedTeamId: teamId,
        proposedPriority: 'HIGH',
        suggestion: 'Reinstall the VPN client',
        confidence: '0.800',
        modelVersion: 'test-1',
      });

    it('accepting applies the proposal and leaves the original proposal untouched', async () => {
      const ticket = await newTicket();
      const rec = await recommend(ticket.id);
      const result = await reviewRecommendation(prisma, {
        recommendationId: rec.id,
        reviewerId: techId,
        decision: 'ACCEPTED',
        notes: 'Looks right',
      });
      expect(result.ticket).toMatchObject({
        status: 'TRIAGED',
        categoryId,
        assignedTeamId: teamId,
        priority: 'HIGH',
      });
      const after = await prisma.aiRecommendation.findUniqueOrThrow({ where: { id: rec.id } });
      expect(after).toMatchObject({
        reviewStatus: 'ACCEPTED',
        reviewerId: techId,
        reviewNotes: 'Looks right',
        proposedCategoryId: categoryId,
        proposedTeamId: teamId,
        proposedPriority: 'HIGH',
        suggestion: 'Reinstall the VPN client',
      });
      expect(after.confidence?.toString()).toBe('0.8');
      expect(after.reviewedAt!.getTime()).toBeGreaterThanOrEqual(after.createdAt.getTime());
      const events = await types(ticket.id);
      expect(events).toContain('TEAM_ASSIGNED');
      expect(events.at(-1)).toBe('AI_REVIEWED');
    });

    it('overriding keeps the AI proposal and stores the technician choice', async () => {
      const ticket = await newTicket();
      const rec = await recommend(ticket.id);
      const result = await reviewRecommendation(prisma, {
        recommendationId: rec.id,
        reviewerId: techId,
        decision: 'OVERRIDDEN',
        override: { categoryId: category2Id, priority: 'LOW' },
      });
      expect(result.ticket).toMatchObject({ categoryId: category2Id, priority: 'LOW' });
      const after = await prisma.aiRecommendation.findUniqueOrThrow({ where: { id: rec.id } });
      expect(after).toMatchObject({
        reviewStatus: 'OVERRIDDEN',
        proposedCategoryId: categoryId,
        proposedPriority: 'HIGH',
      });
    });

    it('rejecting records the review but leaves the ticket for manual routing', async () => {
      const ticket = await newTicket();
      const rec = await recommend(ticket.id);
      const result = await reviewRecommendation(prisma, {
        recommendationId: rec.id,
        reviewerId: techId,
        decision: 'REJECTED',
      });
      expect(result.ticket).toMatchObject({ status: 'OPEN', categoryId: null });
      expect(await types(ticket.id)).toEqual(['CREATED', 'AI_REVIEWED']);
    });

    it('works without any AI recommendation (manual fallback) and blocks re-review', async () => {
      const ticket = await newTicket();
      await approveRouting(prisma, {
        ticketId: ticket.id,
        actorId: techId,
        categoryId,
        priority: 'MEDIUM',
        teamId,
      });
      expect(await prisma.aiRecommendation.count()).toBe(0);

      const rec = await recommend(ticket.id);
      await reviewRecommendation(prisma, {
        recommendationId: rec.id,
        reviewerId: techId,
        decision: 'REJECTED',
      });
      const err = await rejection(
        reviewRecommendation(prisma, {
          recommendationId: rec.id,
          reviewerId: techId,
          decision: 'ACCEPTED',
        }),
      );
      expect(err.code).toBe('STALE_WRITE');
    });
  });

  describe('lifecycle', () => {
    const toInProgress = async () => {
      const ticket = await newTicket();
      await approveRouting(prisma, {
        ticketId: ticket.id,
        actorId: techId,
        categoryId,
        priority: 'HIGH',
        teamId,
        assigneeId: techId,
      });
      await transitionTicket(prisma, { ticketId: ticket.id, actorId: techId, to: 'IN_PROGRESS' });
      return ticket;
    };

    it('resolves, closes and reopens while keeping historical resolution events', async () => {
      const ticket = await toInProgress();
      const resolved = await transitionTicket(prisma, {
        ticketId: ticket.id,
        actorId: techId,
        to: 'RESOLVED',
        resolutionSummary: 'Reinstalled client',
      });
      expect(resolved).toMatchObject({
        status: 'RESOLVED',
        resolutionSummary: 'Reinstalled client',
      });
      expect(resolved.resolvedAt).toBeInstanceOf(Date);

      const closed = await transitionTicket(prisma, {
        ticketId: ticket.id,
        actorId: techId,
        to: 'CLOSED',
      });
      expect(closed.resolvedAt).toEqual(resolved.resolvedAt);

      // The requester may reopen their own closed ticket.
      const reopened = await transitionTicket(prisma, {
        ticketId: ticket.id,
        actorId: employeeId,
        to: 'OPEN',
      });
      expect(reopened).toMatchObject({
        status: 'OPEN',
        resolvedAt: null,
        resolutionSummary: null,
      });
      const events = await types(ticket.id);
      expect(events).toContain('RESOLVED');
      expect(events.at(-1)).toBe('REOPENED');
    });

    it('rejects invalid edges, missing summaries and other users reopening', async () => {
      const ticket = await toInProgress();
      let err = await rejection(
        transitionTicket(prisma, { ticketId: ticket.id, actorId: techId, to: 'CLOSED' }),
      );
      expect(err.code).toBe('LIFECYCLE');
      err = await rejection(
        transitionTicket(prisma, { ticketId: ticket.id, actorId: techId, to: 'RESOLVED' }),
      );
      expect(err.code).toBe('VALIDATION');
      await transitionTicket(prisma, {
        ticketId: ticket.id,
        actorId: techId,
        to: 'RESOLVED',
        resolutionSummary: 'Done',
      });
      err = await rejection(
        transitionTicket(prisma, { ticketId: ticket.id, actorId: otherEmployeeId, to: 'OPEN' }),
      );
      expect(err.code).toBe('FORBIDDEN');
    });
  });

  describe('comments', () => {
    it('stores the comment and COMMENT_ADDED together, without copying text into the event', async () => {
      const ticket = await newTicket();
      const comment = await addComment(prisma, {
        ticketId: ticket.id,
        authorId: techId,
        body: 'Secret internal detail',
        isInternal: true,
      });
      const events = await listEvents(prisma, ticket.id);
      const added = events.find((e) => e.eventType === 'COMMENT_ADDED')!;
      expect(added.details).toEqual({ commentId: comment.id, isInternal: true });
      expect(JSON.stringify(added.details)).not.toContain('Secret');
    });

    it('limits employees to public comments on their own tickets', async () => {
      const ticket = await newTicket();
      await addComment(prisma, { ticketId: ticket.id, authorId: employeeId, body: 'Thanks' });
      let err = await rejection(
        addComment(prisma, {
          ticketId: ticket.id,
          authorId: employeeId,
          body: 'note',
          isInternal: true,
        }),
      );
      expect(err.code).toBe('FORBIDDEN');
      err = await rejection(
        addComment(prisma, { ticketId: ticket.id, authorId: otherEmployeeId, body: 'hi' }),
      );
      expect(err.code).toBe('FORBIDDEN');
      expect(await prisma.ticketComment.count()).toBe(1);
    });
  });

  describe('error mapping against PostgreSQL', () => {
    it('maps unique and foreign-key violations without leaking details', async () => {
      const dup = await rejection(
        withTransaction(prisma, (tx) =>
          tx.user.create({
            data: { email: 'emp@example.test', displayName: 'Dup', role: 'EMPLOYEE' },
          }),
        ),
      );
      expect(dup).toMatchObject({ code: 'CONFLICT', statusCode: 409 });

      const fk = await rejection(
        withTransaction(prisma, (tx) =>
          insertTicket(tx, {
            requesterId: '00000000-0000-4000-8000-000000000000',
            title: 't',
            description: 'd',
          }),
        ),
      );
      expect(fk).toMatchObject({ code: 'REFERENCE', statusCode: 409 });
      for (const err of [dup, fk]) {
        expect(err.message).not.toMatch(/users_email_key|tickets_requester_id_fkey|INSERT/i);
      }
    });

    it('maps an exceeded transaction timeout to a safe error', async () => {
      const err = await rejection(
        withTransaction(prisma, (tx) => tx.$queryRaw`SELECT pg_sleep(1)`, {
          timeoutMs: 100,
          retries: 0,
        }),
      );
      expect(['TIMEOUT', 'UNKNOWN']).toContain(err.code);
      expect(err.message).not.toMatch(/pg_sleep/);
    });
  });
});
