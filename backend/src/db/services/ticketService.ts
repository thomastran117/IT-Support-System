import { TICKET_DESCRIPTION_MAX, TICKET_TITLE_MAX } from '@smartdesk/contracts';
import type { PrismaClient, TransactionClient } from '@smartdesk/db';
import {
  DbError,
  forbiddenError,
  lifecycleError,
  notFoundError,
  staleWriteError,
  validationError,
} from '../errors.js';
import { lockRow, withTransaction } from '../transaction.js';
import {
  findRecommendation,
  markReviewed,
  type ReviewDecision,
} from '../repositories/aiRecommendations.js';
import { insertComment } from '../repositories/ticketComments.js';
import { appendEvent } from '../repositories/ticketEvents.js';
import { findCategory, findTeam, findUser, isMember } from '../repositories/teamMembers.js';
import {
  findByIdempotencyKey,
  findTicket,
  insertTicket,
  markResolved,
  patchTicket,
  type TicketPriority,
  type TicketStatus,
} from '../repositories/tickets.js';

type Role = 'EMPLOYEE' | 'TECHNICIAN' | 'ADMIN';
interface Actor {
  id: string;
  role: Role;
}
type TicketRow = NonNullable<Awaited<ReturnType<typeof findTicket>>>;

const SETTABLE_PRIORITIES: readonly TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * Manual workflow edges. The database CHECKs validate the final row; which edge was taken is a
 * service rule (see docs/database/deviations.md). Exported so the ticket state machine can reuse it.
 */
export const ALLOWED_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['TRIAGED'],
  TRIAGED: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED', 'OPEN'],
  CLOSED: ['OPEN'],
};

/** The actor always comes from the authenticated session, and is re-read from the database. */
async function loadActor(tx: TransactionClient, userId: string): Promise<Actor> {
  const user = await findUser(tx, userId);
  if (!user || !user.isActive) throw forbiddenError();
  return { id: user.id, role: user.role as Role };
}

/** Lock the ticket row, then optionally reject a stale read. */
async function lockTicket(
  tx: TransactionClient,
  ticketId: string,
  expectedUpdatedAt?: Date,
): Promise<TicketRow> {
  if (!(await lockRow(tx, 'tickets', ticketId))) throw notFoundError('Ticket');
  const ticket = await findTicket(tx, ticketId);
  if (!ticket) throw notFoundError('Ticket');
  if (expectedUpdatedAt && ticket.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    throw staleWriteError('Ticket');
  }
  return ticket;
}

/** Technicians act on unassigned tickets and on tickets of teams they belong to; admins on any. */
async function assertTechnicianScope(
  tx: TransactionClient,
  actor: Actor,
  ticket: TicketRow,
): Promise<void> {
  if (actor.role === 'ADMIN') return;
  if (actor.role !== 'TECHNICIAN') throw forbiddenError();
  if (ticket.assignedTeamId && !(await isMember(tx, ticket.assignedTeamId, actor.id))) {
    throw forbiddenError();
  }
}

export interface RoutingChange {
  categoryId?: string;
  priority?: TicketPriority;
  teamId?: string;
  /** `null` explicitly clears the assignee. */
  assigneeId?: string | null;
}

/**
 * Apply approved category/priority/team/assignee values and append matching audit events. Must run
 * inside the caller's transaction, with the ticket row already locked.
 * The first non-null team uses TEAM_ASSIGNED; any later team change uses TEAM_REASSIGNED.
 */
