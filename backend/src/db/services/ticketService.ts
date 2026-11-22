import { TICKET_DESCRIPTION_MAX, TICKET_TITLE_MAX } from '@smartdesk/contracts';
import type { PrismaClient, TransactionClient } from '@smartdesk/db';
import {
  evaluateTransition,
  ALLOWED_TRANSITIONS as STATE_MACHINE_TRANSITIONS,
  type TransitionFacts,
} from '../../domain/ticketStateMachine.js';
import { canAuthorInternalNote, canComment, canEditTicket } from '../../auth/policies.js';
import { countsAsFirstResponse } from '../../domain/firstResponse.js';
import {
  DbError,
  forbiddenError,
  invalidTransitionError,
  lifecycleError,
  notFoundError,
  prerequisiteError,
  staleWriteError,
  validationError,
  versionConflictError,
} from '../errors.js';
import { withTransaction } from '../transaction.js';
import {
  findRecommendation,
  markReviewed,
  type ReviewDecision,
} from '../repositories/aiRecommendations.js';
import { enqueueAnalysis } from '../repositories/aiAnalysisJobs.js';
import { insertComment, recordFirstResponse } from '../repositories/ticketComments.js';
import { appendEvent } from '../repositories/ticketEvents.js';
import {
  activeTeamIds,
  findCategory,
  findTeam,
  findUser,
  isMember,
} from '../repositories/teamMembers.js';
import {
  findByIdempotencyKey,
  findTicket,
  insertTicket,
  markResolved,
  patchTicketIfVersion,
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

/** The workflow table lives in the pure state machine; re-exported for existing importers. */
export const ALLOWED_TRANSITIONS = STATE_MACHINE_TRANSITIONS;

/** The actor always comes from the authenticated session, and is re-read from the database. */
async function loadActor(tx: TransactionClient, userId: string): Promise<Actor> {
  const user = await findUser(tx, userId);
  if (!user || !user.isActive) throw forbiddenError();
  return { id: user.id, role: user.role as Role };
}

/**
 * Optimistic read: no lock is taken. The ticket's `version` is remembered and every write below is
 * conditional on it, so a concurrent change surfaces as VERSION_CONFLICT instead of being lost.
 * When the caller supplies the version it last saw, a mismatch fails immediately.
 */
async function loadTicket(
  tx: TransactionClient,
  ticketId: string,
  expectedVersion?: number,
): Promise<TicketRow> {
  const ticket = await findTicket(tx, ticketId);
  if (!ticket) throw notFoundError('Ticket');
  if (expectedVersion !== undefined && ticket.version !== expectedVersion) {
    throw versionConflictError(ticket.version);
  }
  return ticket;
}

/** Turn "0 rows matched the version" into the right 409 (or 404 if the ticket vanished). */
async function assertWritten(tx: TransactionClient, ticketId: string, changed: number) {
  if (changed > 0) return;
  const current = await findTicket(tx, ticketId);
  if (!current) throw notFoundError('Ticket');
  throw versionConflictError(current.version);
}

const MAX_OPTIMISTIC_ATTEMPTS = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one transaction. When the caller named no version (internal callers with no stale view to
 * protect), a lost race is simply retried on fresh data. When the caller did name one, a conflict
 * is reported, never retried: the caller's view is stale and a human or client must look again.
 */
async function mutate<T>(
  prisma: PrismaClient,
  expectedVersion: number | undefined,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(prisma, work);
    } catch (err) {
      const retry =
        expectedVersion === undefined &&
        err instanceof DbError &&
        err.code === 'VERSION_CONFLICT' &&
        attempt < MAX_OPTIMISTIC_ATTEMPTS;
      if (!retry) throw err;
      await sleep(10 * attempt + Math.floor(Math.random() * 20));
    }
  }
}

/**
 * Staff may work a ticket per the shared policy (admins any; technicians their active teams and the
 * unrouted backlog). This is the same rule the HTTP layer uses, so the two cannot drift apart.
 */
async function policyActor(tx: TransactionClient, actor: Actor) {
  const teamIds = actor.role === 'TECHNICIAN' ? await activeTeamIds(tx, actor.id) : [];
  return { id: actor.id, role: actor.role, teamIds };
}

const scopeOf = (ticket: TicketRow) => ({
  requesterId: ticket.requesterId,
  assignedTeamId: ticket.assignedTeamId,
});

