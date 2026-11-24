import type { TicketPriority, TicketStatus } from '@smartdesk/contracts';
import type { Prisma } from '@smartdesk/db';
import { notificationTypeFor } from '../../domain/notifications.js';
import type { TicketEventType } from '../../domain/ticketEvents.js';
import {
  buildDemoArticles,
  demoEmployees,
  diagnosticArticleId,
  scenarioArticleId,
  scenarios,
  staffByTeam,
} from './demoCatalog.js';
import { CATEGORIES, TEAMS, USERS, uuid, type FixtureSet } from './fixtures.js';

const dayMs = 86_400_000;
const minuteMs = 60_000;
const ticketNumber = (scenario: number, context: number) => 1_000 + scenario * 100 + context;

// The first new ticket's createdAt stores the anchor for the whole expansion.
export const DEMO_ANCHOR_TICKET = uuid('ticket', ticketNumber(0, 0));
export const newDemoAnchor = (now: Date) =>
  new Date(Math.floor(now.getTime() / dayMs) * dayMs - dayMs);

const contexts = [
  ['Toronto hybrid desk', 'I can reproduce this both at home and at my usual Toronto desk.'],
  ['Ottawa office', 'This started at the Ottawa office after I switched back to my usual desk.'],
  [
    'Montreal office',
    'I first saw this at the Montreal office and confirmed it again after signing out.',
  ],
  [
    'Vancouver shared desk',
    'This happens at a shared desk in Vancouver and is slowing down the afternoon handoff.',
  ],
  [
    'Finance month-end',
    'Finance needs this for month-end work and has a temporary manual workaround.',
  ],
  [
    'New starter setup',
    'I found this during a new starter’s setup before they could complete their checklist.',
  ],
  [
    'Training session',
    'We found this during a dry run and have another training session tomorrow.',
  ],
  [
    'Client Services handoff',
    'Two Client Services colleagues can reproduce it while preparing the handoff.',
  ],
  [
    'Operations floor',
    'The Operations floor first noticed it at shift change, and it came back after a retry.',
  ],
  ['Calgary office', 'The Calgary office confirmed it happens on a second work device as well.'],
  [
    'Remote work',
    'I am working remotely and have included the time of the last failure in my notes.',
  ],
  [
    'Facilities desk',
    'Facilities has an upcoming appointment and can set aside time to reproduce the problem.',
  ],
  [
    'Quarterly review',
    'We first noticed it while getting materials ready for the quarterly review.',
  ],
  ['Project team', 'A project teammate reproduced it using the same steps during our check-in.'],
  [
    'Service desk follow-up',
    'I retried the same task after a previous service desk check and saw the issue again.',
  ],
  [
    'Shared workstation',
    'I can reproduce it on the shared workstation and have asked the next shift to take note.',
  ],
] as const;

const eventSlots = {
  created: 1,
  category: 2,
  priority: 3,
  team: 4,
  triaged: 5,
  rerouted: 6,
  assignee: 7,
  started: 8,
  internalNote: 9,
  staffReply: 10,
  employeeReply: 11,
  resolved: 12,
  closed: 13,
  reopened: 14,
  aiReviewed: 15,
} as const;

type DemoActivity = Pick<
  FixtureSet,
  | 'tickets'
  | 'events'
  | 'comments'
  | 'recommendations'
  | 'articles'
  | 'recommendationArticles'
  | 'labels'
> & { notifications: Prisma.NotificationCreateManyInput[] };

function disposition(rank: number): TicketStatus {
  if (rank < 72) return 'OPEN';
  if (rank < 120) return 'TRIAGED';
  if (rank < 192) return 'IN_PROGRESS';
  return rank < 252 ? 'RESOLVED' : 'CLOSED';
}

function reviewStatus(rank: number) {
  if (rank < 36) return 'PENDING';
  if (rank >= 72 && rank < 96) return 'ACCEPTED';
  if (rank >= 120 && rank < 144) return 'OVERRIDDEN';
  if (rank >= 192 && rank < 204) return 'REJECTED';
  return null;
}

function openedAt(anchor: Date, ordinal: number, calendarRank: number): Date {
  if (ordinal === 0) return anchor;
  // The two bands leave a seam at the edge of the initial 30-day report window.
  const daysAgo =
    calendarRank < 192
      ? Math.floor((calendarRank * 27) / 192)
      : 30 + Math.floor(((calendarRank - 192) * 28) / 96);
  const minutesBeforeMidnight = ((ordinal % 12) + 1) * 60 + (ordinal % 11) * 5;
  return new Date(anchor.getTime() - daysAgo * dayMs - minutesBeforeMidnight * minuteMs);
}