async function applyRouting(
  tx: TransactionClient,
  actor: Actor,
  ticket: TicketRow,
  change: RoutingChange,
): Promise<TicketRow> {
  if (!(['OPEN', 'TRIAGED', 'IN_PROGRESS'] as string[]).includes(ticket.status)) {
    throw lifecycleError('Resolved or closed tickets cannot be re-routed; reopen the ticket first');
  }

  const next = {
    categoryId: ticket.categoryId,
    priority: ticket.priority as TicketPriority,
    teamId: ticket.assignedTeamId,
    assigneeId: ticket.assigneeId,
  };

  if (change.categoryId !== undefined && change.categoryId !== ticket.categoryId) {
    const category = await findCategory(tx, change.categoryId);
    if (!category?.isActive) throw validationError('Category is unknown or inactive');
    next.categoryId = category.id;
  }
  if (change.priority !== undefined && change.priority !== ticket.priority) {
    if (!SETTABLE_PRIORITIES.includes(change.priority)) throw validationError('Invalid priority');
    next.priority = change.priority;
  }
  const teamChanged = change.teamId !== undefined && change.teamId !== ticket.assignedTeamId;
  if (teamChanged) {
    const team = await findTeam(tx, change.teamId!);
    if (!team?.isActive) throw validationError('Team is unknown or inactive');
    next.teamId = team.id;
    // A previous assignee is not a member of the new team unless explicitly re-chosen.
    if (change.assigneeId === undefined) next.assigneeId = null;
  }
  if (change.assigneeId !== undefined) next.assigneeId = change.assigneeId;

  if (next.assigneeId) {
    const assignee = await findUser(tx, next.assigneeId);
    if (
      !next.teamId ||
      !assignee?.isActive ||
      assignee.role !== 'TECHNICIAN' ||
      !(await isMember(tx, next.teamId, assignee.id))
    ) {
      throw validationError('Assignee must be an active technician in the assigned team');
    }
  }

  const triageReady = !!next.categoryId && next.priority !== 'UNSET' && !!next.teamId;
  const nextStatus: TicketStatus =
    ticket.status === 'OPEN' && triageReady ? 'TRIAGED' : (ticket.status as TicketStatus);

  const changed =
    next.categoryId !== ticket.categoryId ||
    next.priority !== ticket.priority ||
    next.teamId !== ticket.assignedTeamId ||
    next.assigneeId !== ticket.assigneeId ||
    nextStatus !== ticket.status;
  if (!changed) return ticket;

  const updated = await patchTicket(tx, ticket.id, {
    categoryId: next.categoryId,
    priority: next.priority,
    assignedTeamId: next.teamId,
    assigneeId: next.assigneeId,
    status: nextStatus,
  });

  const event = (
    type: Parameters<typeof appendEvent>[1]['type'],
    details: Record<string, unknown>,
  ) => appendEvent(tx, { ticketId: ticket.id, actorId: actor.id, type, details });

  if (next.categoryId !== ticket.categoryId) {
    await event('CATEGORY_UPDATED', { from: ticket.categoryId, to: next.categoryId });
  }
  if (next.priority !== ticket.priority) {
    await event('PRIORITY_UPDATED', { from: ticket.priority, to: next.priority });
  }
  if (next.teamId !== ticket.assignedTeamId && next.teamId) {
    await event(ticket.assignedTeamId ? 'TEAM_REASSIGNED' : 'TEAM_ASSIGNED', {
      from: ticket.assignedTeamId,
      to: next.teamId,
    });
  }
  if (next.assigneeId !== ticket.assigneeId) {
    await event('ASSIGNEE_UPDATED', { from: ticket.assigneeId, to: next.assigneeId });
  }
  if (nextStatus !== ticket.status) {
    await event('STATUS_CHANGED', { from: ticket.status, to: nextStatus });
  }
  return updated;
}

// ---------------------------------------------------------------------------------------------
// Public operations. Each is one transaction: the mutation and its audit events commit together.
// ---------------------------------------------------------------------------------------------

export interface CreateTicketInput {
  requesterId: string;
  title: string;
  description: string;
  /** Optional client key: a retry with the same key and payload returns the original ticket. */
  idempotencyKey?: string;
}

export interface SubmittedTicket {
  ticket: TicketRow;
  /** `false` when the key matched an earlier submission and nothing new was written. */
  created: boolean;
}