async function canWork(tx: TransactionClient, actor: Actor, ticket: TicketRow): Promise<boolean> {
  return canEditTicket(await policyActor(tx, actor), scopeOf(ticket));
}

async function assertCanWork(tx: TransactionClient, actor: Actor, ticket: TicketRow) {
  if (!(await canWork(tx, actor, ticket))) throw forbiddenError();
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
 * inside the caller's transaction; the write is conditional on the version that was read.
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

  await assertWritten(
    tx,
    ticket.id,
    await patchTicketIfVersion(tx, ticket.id, ticket.version, {
      categoryId: next.categoryId,
      priority: next.priority,
      assignedTeamId: next.teamId,
      assigneeId: next.assigneeId,
      status: nextStatus,
    }),
  );

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
  return (await findTicket(tx, ticket.id))!;
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
  /**
   * Queue an AI analysis in the same transaction as the ticket (SD-035). Never waits for the
   * provider; omit it when AI is disabled so no job is created.
   */
  enqueueAnalysis?: { maxAttempts: number };
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
        if (input.enqueueAnalysis) {
          await enqueueAnalysis(tx, {
            ticketId: ticket.id,
            maxAttempts: input.enqueueAnalysis.maxAttempts,
          });
        }
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
  /** `version` the caller last read; a mismatch is rejected as a 409 VERSION_CONFLICT. */
  expectedVersion?: number;
}

/** Technician-approved category/priority/team/assignee change with audit events. */
export function approveRouting(prisma: PrismaClient, input: ApproveRoutingInput) {
  return mutate(prisma, input.expectedVersion, async (tx) => {
    const actor = await loadActor(tx, input.actorId);
    const ticket = await loadTicket(tx, input.ticketId, input.expectedVersion);
    await assertCanWork(tx, actor, ticket);
    return applyRouting(tx, actor, ticket, input);
  });
}

export interface TransitionInput {
  ticketId: string;
  actorId: string;
  to: TicketStatus;
  resolutionSummary?: string;
  /** `version` the caller last read; a mismatch is rejected as a 409 VERSION_CONFLICT. */
  expectedVersion?: number;
}

/** Everything evaluateTransition needs, read inside the transaction. */
async function transitionFacts(tx: TransactionClient, ticket: TicketRow): Promise<TransitionFacts> {
  const team = ticket.assignedTeamId ? await findTeam(tx, ticket.assignedTeamId) : null;
  const assignee = ticket.assigneeId ? await findUser(tx, ticket.assigneeId) : null;
  return {
    status: ticket.status as TicketStatus,
    categoryId: ticket.categoryId,
    priority: ticket.priority as TicketPriority,
    teamId: ticket.assignedTeamId,
    teamActive: !!team?.isActive,
    assigneeId: ticket.assigneeId,
    assigneeEligible:
      !!assignee?.isActive &&
      assignee.role === 'TECHNICIAN' &&
      !!ticket.assignedTeamId &&
      (await isMember(tx, ticket.assignedTeamId, assignee.id)),
    currentSummary: ticket.resolutionSummary,
  };
}

/**
 * Move a ticket along the manual workflow (including reopen) with the right audit event.
 * Order of checks: who you are (403), whether your view is current (409 VERSION_CONFLICT), then the
 * workflow itself (409 INVALID_TRANSITION / PREREQUISITE_FAILED, 422 for a missing summary). A
 * failure of any kind changes nothing; the status, fields and event are written together.
 */