export function buildDemoActivity(anchor: Date): DemoActivity {
  const activity: DemoActivity = {
    tickets: [],
    events: [],
    comments: [],
    recommendations: [],
    recommendationArticles: [],
    labels: [],
    notifications: [],
    articles: buildDemoArticles(new Date(anchor.getTime() - 60 * dayMs)),
  };

  let employeeIndex = 0;
  const ticketCount = contexts.length * scenarios.length;

  for (const [contextIndex, [location, context]] of contexts.entries()) {
    for (const scenario of scenarios) {
      const ordinal = contextIndex * scenarios.length + scenario.key;
      // Coprime multipliers distribute workflows and dates independently across scenarios.
      const rank = (ordinal * 53) % ticketCount;
      const calendarRank = (ordinal * 71) % ticketCount;
      const number = ticketNumber(scenario.key, contextIndex);
      const ticketId = uuid('ticket', number);
      const createdAt = openedAt(anchor, ordinal, calendarRank);
      const time = (minutes: number) => new Date(createdAt.getTime() + minutes * minuteMs);
      const requesterId =
        ordinal % 8 === 0
          ? USERS.erin
          : ordinal % 8 === 3
            ? USERS.omar
            : demoEmployees[employeeIndex++ % demoEmployees.length]!.id;
      const technician = staffByTeam[scenario.teamId]![ordinal % 4 === 0 ? 1 : 0]!;
      const status = disposition(rank);
      const reopened = rank >= 60 && rank < 72;
      const routed = rank >= 60;
      const started = routed && status !== 'TRIAGED';
      const reachedResolution = reopened || status === 'RESOLVED' || status === 'CLOSED';
      const priorities = ['LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'CRITICAL'] as const;
      const priority: TicketPriority = routed
        ? priorities[(ordinal + contextIndex) % priorities.length]!
        : 'UNSET';
      const assigneeId = started || (routed && ordinal % 4 !== 0) ? technician : null;
      const routeMinute = 20 + (ordinal % 90);
      const responseMinute = routeMinute + 25 + (ordinal % 65);
      const resolutionMinute = routeMinute + 200 + (ordinal % 13) * 60;
      let updatedAt = createdAt;
      let version = 1;

      function event(
        slot: keyof typeof eventSlots,
        eventType: TicketEventType,
        actorId: string,
        minute: number,
        details: Prisma.InputJsonObject = {},
      ) {
        const slotNumber = eventSlots[slot];
        const id = uuid('event', number * 100 + slotNumber);
        const occurredAt = time(minute);
        activity.events.push({ id, ticketId, eventType, actorId, occurredAt, details });

        const type = notificationTypeFor(eventType, details);
        if (type && actorId !== requesterId) {
          activity.notifications.push({
            id: uuid('notification', number * 100 + slotNumber),
            ticketId,
            eventId: id,
            recipientId: requesterId,
            type,
            createdAt: occurredAt,
            readAt: (ordinal + slotNumber) % 4 === 0 ? null : time(minute + 5),
          });
        }
      }

      function comment(
        slot: 'internalNote' | 'staffReply' | 'employeeReply',
        authorId: string,
        body: string,
        minute: number,
      ) {
        const id = uuid('comment', number * 100 + eventSlots[slot]);
        const isInternal = slot === 'internalNote';
        activity.comments.push({
          id,
          ticketId,
          authorId,
          body,
          isInternal,
          createdAt: time(minute),
        });
        event(slot, 'COMMENT_ADDED', authorId, minute, {
          commentId: id,
          isInternal,
          firstResponse: slot === 'staffReply',
        });
      }

      function changed(minute: number) {
        updatedAt = time(minute);
        version++;
      }

      event('created', 'CREATED', requesterId, 0);

      if (routed) {
        const rerouted = started && ordinal % 9 === 0;
        const firstTeam = rerouted
          ? scenario.teamId === TEAMS.network
            ? TEAMS.hardware
            : TEAMS.network
          : scenario.teamId;
        event('category', 'CATEGORY_UPDATED', USERS.admin, routeMinute, {
          from: null,
          to: scenario.categoryId,
        });
        event('priority', 'PRIORITY_UPDATED', USERS.admin, routeMinute, {
          from: 'UNSET',
          to: priority,
        });
        event('team', 'TEAM_ASSIGNED', USERS.admin, routeMinute, { from: null, to: firstTeam });
        event('triaged', 'STATUS_CHANGED', USERS.admin, routeMinute, {
          from: 'OPEN',
          to: 'TRIAGED',
        });
        changed(routeMinute);

        if (rerouted) {
          event('rerouted', 'TEAM_REASSIGNED', USERS.admin, routeMinute + 5, {
            from: firstTeam,
            to: scenario.teamId,
          });
          changed(routeMinute + 5);
        }
        if (assigneeId) {
          event('assignee', 'ASSIGNEE_UPDATED', USERS.admin, routeMinute + 6, {
            from: null,
            to: assigneeId,
          });
          changed(routeMinute + 6);
        }
        if (started) {
          event('started', 'STATUS_CHANGED', technician, routeMinute + 7, {
            from: 'TRIAGED',
            to: 'IN_PROGRESS',
          });
          changed(routeMinute + 7);
          if (ordinal % 3 === 0) {
            comment(
              'internalNote',
              technician,
              `Confirmed the reported symptoms for ${location}. Next check: ${scenario.steps[0]}`,
              routeMinute + 11,
            );
          }
        }
        if (started || ordinal % 3 === 1) {
          comment(
            'staffReply',
            technician,
            `${scenario.reply} We can use the next check-in with ${location} to confirm the result.`,
            responseMinute,
          );
          if (ordinal % 2 === 0)
            comment('employeeReply', requesterId, context, responseMinute + 30);
        }
      }

      if (reachedResolution) {
        event('resolved', 'RESOLVED', technician, resolutionMinute, { from: 'IN_PROGRESS' });
        changed(resolutionMinute);
        if (status === 'CLOSED') {
          event('closed', 'STATUS_CHANGED', technician, resolutionMinute + 75, {
            from: 'RESOLVED',
            to: 'CLOSED',
          });
          changed(resolutionMinute + 75);
        } else if (reopened) {
          event('reopened', 'REOPENED', technician, resolutionMinute + 115, { from: 'RESOLVED' });
          changed(resolutionMinute + 115);
        }
      }

      const decision = reviewStatus(rank);
      if (decision) {
        const id = uuid('recommendation', number);
        const reviewed = decision !== 'PENDING';
        const reviewMinute = decision === 'REJECTED' ? routeMinute - 5 : routeMinute;
        const alternateCategory =
          scenario.categoryId === CATEGORIES.access ? CATEGORIES.software : CATEGORIES.access;
        const proposedCategoryId =
          decision === 'OVERRIDDEN' || (decision !== 'ACCEPTED' && ordinal % 5 === 0)
            ? alternateCategory
            : scenario.categoryId;
        activity.recommendations.push({
          id,
          ticketId,
          proposedCategoryId,
          proposedTeamId: scenario.teamId,
          proposedPriority: priority === 'UNSET' ? 'MEDIUM' : priority,
          suggestion: scenario.reply,
          confidence: (0.58 + (ordinal % 40) / 100).toFixed(3),
          modelVersion: ordinal % 3 === 0 ? 'smartdesk-demo-v1' : 'smartdesk-demo-v2',
          reviewStatus: decision,
          reviewerId: reviewed ? USERS.admin : null,
          reviewedAt: reviewed ? time(reviewMinute) : null,
          createdAt: time(8),
          reviewNotes:
            decision === 'OVERRIDDEN'
              ? 'Adjusted the category after checking the reported symptoms.'
              : decision === 'REJECTED'
                ? 'Handled through manual triage after confirming the scope.'
                : null,
        });
        if (reviewed)
          event('aiReviewed', 'AI_REVIEWED', USERS.admin, reviewMinute, {
            recommendationId: id,
            decision,
          });
        activity.recommendationArticles.push({
          recommendationId: id,
          articleId: scenarioArticleId(scenario.key),
          relevanceRank: 1,
        });
        if (ordinal % 2 === 0)
          activity.recommendationArticles.push({
            recommendationId: id,
            articleId: diagnosticArticleId,
            relevanceRank: 2,
          });
      }

      if (rank % 2 === 0) {
        activity.labels.push({
          ticketId,
          referenceCategoryId: scenario.categoryId,
          labelledBy: USERS.admin,
          labelledAt: time(routeMinute + 60),
        });
      }

      activity.tickets.push({
        id: ticketId,
        requesterId,
        status,
        priority,
        assigneeId,
        createdAt,
        updatedAt,
        version,
        title: `${scenario.title} (${location})`,
        description: `${scenario.symptom} ${context}`,
        categoryId: routed ? scenario.categoryId : null,
        assignedTeamId: routed ? scenario.teamId : null,
        resolvedAt: reachedResolution && !reopened ? time(resolutionMinute) : null,
        resolutionSummary: reachedResolution && !reopened ? scenario.resolution : null,
      });
    }
  }

  return activity;
}