/** Create an OPEN/UNSET ticket plus its CREATED event, or replay an idempotent submission. */
export function submitTicket(
  prisma: PrismaClient,
  input: CreateTicketInput,
): Promise<SubmittedTicket> {
  // Input is validated synchronously, before any database work starts.
  const title = input.title.trim();
  const description = input.description.trim();
  const key = input.idempotencyKey;
  if (!title || title.length > TICKET_TITLE_MAX) {
    throw validationError(`Title must be 1-${TICKET_TITLE_MAX} characters`);
  }
  if (!description) throw validationError('Description is required');
  if (description.length > TICKET_DESCRIPTION_MAX) {
    throw validationError(`Description must be at most ${TICKET_DESCRIPTION_MAX} characters`);
  }

  const replay = (existing: TicketRow): SubmittedTicket => {
    if (existing.title !== title || existing.description !== description) {
      throw new DbError(
        'CONFLICT',
        409,
        'This Idempotency-Key was already used for a different ticket',
      );
    }
    return { ticket: existing, created: false };
  };

  return run();

  async function run(): Promise<SubmittedTicket> {
    try {
      return await withTransaction(prisma, async (tx) => {
        const actor = await loadActor(tx, input.requesterId);
        if (key) {
          const existing = await findByIdempotencyKey(tx, actor.id, key);
          if (existing) return replay(existing);
        }
        const ticket = await insertTicket(tx, {
          requesterId: actor.id,
          title,
          description,
          idempotencyKey: key ?? null,
        });
        await appendEvent(tx, { ticketId: ticket.id, actorId: actor.id, type: 'CREATED' });
        return { ticket, created: true };
      });
    } catch (err) {
      // Optimistic path: two requests with one key race to insert; the loser hits the unique index
      // (the whole transaction rolled back, so it left nothing behind) and resolves to the winner.
      if (key && err instanceof DbError && err.code === 'CONFLICT') {
        const existing = await findByIdempotencyKey(prisma, input.requesterId, key);
        if (existing) return replay(existing);
      }
      throw err;
    }
  }
}

/** Create an OPEN/UNSET ticket plus its CREATED event. */
export function createTicket(prisma: PrismaClient, input: CreateTicketInput) {
  return submitTicket(prisma, input).then((r) => r.ticket);
}

export interface ApproveRoutingInput extends RoutingChange {
  ticketId: string;
  actorId: string;
  /** `updatedAt` the caller last read; a mismatch is rejected as a 409. */
  expectedUpdatedAt?: Date;
}

/** Technician-approved category/priority/team/assignee change with audit events. */
export function approveRouting(prisma: PrismaClient, input: ApproveRoutingInput) {
  return withTransaction(prisma, async (tx) => {
    const actor = await loadActor(tx, input.actorId);
    const ticket = await lockTicket(tx, input.ticketId, input.expectedUpdatedAt);
    await assertTechnicianScope(tx, actor, ticket);
    return applyRouting(tx, actor, ticket, input);
  });
}

export interface TransitionInput {
  ticketId: string;
  actorId: string;
  to: TicketStatus;
  resolutionSummary?: string;
  expectedUpdatedAt?: Date;
}

/** Move a ticket along the manual workflow (including reopen) with the right audit event. */
export function transitionTicket(prisma: PrismaClient, input: TransitionInput) {
  return withTransaction(prisma, async (tx) => {
    const actor = await loadActor(tx, input.actorId);
    const ticket = await lockTicket(tx, input.ticketId, input.expectedUpdatedAt);
    const from = ticket.status as TicketStatus;
    if (!ALLOWED_TRANSITIONS[from].includes(input.to)) {
      throw lifecycleError(`A ${from} ticket cannot move to ${input.to}`);
    }

    const isReopen = input.to === 'OPEN';
    if (isReopen && actor.role === 'EMPLOYEE') {
      if (ticket.requesterId !== actor.id) throw forbiddenError();
    } else {
      await assertTechnicianScope(tx, actor, ticket);
    }

    const log = (type: Parameters<typeof appendEvent>[1]['type'], details = {}) =>
      appendEvent(tx, { ticketId: ticket.id, actorId: actor.id, type, details });

    switch (input.to) {
      case 'TRIAGED':
        if (!ticket.categoryId || ticket.priority === 'UNSET' || !ticket.assignedTeamId) {
          throw lifecycleError('Triage requires an approved category, priority and team');
        }
        await patchTicket(tx, ticket.id, { status: 'TRIAGED' });
        await log('STATUS_CHANGED', { from, to: input.to });
        break;
      case 'IN_PROGRESS':
        await patchTicket(tx, ticket.id, { status: 'IN_PROGRESS' });
        await log('STATUS_CHANGED', { from, to: input.to });
        break;
      case 'RESOLVED': {
        const summary = input.resolutionSummary?.trim();
        if (!summary) throw validationError('A resolution summary is required');
        await markResolved(tx, ticket.id, 'RESOLVED', summary, false);
        await log('RESOLVED', { from });
        break;
      }
      case 'CLOSED':
        await markResolved(tx, ticket.id, 'CLOSED', ticket.resolutionSummary ?? '', true);
        await log('STATUS_CHANGED', { from, to: input.to });
        break;
      case 'OPEN':
        // Clear the current resolution; earlier RESOLVED events stay in the audit trail.
        await patchTicket(tx, ticket.id, {
          status: 'OPEN',
          resolvedAt: null,
          resolutionSummary: null,
        });
        await log('REOPENED', { from });
        break;
    }
    return (await findTicket(tx, ticket.id))!;
  });
}

