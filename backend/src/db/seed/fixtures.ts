/**
 * Deterministic synthetic fixtures covering all eleven core tables (SD-009).
 *
 * Everything here is fake: fixed UUIDs, fixed UTC timestamps (never relative to "now"), no real
 * people, passwords, tokens or API secrets. Expected report values for the `test` profile are
 * hand-computed in {@link EXPECTED} and documented in docs/database/fixtures.md.
 */
import type { Prisma } from '@smartdesk/db';

const KINDS = {
  user: 1,
  team: 2,
  category: 3,
  ticket: 4,
  comment: 5,
  event: 6,
  recommendation: 7,
  article: 8,
} as const;

/** Stable, readable UUID: `0000000K-0000-4000-8000-<n>`. */
export const uuid = (kind: keyof typeof KINDS, n: number): string =>
  `${String(KINDS[kind]).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const at = (iso: string): Date => new Date(iso);

/**
 * Shared password for every seeded account (demo and test profiles). It is synthetic and public by
 * design; override with SEED_DEMO_PASSWORD. Only its Argon2id hash is ever stored.
 */
export const DEMO_PASSWORD = 'SmartDesk-Demo-1!';

// --- Identity ---------------------------------------------------------------------------------

export const USERS = {
  admin: uuid('user', 1),
  erin: uuid('user', 2), // employee
  omar: uuid('user', 3), // employee
  ivan: uuid('user', 4), // employee, inactive
  tara: uuid('user', 5), // technician, Network
  tom: uuid('user', 6), // technician, Network + Hardware
  hana: uuid('user', 7), // technician, Hardware
  ingrid: uuid('user', 8), // technician, inactive
} as const;

export const TEAMS = {
  network: uuid('team', 1),
  hardware: uuid('team', 2),
  legacy: uuid('team', 3), // inactive
} as const;

export const CATEGORIES = {
  hardware: uuid('category', 1),
  software: uuid('category', 2),
  network: uuid('category', 3),
  access: uuid('category', 4),
  legacy: uuid('category', 5), // inactive
} as const;

export const TICKETS = {
  printer: uuid('ticket', 1), // OPEN, unassigned, pending AI recommendation
  vpn: uuid('ticket', 2), // TRIAGED, accepted AI recommendation
  license: uuid('ticket', 3), // IN_PROGRESS, rerouted, overridden AI recommendation
  password: uuid('ticket', 4), // RESOLVED
  monitor: uuid('ticket', 5), // CLOSED (auto-closed by the system), rejected AI recommendation
  reopened: uuid('ticket', 6), // OPEN again after being resolved
  aiDown: uuid('ticket', 7), // OPEN, unassigned, labelled, no AI recommendation
  token: uuid('ticket', 8), // OPEN, unassigned
  boundary: uuid('ticket', 9), // IN_PROGRESS, created exactly at the report window start
  afterWindow: uuid('ticket', 10), // OPEN, created exactly at the report window end
  demoA: uuid('ticket', 11), // demo profile only
  demoB: uuid('ticket', 12), // demo profile only
} as const;

export const ARTICLES = {
  vpn: uuid('article', 1),
  printer: uuid('article', 2),
  password: uuid('article', 3),
  software: uuid('article', 4),
  draft: uuid('article', 5), // unpublished
  demoWifi: uuid('article', 6), // demo profile only
  demoMfa: uuid('article', 7), // demo profile only
} as const;

export const RECOMMENDATIONS = {
  printerPending: uuid('recommendation', 1),
  vpnAccepted: uuid('recommendation', 2),
  vpnReanalysis: uuid('recommendation', 3), // later, PENDING
  licenseOverridden: uuid('recommendation', 4),
  passwordAccepted: uuid('recommendation', 5),
  monitorRejected: uuid('recommendation', 6),
} as const;

const users: Prisma.UserCreateManyInput[] = [
  ['admin', 'admin@smartdesk.test', 'Alex Admin', 'ADMIN', true],
  ['erin', 'erin@smartdesk.test', 'Erin Employee', 'EMPLOYEE', true],
  ['omar', 'omar@smartdesk.test', 'Omar Employee', 'EMPLOYEE', true],
  ['ivan', 'ivan.inactive@smartdesk.test', 'Ivan Inactive', 'EMPLOYEE', false],
  ['tara', 'tara@smartdesk.test', 'Tara Technician', 'TECHNICIAN', true],
  ['tom', 'tom@smartdesk.test', 'Tom Technician', 'TECHNICIAN', true],
  ['hana', 'hana@smartdesk.test', 'Hana Technician', 'TECHNICIAN', true],
  ['ingrid', 'ingrid.inactive@smartdesk.test', 'Ingrid Inactive', 'TECHNICIAN', false],
].map(([key, email, displayName, role, isActive]) => ({
  id: USERS[key as keyof typeof USERS],
  email: email as string,
  displayName: displayName as string,
  role: role as string,
  isActive: isActive as boolean,
  createdAt: at('2026-02-01T08:00:00Z'),
}));

const teams: Prisma.SupportTeamCreateManyInput[] = [
  { id: TEAMS.network, name: 'Network & Access', description: 'VPN, Wi-Fi, accounts and access' },
  { id: TEAMS.hardware, name: 'Hardware & Devices', description: 'Laptops, printers, peripherals' },
  { id: TEAMS.legacy, name: 'Legacy Desk', description: 'Retired team', isActive: false },
];

const teamMembers: Prisma.TeamMemberCreateManyInput[] = [
  { teamId: TEAMS.network, userId: USERS.tara, joinedAt: at('2026-02-01T09:00:00Z') },
  { teamId: TEAMS.network, userId: USERS.tom, joinedAt: at('2026-02-01T09:00:00Z') },
  { teamId: TEAMS.hardware, userId: USERS.tom, joinedAt: at('2026-02-01T09:00:00Z') },
  { teamId: TEAMS.hardware, userId: USERS.hana, joinedAt: at('2026-02-01T09:00:00Z') },
  { teamId: TEAMS.legacy, userId: USERS.ingrid, joinedAt: at('2026-02-01T09:00:00Z') },
];

const categories: Prisma.TicketCategoryCreateManyInput[] = [
  { id: CATEGORIES.hardware, name: 'Hardware', description: 'Physical devices' },
  { id: CATEGORIES.software, name: 'Software', description: 'Applications and licences' },
  { id: CATEGORIES.network, name: 'Network/VPN', description: 'Connectivity and VPN' },
  { id: CATEGORIES.access, name: 'Access/Accounts', description: 'Passwords and permissions' },
  { id: CATEGORIES.legacy, name: 'Legacy Systems', description: 'Retired', isActive: false },
].map((c) => ({ ...c, createdAt: at('2026-02-01T08:30:00Z') }));

// --- Tickets ----------------------------------------------------------------------------------

type TicketSeed = Prisma.TicketCreateManyInput;

const ticket = (t: TicketSeed): TicketSeed => t;

const coreTickets: TicketSeed[] = [
  ticket({
    id: TICKETS.printer,
    requesterId: USERS.erin,
    title: 'Cannot print to the third-floor printer',
    description: 'Print jobs stay queued and the printer shows a paper jam error.',
    createdAt: at('2026-03-02T09:00:00Z'),
    updatedAt: at('2026-03-02T09:00:00Z'),
  }),
  ticket({
    id: TICKETS.vpn,
    requesterId: USERS.erin,
    title: 'VPN disconnects every hour',
    description: 'The VPN client drops and asks me to sign in again roughly hourly.',
    status: 'TRIAGED',
    priority: 'HIGH',
    categoryId: CATEGORIES.network,
    assignedTeamId: TEAMS.network,
    createdAt: at('2026-03-02T14:00:00Z'),
    updatedAt: at('2026-03-02T14:30:40Z'),
  }),
  ticket({
    id: TICKETS.license,
    requesterId: USERS.omar,
    title: 'Design software licence expired',
    description: 'The licence server says my seat has expired.',
    status: 'IN_PROGRESS',
    priority: 'MEDIUM',
    categoryId: CATEGORIES.software,
    assignedTeamId: TEAMS.network,
    assigneeId: USERS.tom,
    createdAt: at('2026-03-03T10:00:00Z'),
    updatedAt: at('2026-03-03T12:00:00Z'),
  }),
  ticket({
    id: TICKETS.password,
    requesterId: USERS.erin,
    title: 'Locked out after password change',
    description: 'My account is locked and the reset email never arrives.',
    status: 'RESOLVED',
    priority: 'HIGH',
    categoryId: CATEGORIES.access,
    assignedTeamId: TEAMS.network,
    assigneeId: USERS.tara,
    createdAt: at('2026-03-04T08:00:00Z'),
    updatedAt: at('2026-03-04T16:00:00Z'),
    resolvedAt: at('2026-03-04T16:00:00Z'),
    resolutionSummary: 'Unlocked the account and re-enrolled multi-factor authentication.',
  }),
  ticket({
    id: TICKETS.monitor,
    requesterId: USERS.omar,
    title: 'External monitor flickers',
    description: 'The second monitor flickers when the laptop is docked.',
    status: 'CLOSED',
    priority: 'LOW',
    categoryId: CATEGORIES.hardware,
    assignedTeamId: TEAMS.hardware,
    assigneeId: USERS.hana,
    createdAt: at('2026-03-05T09:00:00Z'),
    updatedAt: at('2026-03-20T00:00:00Z'),
    resolvedAt: at('2026-03-06T09:00:00Z'),
    resolutionSummary: 'Replaced the docking-station cable.',
  }),
  ticket({
    id: TICKETS.reopened,
    requesterId: USERS.erin,
    title: 'Spreadsheet add-in crashes on start',
    description: 'The add-in crashes the spreadsheet application when it opens.',
    status: 'OPEN',
    priority: 'MEDIUM',
    categoryId: CATEGORIES.software,
    assignedTeamId: TEAMS.network,
    createdAt: at('2026-03-06T11:00:00Z'),
    updatedAt: at('2026-03-08T09:00:00Z'),
  }),
  ticket({
    id: TICKETS.aiDown,
    requesterId: USERS.omar,
    title: 'Need access to the finance share',
    description: 'Please grant me read access to the finance team shared folder.',
    createdAt: at('2026-03-09T13:00:00Z'),
    updatedAt: at('2026-03-09T13:00:00Z'),
  }),
  ticket({
    id: TICKETS.token,
    requesterId: USERS.erin,
    title: 'Hardware token shows expired',
    description: 'My VPN hardware token reports that it has expired.',
    createdAt: at('2026-03-09T15:00:00Z'),
    updatedAt: at('2026-03-09T15:00:00Z'),
  }),
  ticket({
    id: TICKETS.boundary,
    requesterId: USERS.omar,
    title: 'Laptop battery drains quickly',
    description: 'The battery lasts about an hour after a full charge.',
    status: 'IN_PROGRESS',
    priority: 'MEDIUM',
    categoryId: CATEGORIES.hardware,
    assignedTeamId: TEAMS.hardware,
    assigneeId: USERS.hana,
    createdAt: at('2026-03-01T00:00:00Z'),
    updatedAt: at('2026-03-01T01:00:00Z'),
  }),
  ticket({
    id: TICKETS.afterWindow,
    requesterId: USERS.erin,
    title: 'Request a second keyboard',
    description: 'Please provide a spare keyboard for the home office.',
    createdAt: at('2026-04-01T00:00:00Z'),
    updatedAt: at('2026-04-01T00:00:00Z'),
  }),
];

const demoTickets: TicketSeed[] = [
  ticket({
    id: TICKETS.demoA,
    requesterId: USERS.erin,
    title: 'Wi-Fi keeps dropping in meeting room B',
    description: 'Video calls freeze whenever the Wi-Fi reconnects.',
    createdAt: at('2026-03-10T09:30:00Z'),
    updatedAt: at('2026-03-10T09:30:00Z'),
  }),
  ticket({
    id: TICKETS.demoB,
    requesterId: USERS.omar,
    title: 'Install the approved PDF editor',
    description: 'I need the company PDF editor installed on my laptop.',
    createdAt: at('2026-03-11T10:15:00Z'),
    updatedAt: at('2026-03-11T10:15:00Z'),
  }),
];

// --- Comments and events ----------------------------------------------------------------------

interface CommentSeed {
  ticket: string;
  author: string;
  body: string;
  internal?: boolean;
  at: string;
}

const comments: CommentSeed[] = [
  {
    ticket: TICKETS.vpn,
    author: USERS.erin,
    body: 'It also happens on the guest network.',
    at: '2026-03-02T14:10:00Z',
  },
  {
    ticket: TICKETS.vpn,
    author: USERS.tara,
    body: 'Thanks Erin. I am checking your VPN profile now.',
    at: '2026-03-02T14:35:00Z',
  },
  {
    ticket: TICKETS.vpn,
    author: USERS.tara,
    body: 'Profile certificate expires hourly on this build; renewing server side.',
    internal: true,
    at: '2026-03-02T14:40:00Z',
  },
  {
    ticket: TICKETS.license,
    author: USERS.tom,
    body: 'I have asked the vendor to extend your seat.',
    at: '2026-03-03T11:30:00Z',
  },
  {
    ticket: TICKETS.license,
    author: USERS.omar,
    body: 'Thanks, I can wait until tomorrow.',
    at: '2026-03-03T11:45:00Z',
  },
  {
    ticket: TICKETS.password,
    author: USERS.tara,
    body: 'Your account is unlocked. Please sign in again.',
    at: '2026-03-04T15:45:00Z',
  },
];

interface EventSeed {
  ticket: string;
  actor: string | null;
  type: string;
  at: string;
  details?: Prisma.InputJsonObject;
}

const ev = (
  ticket: string,
  actor: string | null,
  type: string,
  at: string,
  details?: Prisma.InputJsonObject,
): EventSeed => ({ ticket, actor, type, at, ...(details ? { details } : {}) });

const coreEvents: EventSeed[] = [
  // printer: created only
  ev(TICKETS.printer, USERS.erin, 'CREATED', '2026-03-02T09:00:00Z'),
  // vpn: routed to Network at 14:30, AI recommendation accepted
  ev(TICKETS.vpn, USERS.erin, 'CREATED', '2026-03-02T14:00:00Z'),
  ev(TICKETS.vpn, USERS.tara, 'TEAM_ASSIGNED', '2026-03-02T14:30:00Z', {
    from: null,
    to: TEAMS.network,
  }),
  ev(TICKETS.vpn, USERS.tara, 'AI_REVIEWED', '2026-03-02T14:30:30Z', {
    recommendationId: RECOMMENDATIONS.vpnAccepted,
    decision: 'ACCEPTED',
  }),
  ev(TICKETS.vpn, USERS.tara, 'STATUS_CHANGED', '2026-03-02T14:30:40Z', {
    from: 'OPEN',
    to: 'TRIAGED',
  }),
  // license: first sent to Hardware (10:10), then reassigned to Network (11:00)
  ev(TICKETS.license, USERS.omar, 'CREATED', '2026-03-03T10:00:00Z'),
  ev(TICKETS.license, USERS.tom, 'TEAM_ASSIGNED', '2026-03-03T10:10:00Z', {
    from: null,
    to: TEAMS.hardware,
  }),
  ev(TICKETS.license, USERS.tom, 'TEAM_REASSIGNED', '2026-03-03T11:00:00Z', {
    from: TEAMS.hardware,
    to: TEAMS.network,
  }),
  ev(TICKETS.license, USERS.tom, 'AI_REVIEWED', '2026-03-03T11:00:30Z', {
    recommendationId: RECOMMENDATIONS.licenseOverridden,
    decision: 'OVERRIDDEN',
  }),
  ev(TICKETS.license, USERS.tom, 'STATUS_CHANGED', '2026-03-03T11:00:40Z', {
    from: 'OPEN',
    to: 'TRIAGED',
  }),
  ev(TICKETS.license, USERS.tom, 'STATUS_CHANGED', '2026-03-03T12:00:00Z', {
    from: 'TRIAGED',
    to: 'IN_PROGRESS',
  }),
  // password: routed 08:30, resolved 16:00
  ev(TICKETS.password, USERS.erin, 'CREATED', '2026-03-04T08:00:00Z'),
  ev(TICKETS.password, USERS.tara, 'TEAM_ASSIGNED', '2026-03-04T08:30:00Z', {
    from: null,
    to: TEAMS.network,
  }),
  ev(TICKETS.password, USERS.tara, 'AI_REVIEWED', '2026-03-04T08:30:30Z', {
    recommendationId: RECOMMENDATIONS.passwordAccepted,
    decision: 'ACCEPTED',
  }),
  ev(TICKETS.password, USERS.tara, 'STATUS_CHANGED', '2026-03-04T08:30:40Z', {
    from: 'OPEN',
    to: 'TRIAGED',
  }),
  ev(TICKETS.password, USERS.tara, 'STATUS_CHANGED', '2026-03-04T09:00:00Z', {
    from: 'TRIAGED',
    to: 'IN_PROGRESS',
  }),
  ev(TICKETS.password, USERS.tara, 'RESOLVED', '2026-03-04T16:00:00Z', { from: 'IN_PROGRESS' }),
  // monitor: routed 09:15, resolved next day, closed by the system (NULL actor)
  ev(TICKETS.monitor, USERS.omar, 'CREATED', '2026-03-05T09:00:00Z'),
  ev(TICKETS.monitor, USERS.hana, 'TEAM_ASSIGNED', '2026-03-05T09:15:00Z', {
    from: null,
    to: TEAMS.hardware,
  }),
  ev(TICKETS.monitor, USERS.hana, 'AI_REVIEWED', '2026-03-05T09:15:30Z', {
    recommendationId: RECOMMENDATIONS.monitorRejected,
    decision: 'REJECTED',
  }),
  ev(TICKETS.monitor, USERS.hana, 'STATUS_CHANGED', '2026-03-05T09:15:40Z', {
    from: 'OPEN',
    to: 'TRIAGED',
  }),
  ev(TICKETS.monitor, USERS.hana, 'STATUS_CHANGED', '2026-03-05T10:00:00Z', {
    from: 'TRIAGED',
    to: 'IN_PROGRESS',
  }),
  ev(TICKETS.monitor, USERS.hana, 'RESOLVED', '2026-03-06T09:00:00Z', { from: 'IN_PROGRESS' }),
  ev(TICKETS.monitor, null, 'STATUS_CHANGED', '2026-03-20T00:00:00Z', {
    from: 'RESOLVED',
    to: 'CLOSED',
    reason: 'auto-close after 14 days without reply',
  }),
  // reopened: routed 11:20, resolved, then reopened by the requester
  ev(TICKETS.reopened, USERS.erin, 'CREATED', '2026-03-06T11:00:00Z'),
  ev(TICKETS.reopened, USERS.tara, 'TEAM_ASSIGNED', '2026-03-06T11:20:00Z', {
    from: null,
    to: TEAMS.network,
  }),
  ev(TICKETS.reopened, USERS.tara, 'RESOLVED', '2026-03-07T10:00:00Z', { from: 'IN_PROGRESS' }),
  ev(TICKETS.reopened, USERS.erin, 'REOPENED', '2026-03-08T09:00:00Z', { from: 'RESOLVED' }),
  // aiDown / token / afterWindow: created only (AI unavailable: no recommendation exists)
  ev(TICKETS.aiDown, USERS.omar, 'CREATED', '2026-03-09T13:00:00Z'),
  ev(TICKETS.token, USERS.erin, 'CREATED', '2026-03-09T15:00:00Z'),
  // boundary: created at the window start, routed after 45 minutes
  ev(TICKETS.boundary, USERS.omar, 'CREATED', '2026-03-01T00:00:00Z'),
  ev(TICKETS.boundary, USERS.hana, 'TEAM_ASSIGNED', '2026-03-01T00:45:00Z', {
    from: null,
    to: TEAMS.hardware,
  }),
  ev(TICKETS.boundary, USERS.hana, 'STATUS_CHANGED', '2026-03-01T01:00:00Z', {
    from: 'TRIAGED',
    to: 'IN_PROGRESS',
  }),
  ev(TICKETS.afterWindow, USERS.erin, 'CREATED', '2026-04-01T00:00:00Z'),
];

const demoEvents: EventSeed[] = [
  ev(TICKETS.demoA, USERS.erin, 'CREATED', '2026-03-10T09:30:00Z'),
  ev(TICKETS.demoB, USERS.omar, 'CREATED', '2026-03-11T10:15:00Z'),
];

// --- AI, knowledge and evaluation -------------------------------------------------------------

const recommendations: Prisma.AiRecommendationCreateManyInput[] = [
  {
    id: RECOMMENDATIONS.printerPending,
    ticketId: TICKETS.printer,
    proposedCategoryId: CATEGORIES.hardware,
    proposedTeamId: TEAMS.hardware,
    proposedPriority: 'MEDIUM',
    suggestion: 'Clear the paper jam and restart the print spooler.',
    confidence: '0.710',
    modelVersion: 'fixture-model-1',
    createdAt: at('2026-03-02T09:01:00Z'),
  },
  {
    id: RECOMMENDATIONS.vpnAccepted,
    ticketId: TICKETS.vpn,
    proposedCategoryId: CATEGORIES.network,
    proposedTeamId: TEAMS.network,
    proposedPriority: 'HIGH',
    suggestion: 'Renew the VPN profile certificate.',
    confidence: '0.920',
    modelVersion: 'fixture-model-1',
    reviewStatus: 'ACCEPTED',
    reviewerId: USERS.tara,
    reviewedAt: at('2026-03-02T14:30:30Z'),
    reviewNotes: 'Matches the logs.',
    createdAt: at('2026-03-02T14:01:00Z'),
  },
  {
    id: RECOMMENDATIONS.vpnReanalysis,
    ticketId: TICKETS.vpn,
    proposedCategoryId: CATEGORIES.software,
    proposedTeamId: TEAMS.network,
    proposedPriority: 'LOW',
    suggestion: 'Reinstall the VPN client.',
    confidence: '0.400',
    modelVersion: 'fixture-model-2',
    createdAt: at('2026-03-02T15:00:00Z'),
  },
  {
    id: RECOMMENDATIONS.licenseOverridden,
    ticketId: TICKETS.license,
    proposedCategoryId: CATEGORIES.hardware,
    proposedTeamId: TEAMS.hardware,
    proposedPriority: 'LOW',
    suggestion: 'Check the device warranty.',
    confidence: '0.550',
    modelVersion: 'fixture-model-1',
    reviewStatus: 'OVERRIDDEN',
    reviewerId: USERS.tom,
    reviewedAt: at('2026-03-03T11:00:30Z'),
    reviewNotes: 'This is a licensing problem, not hardware.',
    createdAt: at('2026-03-03T10:01:00Z'),
  },
  {
    id: RECOMMENDATIONS.passwordAccepted,
    ticketId: TICKETS.password,
    proposedCategoryId: CATEGORIES.access,
    proposedTeamId: TEAMS.network,
    proposedPriority: 'HIGH',
    suggestion: 'Unlock the account and send a new reset link.',
    confidence: '0.880',
    modelVersion: 'fixture-model-1',
    reviewStatus: 'ACCEPTED',
    reviewerId: USERS.tara,
    reviewedAt: at('2026-03-04T08:30:30Z'),
    createdAt: at('2026-03-04T08:01:00Z'),
  },
  {
    id: RECOMMENDATIONS.monitorRejected,
    ticketId: TICKETS.monitor,
    proposedCategoryId: CATEGORIES.software,
    proposedTeamId: TEAMS.hardware,
    proposedPriority: 'LOW',
    suggestion: 'Update the display driver.',
    confidence: '0.300',
    modelVersion: 'fixture-model-1',
    reviewStatus: 'REJECTED',
    reviewerId: USERS.hana,
    reviewedAt: at('2026-03-05T09:15:30Z'),
    reviewNotes: 'Cable fault, not a driver issue.',
    createdAt: at('2026-03-05T09:01:00Z'),
  },
];

const coreArticles: Prisma.KnowledgeArticleCreateManyInput[] = [
  {
    id: ARTICLES.vpn,
    categoryId: CATEGORIES.network,
    title: 'Fix a VPN that disconnects repeatedly',
    body: 'If the VPN client drops every hour, renew the VPN profile certificate, sign out of the VPN client and sign in again. Check that the hardware token has not expired.',
    isPublished: true,
  },
  {
    id: ARTICLES.printer,
    categoryId: CATEGORIES.hardware,
    title: 'Clear a printer paper jam and restart the queue',
    body: 'Open the printer tray, remove the jammed paper, close the cover and restart the print spooler so queued print jobs resume.',
    isPublished: true,
  },
  {
    id: ARTICLES.password,
    categoryId: CATEGORIES.access,
    title: 'Reset a forgotten or locked password',
    body: 'Use the self-service portal to reset your password. If the account is locked, wait fifteen minutes or ask the service desk to unlock it and re-enrol multi-factor authentication.',
    isPublished: true,
  },
  {
    id: ARTICLES.software,
    categoryId: CATEGORIES.software,
    title: 'Request or renew a software licence',
    body: 'Software licences are assigned per seat. Ask the service desk to renew an expired licence and restart the application afterwards.',
    isPublished: true,
  },
  {
    id: ARTICLES.draft,
    categoryId: CATEGORIES.hardware,
    title: 'Draft: laptop onboarding checklist',
    body: 'Work in progress. Steps for provisioning a new laptop.',
    isPublished: false,
  },
].map((a) => ({
  ...a,
  createdAt: at('2026-02-10T10:00:00Z'),
  updatedAt: at('2026-02-10T10:00:00Z'),
}));

const demoArticles: Prisma.KnowledgeArticleCreateManyInput[] = [
  {
    id: ARTICLES.demoWifi,
    categoryId: CATEGORIES.network,
    title: 'Troubleshoot unstable Wi-Fi in meeting rooms',
    body: 'Forget and rejoin the corporate Wi-Fi network, then move closer to the access point. Report the room name to the network team.',
    isPublished: true,
  },
  {
    id: ARTICLES.demoMfa,
    categoryId: CATEGORIES.access,
    title: 'Set up multi-factor authentication on a new phone',
    body: 'Install the authenticator app, scan the enrolment code from the self-service portal and keep your recovery codes safe.',
    isPublished: true,
  },
].map((a) => ({
  ...a,
  createdAt: at('2026-02-11T10:00:00Z'),
  updatedAt: at('2026-02-11T10:00:00Z'),
}));

const recommendationArticles: Prisma.RecommendationArticleCreateManyInput[] = [
  { recommendationId: RECOMMENDATIONS.vpnAccepted, articleId: ARTICLES.vpn, relevanceRank: 1 },
  { recommendationId: RECOMMENDATIONS.vpnAccepted, articleId: ARTICLES.password, relevanceRank: 2 },
  {
    recommendationId: RECOMMENDATIONS.printerPending,
    articleId: ARTICLES.printer,
    relevanceRank: 1,
  },
  {
    recommendationId: RECOMMENDATIONS.passwordAccepted,
    articleId: ARTICLES.password,
    relevanceRank: 1,
  },
];

/**
 * Independent reference labels (assigned by the evaluator, never copied from AI output).
 * Two AI proposals are right (vpn, password), two are wrong (license, monitor) and one labelled
 * ticket has no AI recommendation at all (aiDown).
 */
const labels: Prisma.ClassificationLabelCreateManyInput[] = [
  { ticketId: TICKETS.vpn, referenceCategoryId: CATEGORIES.network },
  { ticketId: TICKETS.license, referenceCategoryId: CATEGORIES.software },
  { ticketId: TICKETS.password, referenceCategoryId: CATEGORIES.access },
  { ticketId: TICKETS.monitor, referenceCategoryId: CATEGORIES.hardware },
  { ticketId: TICKETS.aiDown, referenceCategoryId: CATEGORIES.access },
].map((l) => ({ ...l, labelledBy: USERS.admin, labelledAt: at('2026-03-21T10:00:00Z') }));

// --- Assembly ---------------------------------------------------------------------------------

export type Profile = 'demo' | 'test';

export interface FixtureSet {
  users: Prisma.UserCreateManyInput[];
  teams: Prisma.SupportTeamCreateManyInput[];
  teamMembers: Prisma.TeamMemberCreateManyInput[];
  categories: Prisma.TicketCategoryCreateManyInput[];
  tickets: Prisma.TicketCreateManyInput[];
  comments: Prisma.TicketCommentCreateManyInput[];
  events: Prisma.TicketEventCreateManyInput[];
  recommendations: Prisma.AiRecommendationCreateManyInput[];
  articles: Prisma.KnowledgeArticleCreateManyInput[];
  recommendationArticles: Prisma.RecommendationArticleCreateManyInput[];
  labels: Prisma.ClassificationLabelCreateManyInput[];
}

/**
 * `test` is the minimal set whose report results are asserted exactly. `demo` is the same data plus
 * two extra open tickets and two extra published articles for a livelier class demonstration.
 */
export function buildFixtures(profile: Profile): FixtureSet {
  const demo = profile === 'demo';
  const commentRows = comments.map((c, i) => ({
    id: uuid('comment', i + 1),
    ticketId: c.ticket,
    authorId: c.author,
    body: c.body,
    isInternal: c.internal ?? false,
    createdAt: at(c.at),
  }));
  // COMMENT_ADDED events mirror the comments (ids only, never the text).
  const commentEvents: EventSeed[] = commentRows.map((c) => ({
    ticket: c.ticketId,
    actor: c.authorId,
    type: 'COMMENT_ADDED',
    at: c.createdAt.toISOString(),
    details: { commentId: c.id, isInternal: c.isInternal },
  }));
  const eventRows = [...coreEvents, ...commentEvents, ...(demo ? demoEvents : [])].map(
    (e, i): Prisma.TicketEventCreateManyInput => ({
      id: uuid('event', i + 1),
      ticketId: e.ticket,
      actorId: e.actor,
      eventType: e.type,
      details: e.details ?? {},
      occurredAt: at(e.at),
    }),
  );

  return {
    users,
    teams,
    teamMembers,
    categories,
    tickets: [...coreTickets, ...(demo ? demoTickets : [])],
    comments: commentRows,
    events: eventRows,
    recommendations,
    articles: [...coreArticles, ...(demo ? demoArticles : [])],
    recommendationArticles,
    labels,
  };
}

/** The reporting window the expected values below refer to: all of March 2026 (UTC, half-open). */
export const REPORT_WINDOW = {
  start: '2026-03-01T00:00:00Z',
  end: '2026-04-01T00:00:00Z',
} as const;
/** A window with no tickets at all. */
export const EMPTY_WINDOW = { start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' } as const;

/**
 * Hand-computed expectations for the `test` profile (see docs/database/fixtures.md for the
 * arithmetic). They are the contract for the Q01-Q10 integration tests.
 */
export const EXPECTED = {
  rowCounts: {
    users: 8,
    support_teams: 3,
    team_members: 5,
    ticket_categories: 5,
    tickets: 10,
    ticket_comments: 6,
    ticket_events: 34 + 6, // 34 workflow events + 6 COMMENT_ADDED
    ai_recommendations: 6,
    knowledge_articles: 5,
    recommendation_articles: 4,
    classification_labels: 5,
  },
  /** Unassigned OPEN backlog (Q03): printer, aiDown, token, afterWindow. */
  backlog: [TICKETS.printer, TICKETS.aiDown, TICKETS.token, TICKETS.afterWindow],
  q05: { submitted: 9, routed: 6, avgMinutes: '25.00' },
  q06: { resolvedTickets: 2, avgHours: '16.00' },
  q07: { labelledTickets: 5, withRecommendation: 4, correct: 2, accuracyPct: '40.00' },
  q08: { reviewed: 4, accepted: 2, acceptancePct: '50.00' },
  q09: [
    { category: 'Uncategorized', ticketCount: 3 },
    { category: 'Hardware', ticketCount: 2 },
    { category: 'Software', ticketCount: 2 },
    { category: 'Access/Accounts', ticketCount: 1 },
    { category: 'Network/VPN', ticketCount: 1 },
  ],
  q10: [
    { reportDate: '2026-03-01', submittedTickets: 1 },
    { reportDate: '2026-03-02', submittedTickets: 2 },
    { reportDate: '2026-03-03', submittedTickets: 1 },
    { reportDate: '2026-03-04', submittedTickets: 1 },
    { reportDate: '2026-03-05', submittedTickets: 1 },
    { reportDate: '2026-03-06', submittedTickets: 1 },
    { reportDate: '2026-03-09', submittedTickets: 2 },
  ],
} as const;
