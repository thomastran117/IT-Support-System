import type { Prisma, PrismaClient } from '@smartdesk/db';
import { ARTICLES, CATEGORIES, TEAMS, TICKETS, USERS, uuid } from '../../src/db/seed/fixtures.js';
import { seedDatabase } from '../../src/db/seed/run.js';

export const evaluationTickets = {
  network: uuid('ticket', 201),
  hardware: uuid('ticket', 202),
  unassigned: uuid('ticket', 203),
  legacy: uuid('ticket', 204),
  ethernet: uuid('ticket', 205),
  wireless: uuid('ticket', 206),
};

export const evaluationArticles = {
  network: uuid('article', 201),
  hardware: uuid('article', 202),
  draft: uuid('article', 203),
  ethernet: uuid('article', 204),
  wireless: uuid('article', 205),
};

const date = new Date('2026-03-15T12:00:00Z');
const ticket = {
  createdAt: date,
  updatedAt: date,
  status: 'TRIAGED',
  priority: 'HIGH',
} as const;

const tickets: Prisma.TicketCreateManyInput[] = [
  {
    ...ticket,
    id: evaluationTickets.network,
    requesterId: USERS.erin,
    title: 'Relaycase VPN handshake fails',
    description: 'Tunnel certificate fails during the VPN handshake.',
    categoryId: CATEGORIES.network,
    assignedTeamId: TEAMS.network,
    assigneeId: USERS.tara,
  },
  {
    ...ticket,
    id: evaluationTickets.hardware,
    requesterId: USERS.omar,
    title: 'Relaycase docking station handshake fails',
    description: 'Hardware-only display handshake issue.',
    categoryId: CATEGORIES.hardware,
    assignedTeamId: TEAMS.hardware,
    assigneeId: USERS.hana,
  },
  {
    ...ticket,
    id: evaluationTickets.unassigned,
    requesterId: USERS.omar,
    title: 'Relaycase service desk request',
    description: 'Awaiting triage for an intermittent relay problem.',
    status: 'OPEN',
    priority: 'UNSET',
  },
  {
    ...ticket,
    id: evaluationTickets.legacy,
    requesterId: USERS.omar,
    title: 'Relaycase archive canary',
    description: 'Retired queue archival record.',
    categoryId: CATEGORIES.legacy,
    assignedTeamId: TEAMS.legacy,
  },
  {
    ...ticket,
    id: evaluationTickets.ethernet,
    requesterId: USERS.erin,
    title: 'Wired Ethernet loses link after docking',
    description: 'The wired LAN drops immediately when the laptop is docked.',
    categoryId: CATEGORIES.hardware,
    assignedTeamId: TEAMS.hardware,
  },
  {
    ...ticket,
    id: evaluationTickets.wireless,
    requesterId: USERS.erin,
    title: 'Wireless network drops after waking',
    description: 'The laptop Wi-Fi adapter disconnects after sleep.',
    categoryId: CATEGORIES.network,
    assignedTeamId: TEAMS.network,
  },
];

const articles: Prisma.KnowledgeArticleCreateManyInput[] = [
  {
    id: evaluationArticles.network,
    title: 'Relaycase VPN certificate handshake',
    body: 'Renew the profile certificate to fix the VPN tunnel handshake.',
    categoryId: CATEGORIES.network,
    isPublished: true,
  },
  {
    id: evaluationArticles.hardware,
    title: 'Relaycase docking station handshake',
    body: 'Reconnect the external display after resetting the docking station.',
    categoryId: CATEGORIES.hardware,
    isPublished: true,
  },
  {
    id: evaluationArticles.draft,
    title: 'Relaycase draft canary',
    body: 'Access to these unpublished instructions is restricted.',
    categoryId: CATEGORIES.network,
    isPublished: false,
  },
  {
    id: evaluationArticles.ethernet,
    title: 'Restore a lost wired Ethernet link',
    body: 'Check the LAN cable and reset the adapter when docking.',
    categoryId: CATEGORIES.hardware,
    isPublished: true,
  },
  {
    id: evaluationArticles.wireless,
    title: 'Restore Wi-Fi after waking the laptop',
    body: 'Reconnect the wireless network when the adapter drops from sleep mode.',
    categoryId: CATEGORIES.network,
    isPublished: true,
  },
];

const backgroundTopics = [
  ['Calendar synchronization', 'Shared event changes are delayed after a calendar update.'],
  ['Mailbox rules', 'Messages are delivered to the wrong folder after adding an inbox rule.'],
  ['Audio recording', 'The microphone input cuts out during a voice recording.'],
  ['USB device', 'A peripheral fails to respond after it is reconnected.'],
  ['Document recovery', 'Find the older version from the revision history.'],
  ['Browser bookmarks', 'Restore missing favorites from the local profile.'],
  ['Disk encryption', 'Confirm the recovery key for an encrypted drive.'],
  ['Mobile notifications', 'Review alerts in the mobile application settings.'],
] as const;