export interface AddCommentInput {
  ticketId: string;
  authorId: string;
  body: string;
  isInternal?: boolean;
}

/** Add a comment plus its COMMENT_ADDED event (no comment text is copied into the event). */
export function addComment(prisma: PrismaClient, input: AddCommentInput) {
  const body = input.body.trim();
  if (!body) throw validationError('Comment text is required');
  const isInternal = input.isInternal ?? false;

  return withTransaction(prisma, async (tx) => {
    const actor = await loadActor(tx, input.authorId);
    const ticket = await findTicket(tx, input.ticketId);
    if (!ticket) throw notFoundError('Ticket');

    if (actor.role === 'EMPLOYEE') {
      if (ticket.requesterId !== actor.id || isInternal) throw forbiddenError();
    } else {
      await assertTechnicianScope(tx, actor, ticket);
    }

    const comment = await insertComment(tx, {
      ticketId: ticket.id,
      authorId: actor.id,
      body,
      isInternal,
    });
    await appendEvent(tx, {
      ticketId: ticket.id,
      actorId: actor.id,
      type: 'COMMENT_ADDED',
      details: { commentId: comment.id, isInternal },
    });
    return comment;
  });
}

export interface ReviewInput {
  recommendationId: string;
  reviewerId: string;
  decision: ReviewDecision;
  notes?: string;
  /** For OVERRIDDEN: the technician's own values, which win over the AI proposal. */
  override?: RoutingChange;
  expectedUpdatedAt?: Date;
}

/**
 * Record a technician's decision on an AI recommendation.
 * The original `proposed_*` columns are never touched; only review metadata, the approved ticket
 * values and the audit events change, all in one transaction.
 */
export function reviewRecommendation(prisma: PrismaClient, input: ReviewInput) {
  return withTransaction(prisma, async (tx) => {
    const actor = await loadActor(tx, input.reviewerId);
    const preview = await findRecommendation(tx, input.recommendationId);
    if (!preview) throw notFoundError('Recommendation');

    // Lock order is always ticket, then recommendation, so concurrent reviews cannot deadlock.
    const ticket = await lockTicket(tx, preview.ticketId, input.expectedUpdatedAt);
    await lockRow(tx, 'ai_recommendations', preview.id);
    const rec = (await findRecommendation(tx, preview.id))!;
    if (rec.reviewStatus !== 'PENDING') throw staleWriteError('Recommendation');
    await assertTechnicianScope(tx, actor, ticket);

    let change: RoutingChange | undefined;
    if (input.decision === 'REJECTED') {
      if (input.override) throw validationError('A rejected recommendation cannot carry overrides');
    } else {
      const proposed: RoutingChange = {
        ...(rec.proposedCategoryId ? { categoryId: rec.proposedCategoryId } : {}),
        ...(rec.proposedPriority ? { priority: rec.proposedPriority as TicketPriority } : {}),
        ...(rec.proposedTeamId ? { teamId: rec.proposedTeamId } : {}),
      };
      if (input.decision === 'OVERRIDDEN') {
        if (!input.override || Object.keys(input.override).length === 0) {
          throw validationError('An override must change at least one value');
        }
        change = { ...proposed, ...input.override };
      } else {
        change = proposed;
      }
    }

    await markReviewed(tx, rec.id, {
      decision: input.decision,
      reviewerId: actor.id,
      notes: input.notes ?? null,
    });
    const updated = change ? await applyRouting(tx, actor, ticket, change) : ticket;
    await appendEvent(tx, {
      ticketId: ticket.id,
      actorId: actor.id,
      type: 'AI_REVIEWED',
      details: { recommendationId: rec.id, decision: input.decision },
    });
    return { ticket: updated, recommendationId: rec.id, decision: input.decision };
  });
}