export function transitionTicket(prisma: PrismaClient, input: TransitionInput) {
  return mutate(prisma, input.expectedVersion, async (tx) => {
    const actor = await loadActor(tx, input.actorId);
    const ticket = await loadTicket(tx, input.ticketId);

    // The requester may reopen their own resolved or closed ticket; everything else is staff work.
    const requesterReopen = input.to === 'OPEN' && ticket.requesterId === actor.id;
    if (!requesterReopen) await assertCanWork(tx, actor, ticket);

    if (input.expectedVersion !== undefined && ticket.version !== input.expectedVersion) {
      throw versionConflictError(ticket.version);
    }

    const from = ticket.status as TicketStatus;
    const verdict = evaluateTransition(
      await transitionFacts(tx, ticket),
      input.to,
      input.resolutionSummary,
    );
    if (!verdict.ok) {
      if (verdict.reason === 'INVALID_TRANSITION') throw invalidTransitionError(from, input.to);
      if (verdict.reason === 'PREREQUISITE_FAILED') {
        throw prerequisiteError(input.to, verdict.missing);
      }
      throw validationError('A resolution summary is required');
    }

    const log = (type: Parameters<typeof appendEvent>[1]['type'], details = {}) =>
      appendEvent(tx, { ticketId: ticket.id, actorId: actor.id, type, details });

    switch (input.to) {
      case 'RESOLVED':
        await assertWritten(
          tx,
          ticket.id,
          await markResolved(tx, ticket.id, ticket.version, 'RESOLVED', verdict.summary!, false),
        );
        await log('RESOLVED', { from });
        break;
      case 'CLOSED':
        await assertWritten(
          tx,
          ticket.id,
          await markResolved(tx, ticket.id, ticket.version, 'CLOSED', verdict.summary!, true),
        );
        await log('STATUS_CHANGED', { from, to: input.to });
        break;
      case 'OPEN':
        // Clear the current resolution; earlier RESOLVED events stay in the audit trail.
        await assertWritten(
          tx,
          ticket.id,
          await patchTicketIfVersion(tx, ticket.id, ticket.version, {
            status: 'OPEN',
            resolvedAt: null,
            resolutionSummary: null,
          }),
        );
        await log('REOPENED', { from });
        break;
      default:
        // TRIAGED, IN_PROGRESS
        await assertWritten(
          tx,
          ticket.id,
          await patchTicketIfVersion(tx, ticket.id, ticket.version, { status: input.to }),
        );
        await log('STATUS_CHANGED', { from, to: input.to });
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

    // The same rules the API applies. Public replies: anyone who can read the ticket (the requester,
    // staff in scope). Internal notes: staff who can work it. An employee can never write one.
    const who = await policyActor(tx, actor);
    const allowed = isInternal
      ? canAuthorInternalNote(who, scopeOf(ticket))
      : canComment(who, scopeOf(ticket));
    if (!allowed) throw forbiddenError();

    const comment = await insertComment(tx, {
      ticketId: ticket.id,
      authorId: actor.id,
      body,
      isInternal,
    });
    // Stable first response, set in the same transaction as the comment. Conditional and
    // idempotent (it only ever moves to an earlier time), so it takes no lock and does not touch the
    // ticket `version`: a reply must not make a technician's pending transition conflict.
    const firstResponse =
      countsAsFirstResponse({
        isInternal,
        authorId: actor.id,
        authorRole: actor.role,
        requesterId: ticket.requesterId,
      }) && (await recordFirstResponse(tx, comment.id)) > 0;
    await appendEvent(tx, {
      ticketId: ticket.id,
      actorId: actor.id,
      type: 'COMMENT_ADDED',
      // Ids and flags only: the comment text never enters the audit trail.
      details: { commentId: comment.id, isInternal, ...(firstResponse ? { firstResponse } : {}) },
    });
    return comment;
  });
}

export interface ReviewInput {
  recommendationId: string;
  /** When given, the recommendation must belong to this ticket (404 otherwise). */
  ticketId?: string;
  reviewerId: string;
  decision: ReviewDecision;
  notes?: string;
  /** For OVERRIDDEN: the technician's own values, which win over the AI proposal. */
  override?: RoutingChange;
  /** `version` of the ticket the caller last read. */
  expectedVersion?: number;
}

/**
 * Record a technician's decision on an AI recommendation.
 * The original `proposed_*` columns are never touched; only review metadata, the approved ticket
 * values and the audit events change, all in one transaction.
 */
export function reviewRecommendation(prisma: PrismaClient, input: ReviewInput) {
  return mutate(prisma, input.expectedVersion, async (tx) => {
    const actor = await loadActor(tx, input.reviewerId);
    const rec = await findRecommendation(tx, input.recommendationId);
    if (!rec || (input.ticketId !== undefined && rec.ticketId !== input.ticketId)) {
      throw notFoundError('Recommendation');
    }
    const ticket = await loadTicket(tx, rec.ticketId, input.expectedVersion);
    if (rec.reviewStatus !== 'PENDING') throw staleWriteError('Recommendation');
    await assertCanWork(tx, actor, ticket);

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

    // Claim the recommendation first: the update only matches while it is still PENDING, so of two
    // concurrent reviewers exactly one gets a row and the other is told it was already decided.
    const claimed = await markReviewed(tx, rec.id, {
      decision: input.decision,
      reviewerId: actor.id,
      notes: input.notes ?? null,
    });
    if (claimed === 0) throw staleWriteError('Recommendation');
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