export function additionalEvaluationArticles(backgroundCount: number) {
  return [
    ...articles,
    ...Array.from({ length: backgroundCount }, (_, i) => {
      const [title, body] = backgroundTopics[i % backgroundTopics.length]!;
      return {
        id: uuid('article', 1000 + i),
        title: `${title} guide ${i + 1}`,
        body,
        categoryId: i % 3 === 0 ? CATEGORIES.hardware : CATEGORIES.software,
        isPublished: i % 10 !== 0,
      };
    }),
  ].map((article) => ({ ...article, createdAt: date, updatedAt: date }));
}

export async function seedSearchEvaluationCorpus(
  prisma: PrismaClient,
  databaseUrl: string,
  background = { tickets: 0, articles: 0 },
) {
  await seedDatabase(prisma, { profile: 'test', databaseUrl });
  await prisma.$transaction([
    prisma.ticket.createMany({
      data: [
        ...tickets,
        ...Array.from({ length: background.tickets }, (_, i) => {
          const [title, description] = backgroundTopics[i % backgroundTopics.length]!;
          return {
            ...ticket,
            id: uuid('ticket', 1000 + i),
            requesterId: i % 2 === 0 ? USERS.erin : USERS.omar,
            title: `${title} case ${i + 1}`,
            description,
            categoryId: i % 3 === 0 ? CATEGORIES.hardware : CATEGORIES.network,
            assignedTeamId: i % 3 === 0 ? TEAMS.hardware : TEAMS.network,
          };
        }),
      ],
    }),
    prisma.knowledgeArticle.createMany({ data: additionalEvaluationArticles(background.articles) }),
  ]);
}

export interface EvaluationQuery {
  collection: 'tickets' | 'knowledge';
  q: string;
  user: keyof typeof USERS;
  filters?: Record<string, string>;
  relevant: readonly string[];
}

// Labels describe reader intent before either engine runs. Similar terms alone are not relevant.
export const searchEvaluationQueries: readonly EvaluationQuery[] = [
  {
    collection: 'tickets',
    q: 'VPN',
    user: 'erin',
    relevant: [TICKETS.vpn, evaluationTickets.network, TICKETS.token],
  },
  {
    collection: 'tickets',
    q: 'vnp',
    user: 'erin',
    relevant: [TICKETS.vpn, evaluationTickets.network, TICKETS.token],
  },
  { collection: 'tickets', q: 'pritner', user: 'erin', relevant: [TICKETS.printer] },
  {
    collection: 'tickets',
    q: 'wired ethernet',
    user: 'erin',
    relevant: [evaluationTickets.ethernet],
  },
  {
    collection: 'tickets',
    q: 'spreadsheet add-in',
    user: 'tara',
    filters: { status: 'OPEN' },
    relevant: [TICKETS.reopened],
  },
  {
    collection: 'tickets',
    q: 'software licence',
    user: 'tara',
    filters: { teamId: TEAMS.network },
    relevant: [TICKETS.license],
  },
  {
    collection: 'tickets',
    q: 'relaycase',
    user: 'tom',
    relevant: [evaluationTickets.network, evaluationTickets.hardware, evaluationTickets.unassigned],
  },
  { collection: 'tickets', q: 'monitor flickers', user: 'omar', relevant: [TICKETS.monitor] },
  {
    collection: 'knowledge',
    q: 'VPN',
    user: 'erin',
    relevant: [ARTICLES.vpn, evaluationArticles.network],
  },
  {
    collection: 'knowledge',
    q: 'vnp',
    user: 'erin',
    relevant: [ARTICLES.vpn, evaluationArticles.network],
  },
  { collection: 'knowledge', q: 'pritner', user: 'erin', relevant: [ARTICLES.printer] },
  {
    collection: 'knowledge',
    q: 'wired ethernet',
    user: 'omar',
    relevant: [evaluationArticles.ethernet],
  },
  {
    collection: 'knowledge',
    q: 'relaycase',
    user: 'tara',
    filters: { categoryId: CATEGORIES.network },
    relevant: [evaluationArticles.network],
  },
  { collection: 'knowledge', q: 'password reset', user: 'erin', relevant: [ARTICLES.password] },
  { collection: 'knowledge', q: 'software licence', user: 'tom', relevant: [ARTICLES.software] },
  {
    collection: 'knowledge',
    q: 'wireless waking',
    user: 'admin',
    relevant: [evaluationArticles.wireless],
  },
];
