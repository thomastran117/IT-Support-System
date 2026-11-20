import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestPrisma,
  expectViolation,
  insertRow,
  resetDatabase,
  testDatabaseUrl,
} from './helpers/db.js';

const NOW = new Date('2026-03-01T12:00:00Z');
const LATER = new Date('2026-03-02T12:00:00Z');
const MISSING = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!testDatabaseUrl)('database constraints (integration)', () => {
  const prisma = createTestPrisma();

  let employeeId: string;
  let techId: string;
  let outsiderId: string;
  let teamId: string;
  let otherTeamId: string;
  let categoryId: string;

  const user = (email: string, role = 'EMPLOYEE', name = 'Some User') =>
    insertRow(prisma, 'users', { email, display_name: name, role }).then(
      (r) => r.user_id as string,
    );
  const ticket = (extra: Record<string, unknown> = {}) =>
    insertRow(prisma, 'tickets', {
      requester_id: employeeId,
      title: 'Printer jam',
      description: 'The printer is jammed.',
      created_at: NOW,
      updated_at: NOW,
      ...extra,
    });
  const triaged = (extra: Record<string, unknown> = {}) =>
    ticket({
      status: 'TRIAGED',
      priority: 'HIGH',
      category_id: categoryId,
      assigned_team_id: teamId,
      ...extra,
    });
  const recommendation = (ticketId: string, extra: Record<string, unknown> = {}) =>
    insertRow(prisma, 'ai_recommendations', {
      ticket_id: ticketId,
      model_version: 'test-1',
      created_at: NOW,
      ...extra,
    });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    employeeId = await user('emp@example.test');
    techId = await user('tech@example.test', 'TECHNICIAN');
    outsiderId = await user('outsider@example.test', 'TECHNICIAN');
    teamId = (await insertRow(prisma, 'support_teams', { name: 'Network' })).team_id as string;
    otherTeamId = (await insertRow(prisma, 'support_teams', { name: 'Hardware' }))
      .team_id as string;
    categoryId = (await insertRow(prisma, 'ticket_categories', { name: 'VPN' }))
      .category_id as string;
    await insertRow(prisma, 'team_members', { team_id: teamId, user_id: techId });
  });

  describe('identity and reference data', () => {
    it('accepts valid roles and rejects unknown ones', async () => {
      for (const role of ['EMPLOYEE', 'TECHNICIAN', 'ADMIN']) {
        await user(`${role.toLowerCase()}@valid.test`, role);
      }
      await expectViolation(user('x@bad.test', 'MANAGER'), 'ck_users_role');
    });

    it('requires lowercase, unique, nonblank emails', async () => {
      await expectViolation(user('Upper@Example.test'), 'ck_users_email_normalized');
      await expectViolation(user('   '), 'ck_users_email_normalized');
      await expectViolation(user('emp@example.test'), 'users_email_key');
    });

    it('requires a nonblank display name', async () => {
      await expectViolation(user('blank@example.test', 'EMPLOYEE', '  '), 'ck_users_display_name');
    });

    it('keeps team and category names unique and nonblank', async () => {
      await expectViolation(insertRow(prisma, 'support_teams', { name: 'Network' }), 'name_key');
      await expectViolation(
        insertRow(prisma, 'support_teams', { name: ' ' }),
        'ck_support_teams_name_nonblank',
      );
      await expectViolation(insertRow(prisma, 'ticket_categories', { name: 'VPN' }), 'name_key');
      await expectViolation(
        insertRow(prisma, 'ticket_categories', { name: '' }),
        'ck_ticket_categories_name_nonblank',
      );
    });
  });

  describe('team membership', () => {
    it('lets one technician join several teams but not twice', async () => {
      await insertRow(prisma, 'team_members', { team_id: otherTeamId, user_id: techId });
      await expectViolation(
        insertRow(prisma, 'team_members', { team_id: teamId, user_id: techId }),
        'team_members_pkey',
      );
    });

    it('rejects nonexistent teams and users', async () => {
      await expectViolation(
        insertRow(prisma, 'team_members', { team_id: MISSING, user_id: techId }),
        'team_members_team_id_fkey',
      );
      await expectViolation(
        insertRow(prisma, 'team_members', { team_id: teamId, user_id: MISSING }),
        'team_members_user_id_fkey',
      );
    });
  });

  describe('tickets', () => {
    it('accepts a new OPEN/UNSET ticket with NULL optional fields', async () => {
      const row = await ticket();
      expect(row).toMatchObject({
        status: 'OPEN',
        priority: 'UNSET',
        assigned_team_id: null,
        assignee_id: null,
        category_id: null,
        resolved_at: null,
        resolution_summary: null,
      });
    });

    it('rejects blank text and unknown status/priority', async () => {
      await expectViolation(ticket({ title: '  ' }), 'ck_tickets_title_nonblank');
      await expectViolation(ticket({ description: '' }), 'ck_tickets_description_nonblank');
      await expectViolation(ticket({ status: 'DONE' }), 'ck_tickets_status');
      await expectViolation(ticket({ priority: 'URGENT' }), 'ck_tickets_priority');
    });

    it('requires category, priority and team for TRIAGED and IN_PROGRESS', async () => {
      await triaged();
      await triaged({ status: 'IN_PROGRESS' });
      for (const status of ['TRIAGED', 'IN_PROGRESS']) {
        await expectViolation(triaged({ status, assigned_team_id: null }), 'ck_tickets_triaged');
        await expectViolation(triaged({ status, category_id: null }), 'ck_tickets_triaged');
        await expectViolation(triaged({ status, priority: 'UNSET' }), 'ck_tickets_triaged');
      }
    });

    it('accepts an assignee only from the assigned team', async () => {
      await triaged({ assignee_id: techId });
      await expectViolation(
        triaged({ assignee_id: outsiderId }),
        'tickets_assigned_team_id_assignee_id_fkey',
      );
      // A member of some other team is still the wrong team for this ticket.
      await insertRow(prisma, 'team_members', { team_id: otherTeamId, user_id: outsiderId });
      await expectViolation(
        triaged({ assignee_id: outsiderId }),
        'tickets_assigned_team_id_assignee_id_fkey',
      );
    });

    it('rejects an assignee without a team (composite FK is MATCH SIMPLE)', async () => {
      // With a NULL team the composite FK is skipped, so the CHECK must catch it.
      await expectViolation(ticket({ assignee_id: techId }), 'ck_tickets_assignee_requires_team');
    });

    it('requires a resolution summary and timestamp for RESOLVED and CLOSED', async () => {
      for (const status of ['RESOLVED', 'CLOSED']) {
        await triaged({ status, resolved_at: LATER, resolution_summary: 'Replaced cable' });
        await expectViolation(
          triaged({ status, resolved_at: LATER }),
          'ck_tickets_resolution_required',
        );
        await expectViolation(
          triaged({ status, resolved_at: LATER, resolution_summary: '  ' }),
          'ck_tickets_resolution_required',
        );
        await expectViolation(
          triaged({ status, resolution_summary: 'Done' }),
          'ck_tickets_resolution_required',
        );
      }
    });

    it('rejects resolved_at before created_at', async () => {
      await expectViolation(
        triaged({
          status: 'RESOLVED',
          resolved_at: new Date('2026-02-01T00:00:00Z'),
          resolution_summary: 'Done',
        }),
        'ck_tickets_resolved_after_created',
      );
    });

    it('clears resolution fields on reopen and rejects a stale resolution', async () => {
      const row = await triaged({
        status: 'RESOLVED',
        resolved_at: LATER,
        resolution_summary: 'Replaced cable',
      });
      const id = row.ticket_id as string;
      await expectViolation(
        prisma.$executeRawUnsafe(
          `UPDATE tickets SET status = 'OPEN' WHERE ticket_id = $1::uuid`,
          id,
        ),
        'ck_tickets_no_stale_resolution',
      );
      const updated = await prisma.$executeRawUnsafe(
        `UPDATE tickets SET status = 'OPEN', resolved_at = NULL, resolution_summary = NULL
         WHERE ticket_id = $1::uuid`,
        id,
      );
      expect(updated).toBe(1);
    });
  });

  describe('comments and events', () => {
    it('stores public and internal comments but not blank bodies or orphans', async () => {
      const ticketId = (await ticket()).ticket_id as string;
      await insertRow(prisma, 'ticket_comments', {
        ticket_id: ticketId,
        author_id: employeeId,
        body: 'Hello',
      });
      await insertRow(prisma, 'ticket_comments', {
        ticket_id: ticketId,
        author_id: techId,
        body: 'Note',
        is_internal: true,
      });
      await expectViolation(
        insertRow(prisma, 'ticket_comments', {
          ticket_id: ticketId,
          author_id: techId,
          body: ' ',
        }),
        'ck_ticket_comments_body_nonblank',
      );
      await expectViolation(
        insertRow(prisma, 'ticket_comments', {
          ticket_id: MISSING,
          author_id: techId,
          body: 'x',
        }),
        'ticket_comments_ticket_id_fkey',
      );
    });

    it('validates event types and JSON object details; NULL actor is a system event', async () => {
      const ticketId = (await ticket()).ticket_id as string;
      const sys = await insertRow(prisma, 'ticket_events', {
        ticket_id: ticketId,
        event_type: 'CREATED',
      });
      expect(sys).toMatchObject({ actor_id: null, details: {} });
      await expectViolation(
        insertRow(prisma, 'ticket_events', { ticket_id: ticketId, event_type: 'DELETED' }),
        'ck_ticket_events_type',
      );
      await expectViolation(
        prisma.$executeRawUnsafe(
          `INSERT INTO ticket_events (ticket_id, event_type, details)
           VALUES ($1::uuid, 'CREATED', '[1]'::jsonb)`,
          ticketId,
        ),
        'ck_ticket_events_details_object',
      );
      await expectViolation(
        insertRow(prisma, 'ticket_events', { ticket_id: MISSING, event_type: 'CREATED' }),
        'ticket_events_ticket_id_fkey',
      );
    });

    it('is append-only: UPDATE and DELETE are rejected', async () => {
      const ticketId = (await ticket()).ticket_id as string;
      const ev = await insertRow(prisma, 'ticket_events', {
        ticket_id: ticketId,
        event_type: 'CREATED',
      });
      await expectViolation(
        prisma.$executeRawUnsafe(
          `UPDATE ticket_events SET event_type = 'REOPENED' WHERE event_id = $1::uuid`,
          ev.event_id,
        ),
        'append-only',
      );
      await expectViolation(
        prisma.$executeRawUnsafe(
          `DELETE FROM ticket_events WHERE event_id = $1::uuid`,
          ev.event_id,
        ),
        'append-only',
      );
    });
  });

  describe('AI recommendations', () => {
    it('accepts PENDING without reviewer and reviewed states with reviewer and time', async () => {
      const t = (await ticket()).ticket_id as string;
      expect(await recommendation(t)).toMatchObject({ review_status: 'PENDING' });
      for (const review_status of ['ACCEPTED', 'OVERRIDDEN', 'REJECTED']) {
        await recommendation(t, { review_status, reviewer_id: techId, reviewed_at: LATER });
      }
    });

    it('rejects incomplete or inconsistent review data', async () => {
      const t = (await ticket()).ticket_id as string;
      await expectViolation(
        recommendation(t, { review_status: 'ACCEPTED' }),
        'ck_ai_recommendations_review_complete',
      );
      await expectViolation(
        recommendation(t, { review_status: 'ACCEPTED', reviewer_id: techId }),
        'ck_ai_recommendations_review_complete',
      );
      await expectViolation(
        recommendation(t, { reviewer_id: techId, reviewed_at: LATER }),
        'ck_ai_recommendations_review_complete',
      );
      await expectViolation(
        recommendation(t, { review_status: 'DONE', reviewer_id: techId, reviewed_at: LATER }),
        'ck_ai_recommendations_review_status',
      );
      await expectViolation(
        recommendation(t, {
          review_status: 'ACCEPTED',
          reviewer_id: techId,
          reviewed_at: new Date('2026-02-01T00:00:00Z'),
        }),
        'ck_ai_recommendations_reviewed_after_created',
      );
    });

    it('validates priority, confidence precision/range and model version', async () => {
      const t = (await ticket()).ticket_id as string;
      await recommendation(t, { proposed_priority: 'CRITICAL', confidence: '1.000' });
      await recommendation(t, { confidence: '0.000' });
      await expectViolation(
        recommendation(t, { proposed_priority: 'UNSET' }),
        'ck_ai_recommendations_priority',
      );
      await expectViolation(
        recommendation(t, { confidence: '1.001' }),
        'ck_ai_recommendations_confidence',
      );
      await expectViolation(
        recommendation(t, { confidence: '-0.100' }),
        'ck_ai_recommendations_confidence',
      );
      await expectViolation(recommendation(t, { model_version: ' ' }), 'model_version_nonblank');
      const stored = await recommendation(t, { confidence: '0.12345' });
      expect(String(stored.confidence)).toBe('0.123'); // NUMERIC(4,3) rounds to 3 places
    });
  });

  describe('knowledge articles and recommendation links', () => {
    it('accepts published/draft articles with nullable category, rejects blanks', async () => {
      await insertRow(prisma, 'knowledge_articles', { title: 'Draft', body: 'x' });
      await insertRow(prisma, 'knowledge_articles', {
        title: 'Published',
        body: 'x',
        is_published: true,
        category_id: categoryId,
      });
      await expectViolation(
        insertRow(prisma, 'knowledge_articles', { title: ' ', body: 'x' }),
        'ck_knowledge_articles_title_nonblank',
      );
      await expectViolation(
        insertRow(prisma, 'knowledge_articles', { title: 'T', body: '' }),
        'ck_knowledge_articles_body_nonblank',
      );
    });

    it('links several articles with unique positive ranks', async () => {
      const t = (await ticket()).ticket_id as string;
      const rec = (await recommendation(t)).recommendation_id as string;
      const article = async (title: string) =>
        (await insertRow(prisma, 'knowledge_articles', { title, body: 'x' })).article_id as string;
      const link = (article_id: string, relevance_rank: number) =>
        insertRow(prisma, 'recommendation_articles', {
          recommendation_id: rec,
          article_id,
          relevance_rank,
        });
      const a1 = await article('A');
      const a2 = await article('B');
      const a3 = await article('C');
      await link(a1, 1);
      await link(a2, 2);
      await expectViolation(link(a1, 3), 'recommendation_articles_pkey');
      await expectViolation(link(a3, 2), 'uq_recommendation_articles_rank');
      await expectViolation(link(a3, 0), 'ck_recommendation_articles_rank_positive');
      await expectViolation(link(a3, -1), 'ck_recommendation_articles_rank_positive');
    });
  });

  describe('classification labels', () => {
    it('allows one label per ticket and checks foreign keys', async () => {
      const t = (await ticket()).ticket_id as string;
      const label = (extra: Record<string, unknown> = {}) =>
        insertRow(prisma, 'classification_labels', {
          ticket_id: t,
          reference_category_id: categoryId,
          labelled_by: techId,
          ...extra,
        });
      await label();
      await expectViolation(label(), 'classification_labels_pkey');
      const t2 = (await ticket()).ticket_id as string;
      await expectViolation(
        label({ ticket_id: t2, reference_category_id: MISSING }),
        'classification_labels_reference_category_id_fkey',
      );
      await expectViolation(
        label({ ticket_id: t2, labelled_by: MISSING }),
        'classification_labels_labelled_by_fkey',
      );
    });
  });

  describe('historical deletion', () => {
    it('refuses to delete referenced users, teams, categories and tickets', async () => {
      const t = (await ticket({ category_id: categoryId })).ticket_id as string;
      await insertRow(prisma, 'ticket_events', { ticket_id: t, event_type: 'CREATED' });
      await expectViolation(
        prisma.$executeRawUnsafe(`DELETE FROM users WHERE user_id = $1::uuid`, employeeId),
        'tickets_requester_id_fkey',
      );
      await expectViolation(
        prisma.$executeRawUnsafe(`DELETE FROM support_teams WHERE team_id = $1::uuid`, teamId),
        'team_members_team_id_fkey',
      );
      await expectViolation(
        prisma.$executeRawUnsafe(
          `DELETE FROM ticket_categories WHERE category_id = $1::uuid`,
          categoryId,
        ),
        'tickets_category_id_fkey',
      );
      await expectViolation(
        prisma.$executeRawUnsafe(`DELETE FROM tickets WHERE ticket_id = $1::uuid`, t),
        'ticket_events_ticket_id_fkey',
      );
    });

    it('deactivating records keeps their associations', async () => {
      const t = (await triaged({ assignee_id: techId })).ticket_id as string;
      await prisma.$executeRawUnsafe(
        `UPDATE users SET is_active = false WHERE user_id = $1::uuid`,
        techId,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE support_teams SET is_active = false WHERE team_id = $1::uuid`,
        teamId,
      );
      const [row] = await prisma.$queryRawUnsafe<{ assignee_id: string }[]>(
        `SELECT assignee_id FROM tickets WHERE ticket_id = $1::uuid`,
        t,
      );
      expect(row?.assignee_id).toBe(techId);
    });

    it('cannot remove a membership that a ticket assignment depends on', async () => {
      await triaged({ assignee_id: techId });
      await expectViolation(
        prisma.$executeRawUnsafe(
          `DELETE FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
          teamId,
          techId,
        ),
        'tickets_assigned_team_id_assignee_id_fkey',
      );
    });
  });

  describe('concurrency', () => {
    it('never leaves an assignment without membership when approval races a removal', async () => {
      for (let i = 0; i < 10; i++) {
        const ticketId = (await ticket()).ticket_id as string;
        const assign = prisma.$executeRawUnsafe(
          `UPDATE tickets SET status = 'TRIAGED', priority = 'HIGH', category_id = $2::uuid,
                  assigned_team_id = $3::uuid, assignee_id = $4::uuid
           WHERE ticket_id = $1::uuid`,
          ticketId,
          categoryId,
          teamId,
          techId,
        );
        const removeMember = prisma.$executeRawUnsafe(
          `DELETE FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
          teamId,
          techId,
        );
        const results = await Promise.allSettled([assign, removeMember]);
        // Whichever commits first wins; the other is rejected by the composite FK.
        expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThan(2);

        const [violations] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT COUNT(*) AS n FROM tickets t
           WHERE t.assignee_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM team_members m
             WHERE m.team_id = t.assigned_team_id AND m.user_id = t.assignee_id)`,
        );
        expect(Number(violations!.n)).toBe(0);

        // Reset for the next round.
        await prisma.$executeRawUnsafe(`DELETE FROM tickets WHERE ticket_id = $1::uuid`, ticketId);
        await prisma.$executeRawUnsafe(
          `INSERT INTO team_members (team_id, user_id) VALUES ($1::uuid, $2::uuid)
           ON CONFLICT DO NOTHING`,
          teamId,
          techId,
        );
      }
    });
  });

  describe('catalog', () => {
    it('has every required index', async () => {
      const rows = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
      const names = rows.map((r) => r.indexname);
      for (const expected of [
        'idx_tickets_requester_created',
        'idx_tickets_team_status_created',
        'idx_tickets_category_created',
        'idx_ticket_events_ticket_occurred',
        'idx_ticket_comments_ticket_created',
        'idx_ai_recommendations_ticket_created',
        'idx_classification_labels_category',
        'idx_team_members_user',
        'idx_recommendation_articles_article',
      ]) {
        expect(names, expected).toContain(expected);
      }
    });

    it('uses a composite foreign key from tickets to team_members', async () => {
      const rows = await prisma.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'tickets_assigned_team_id_assignee_id_fkey'`;
      expect(rows[0]?.def).toContain(
        'FOREIGN KEY (assigned_team_id, assignee_id) REFERENCES team_members(team_id, user_id)',
      );
    });
  });
});
