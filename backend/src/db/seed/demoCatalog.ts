import type { Prisma } from '@smartdesk/db';
import { at, CATEGORIES, TEAMS, USERS, uuid } from './fixtures.js';

const rosterDate = at('2025-01-01T09:00:00Z');

const employeeNames = [
  'Maya Chen',
  'Leo Bernard',
  'Priya Shah',
  'Sam Rivera',
  'Nora Ellis',
  'Mateo Cruz',
  'Sofia Laurent',
  'Elliot Park',
  'Amira Haddad',
  'Noah Patel',
  'Avery Brooks',
  'Inez Costa',
  'Asha Raman',
  'Lucas Roy',
  'Tessa Bell',
  'Malik Reed',
  'Zoe Martin',
  'Nico Wells',
  'Lina Moreau',
  'Dev Singh',
  'Ellis Grant',
  'Mina Santos',
  'Jules Kim',
  'Remy Clarke',
];
const technicianNames = [
  'Ada Morgan',
  'Jalen Foster',
  'Reese Wong',
  'Mira Desai',
  'Ari Nguyen',
  'June Taylor',
  'Robin Baker',
  'Dani Silva',
];

function demoUsers(names: string[], role: 'EMPLOYEE' | 'TECHNICIAN', start: number) {
  return names.map((displayName, index) => ({
    id: uuid('user', start + index),
    email: `${displayName.toLowerCase().replace(' ', '.')}@smartdesk.test`,
    displayName,
    role,
    createdAt: rosterDate,
  }));
}

export const demoEmployees = demoUsers(employeeNames, 'EMPLOYEE', 100);
const technicians = demoUsers(technicianNames, 'TECHNICIAN', 200);

const software = uuid('team', 100);
const identity = uuid('team', 101);
const collaboration = uuid('team', 102);
const business = uuid('team', 103);

const collaborationCategory = uuid('category', 100);
const securityCategory = uuid('category', 101);
const businessCategory = uuid('category', 102);
const printingCategory = uuid('category', 103);

export const demoRoster = {
  users: [...demoEmployees, ...technicians],
  teams: [
    {
      id: software,
      name: 'Software & Productivity',
      description: 'Desktop applications and licensing',
    },
    {
      id: identity,
      name: 'Identity & Security',
      description: 'Sign-in, permissions, and device security',
    },
    {
      id: collaboration,
      name: 'Collaboration & AV',
      description: 'Meeting spaces, chat, and shared workspaces',
    },
    {
      id: business,
      name: 'Business Applications',
      description: 'Finance, service portals, and integrations',
    },
  ],
  categories: [
    {
      id: collaborationCategory,
      name: 'Collaboration & Meetings',
      description: 'Video calls, room equipment, and workspaces',
    },
    {
      id: securityCategory,
      name: 'Device Security',
      description: 'Device enrollment, updates, and compliance',
    },
    {
      id: businessCategory,
      name: 'Business Applications',
      description: 'Approvals, expenses, and data integrations',
    },
    {
      id: printingCategory,
      name: 'Printing & Scanning',
      description: 'Print queues, secure release, and scanners',
    },
  ].map((category) => ({ ...category, createdAt: rosterDate })),
  teamMembers: [software, identity, collaboration, business].flatMap((teamId, index) =>
    technicians.slice(index * 2, index * 2 + 2).map(({ id }) => ({
      teamId,
      userId: id,
      joinedAt: rosterDate,
    })),
  ),
};

export const staffByTeam: Record<string, readonly string[]> = {
  [TEAMS.network]: [USERS.tara, USERS.tom],
  [TEAMS.hardware]: [USERS.hana, USERS.tom],
  ...Object.fromEntries(
    demoRoster.teams.map(({ id }) => [
      id,
      demoRoster.teamMembers.filter((member) => member.teamId === id).map(({ userId }) => userId),
    ]),
  ),
};

interface Scenario {
  key: number;
  teamId: string;
  categoryId: string;
  title: string;
  symptom: string;
  reply: string;
  resolution: string;
  articleTitle: string;
  steps: string[];
}

export const scenarios: Scenario[] = [
  {
    key: 0,
    teamId: TEAMS.network,
    categoryId: CATEGORIES.network,
    title: 'VPN disconnects after waking the laptop',
    symptom: 'The VPN reconnects on wake, then drops during the first request to a shared drive.',
    reply: 'Please note the disconnect time and whether it follows sleep or a network change.',
    resolution:
      'Updated the managed VPN client and confirmed the connection survived a sleep cycle.',
    articleTitle: 'Troubleshoot VPN disconnects after sleep',
    steps: [
      'Reconnect the VPN after the device wakes and confirm the network is stable.',
      'Record the disconnect time and client version for Support if it happens again.',
    ],
  },
  {
    key: 1,
    teamId: TEAMS.network,
    categoryId: CATEGORIES.network,
    title: 'Office Wi-Fi takes several attempts to connect',
    symptom:
      'The corporate network shows full signal but leaves the laptop waiting for an address.',
    reply: 'Please send the building and floor so we can compare access-point logs.',
    resolution:
      'Corrected the affected access-point profile and verified the laptop obtained an address.',
    articleTitle: 'Collect diagnostics for corporate Wi-Fi',
    steps: [
      'Record the network name, building, floor, and approximate time.',
      'Compare with another managed device in the same location and share the result with Support.',
    ],
  },
  {
    key: 2,
    teamId: TEAMS.network,
    categoryId: CATEGORIES.network,
    title: 'Internal sites fail to load over the VPN',
    symptom:
      'Public websites load normally, but the intranet hostname cannot be resolved over the VPN.',
    reply:
      'Please include the failing hostname and whether the same page works on the office network.',
    resolution:
      'Corrected the managed DNS profile and confirmed the intranet hostname resolves remotely.',
    articleTitle: 'Check access to internal sites from home',
    steps: [
      'Confirm the VPN shows as connected before opening the intranet.',
      'Send Support the failing hostname and the time of the last attempt.',
    ],
  },
  {
    key: 3,
    teamId: TEAMS.hardware,
    categoryId: CATEGORIES.hardware,
    title: 'USB-C dock loses the second display',
    symptom: 'The external screen goes dark while charging and the other screen continue to work.',
    reply: 'Please tell us which dock port and cable are in use when the screen drops.',
    resolution: 'Replaced the display cable and tested both monitors through the dock.',
    articleTitle: 'Isolate an external display problem on a USB-C dock',
    steps: [
      'Connect one monitor directly and check whether it remains stable.',
      'Reconnect the dock with an approved cable and record which port reproduces the issue.',
    ],
  },
  {
    key: 4,
    teamId: TEAMS.hardware,
    categoryId: printingCategory,
    title: 'Secure print job is missing at the release station',
    symptom:
      'The print dialog confirms the job, but the badge reader does not show it in the release list.',
    reply: 'Please send the selected queue name and the time you submitted a test page.',
    resolution: 'Reconnected the secure print queue and released a successful test page.',
    articleTitle: 'Release a job from the secure print queue',
    steps: [
      'Select the secure print queue and submit a one-page test document.',
      'Tap your badge at the release station and check the queue before resubmitting.',
    ],
  },
  {
    key: 5,
    teamId: TEAMS.hardware,
    categoryId: printingCategory,
    title: 'Scanner fails to deliver PDFs to the shared folder',
    symptom:
      'The scanner accepts the document, but the PDF never appears in the destination folder.',
    reply: 'Please send the scanner name and the destination shown on its screen.',
    resolution:
      'Updated the scanner destination and confirmed a test scan reached the shared folder.',
    articleTitle: 'Verify a scan-to-folder destination',
    steps: [
      'Confirm the destination shown on the scanner matches the current shared folder.',
      'Send a one-page test and include the timestamp if the file never appears.',
    ],
  },
  {
    key: 6,
    teamId: software,
    categoryId: CATEGORIES.software,
    title: 'PDF editor asks for a license again',
    symptom:
      'The approved PDF editor starts in viewer mode and reports that the license cannot be validated.',
    reply: 'Please confirm the signed-in work account and the version shown in the About screen.',
    resolution: 'Reassigned the existing license and verified that editing tools were available.',
    articleTitle: 'Restore a managed PDF editor license',
    steps: [
      'Check that the editor is signed in with your work account.',
      'Send the application version to Support if editing stays disabled after reopening.',
    ],
  },
  {
    key: 7,
    teamId: software,
    categoryId: CATEGORIES.software,
    title: 'Spreadsheet add-in is disabled after an update',
    symptom:
      'The spreadsheet opens normally, but the reporting add-in no longer appears on the ribbon.',
    reply: 'Please check the add-ins list and send us the application build number.',
    resolution: 'Deployed the compatible add-in build and verified it loads in a new workbook.',
    articleTitle: 'Check the status of a managed spreadsheet add-in',
    steps: [
      'Open the application add-ins settings and look for the managed add-in.',
      'Record the application build and whether the add-in is missing or disabled.',
    ],
  },
  {
    key: 8,
    teamId: software,
    categoryId: CATEGORIES.software,
    title: 'Approved desktop app is missing from the company portal',
    symptom:
      'The installation guide lists the app, but it does not appear in the managed software catalog.',
    reply: 'Please send the requested app name and the device name shown by the company portal.',
    resolution: 'Corrected the catalog assignment and confirmed the approved app became available.',
    articleTitle: 'Find and install approved desktop applications',
    steps: [
      'Refresh the managed software catalog while signed in to your work account.',
      'Send the missing app name and managed device name to Support if it still does not appear.',
    ],
  },
  {
    key: 9,
    teamId: identity,
    categoryId: CATEGORIES.access,
    title: 'Replacement phone cannot receive sign-in prompts',
    symptom: 'Work sign-in still sends the approval prompt to a phone that was replaced.',
    reply: 'Please let us know whether an alternate sign-in method is available on your account.',
    resolution:
      'Verified the requester, retired the old device registration, and confirmed the new phone received a prompt.',
    articleTitle: 'Prepare for multi-factor sign-in on a replacement phone',
    steps: [
      'Check for an alternate approved sign-in method before retiring the old phone.',
      'Contact Support for identity verification if you can no longer use any registered method.',
    ],
  },
  {
    key: 10,
    teamId: identity,
    categoryId: securityCategory,
    title: 'Managed laptop is marked out of compliance',
    symptom:
      'The device security dashboard reports overdue updates even after restarting the laptop.',
    reply: 'Please send the compliance status and the last successful device check-in time.',
    resolution:
      'Completed the pending managed update and verified that the device passed its compliance check.',
    articleTitle: 'Check managed device compliance after an update',
    steps: [
      'Install pending managed updates and restart the device.',
      'Open the device portal, sync its status, and send Support the last check-in time if the alert persists.',
    ],
  },
  {
    key: 11,
    teamId: identity,
    categoryId: CATEGORIES.access,
    title: 'Shared folder access is missing after a team transfer',
    symptom:
      'The folder is visible in the directory, but opening a document returns a permission error.',
    reply:
      'Please send the folder path and the name of the team that owns it so we can verify approval.',
    resolution: 'Applied the approved group membership and verified the requested read access.',
    articleTitle: 'Request access to a shared folder after changing teams',
    steps: [
      'Record the folder path and identify its owning team.',
      'Request the minimum access you need and attach the owner’s approval to the ticket.',
    ],
  },
  {
    key: 12,
    teamId: collaboration,
    categoryId: collaborationCategory,
    title: 'Meeting room microphone is silent on calls',
    symptom:
      'Remote participants can hear audio from a laptop, but the room microphone never registers input.',
    reply: 'Please send the room name and which microphone appears selected on the room console.',
    resolution: 'Restored the room microphone as the default input and verified it on a test call.',
    articleTitle: 'Check microphone input in a meeting room',
    steps: [
      'Check the room console for mute and confirm the room microphone is selected.',
      'Run a short test call and record which input devices are visible.',
    ],
  },
  {
    key: 13,
    teamId: collaboration,
    categoryId: collaborationCategory,
    title: 'Shared calendar does not show room availability',
    symptom:
      'A room appears in the booking picker, but its calendar cannot display free or busy times.',
    reply: 'Please send the room name and whether availability is missing in the web client too.',
    resolution:
      'Repaired the room calendar permissions and confirmed free-busy information appears.',
    articleTitle: 'Check room availability in the booking calendar',
    steps: [
      'Find the room in the web booking picker and compare its availability to the desktop client.',
      'Include the room name and affected dates when reporting a mismatch.',
    ],
  },
  {
    key: 14,
    teamId: collaboration,
    categoryId: collaborationCategory,
    title: 'Shared workspace invite opens the wrong account',
    symptom: 'The invite opens in a personal browser profile and shows a blank workspace.',
    reply:
      'Please try the link in your work browser profile and confirm which account is displayed.',
    resolution: 'Reissued the invite for the correct work account and verified workspace access.',
    articleTitle: 'Open a workspace invite with the correct account',
    steps: [
      'Open the invite from your work browser profile.',
      'Compare the account shown in the workspace with the address that received the invitation.',
    ],
  },
  {
    key: 15,
    teamId: business,
    categoryId: businessCategory,
    title: 'Expense report is stuck in the approval queue',
    symptom:
      'The expense portal shows the report as submitted, but it never arrives in the approver’s inbox.',
    reply:
      'Please send the report reference and the displayed approval stage, without including receipt images.',
    resolution:
      'Repaired the approval assignment and verified the report reached the expected approver.',
    articleTitle: 'Find the approval stage for an expense report',
    steps: [
      'Open the report history and record its reference and current approval stage.',
      'Include the stage and submission time when contacting Support.',
    ],
  },
  {
    key: 16,
    teamId: business,
    categoryId: businessCategory,
    title: 'Scheduled reporting export is out of date',
    symptom:
      'The exported file opens correctly but still contains records from a previous business day.',
    reply: 'Please send the report name and the last successful run time shown by the portal.',
    resolution:
      'Restarted the scheduled export after validating the source and confirmed the latest records were present.',
    articleTitle: 'Verify the freshness of a scheduled export',
    steps: [
      'Compare the data date in the export with the latest successful run in the portal.',
      'Send the report name and both dates to Support if the export is stale.',
    ],
  },
  {
    key: 17,
    teamId: business,
    categoryId: businessCategory,
    title: 'Internal purchase request fails validation',
    symptom:
      'The purchasing form allows the draft to be saved but rejects it when sent for approval.',
    reply: 'Please send the draft reference and the validation message displayed on submission.',
    resolution:
      'Corrected the cost-centre mapping and confirmed the request could be submitted for approval.',
    articleTitle: 'Check a purchase request before submission',
    steps: [
      'Verify the cost centre and required fields against your approved purchase details.',
      'Send the draft reference and validation message if submission continues to fail.',
    ],
  },
];

export const scenarioArticleId = (key: number) => uuid('article', 100 + key);
export const diagnosticArticleId = uuid('article', 200);

export function buildDemoArticles(date: Date): Prisma.KnowledgeArticleCreateManyInput[] {
  return [
    ...scenarios.map((scenario) => ({
      id: scenarioArticleId(scenario.key),
      title: scenario.articleTitle,
      categoryId: scenario.categoryId,
      body: `## What to check\n\n${scenario.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
      isPublished: true,
    })),
    {
      id: diagnosticArticleId,
      title: 'What to include in a support ticket',
      body: 'Describe the task, the error that appeared, when it started, and who is affected. Include the device or application name and the result of any steps you have already tried.',
      isPublished: true,
    },
    {
      id: uuid('article', 201),
      title: 'Set up a managed laptop for a new starter',
      categoryId: CATEGORIES.hardware,
      body: 'Connect the laptop to an approved network, sign in with the new work account, and wait for the managed applications to install. Confirm that email and the company portal open before handing over the device.',
      isPublished: true,
    },
    {
      id: uuid('article', 202),
      title: 'Verify dock firmware during a device refresh',
      categoryId: CATEGORIES.hardware,
      body: 'Confirm the supported dock models and collect the firmware version currently installed before a refresh.',
      isPublished: false,
    },
    {
      id: uuid('article', 203),
      title: 'Review retention for inactive shared workspaces',
      categoryId: collaborationCategory,
      body: 'Confirm the workspace owner and keep a record of the files they want to retain before archiving.',
      isPublished: false,
    },
    {
      id: uuid('article', 204),
      title: 'Prepare a fallback approver for quarter end',
      categoryId: businessCategory,
      body: 'Ask the department lead to nominate a backup approver and verify the date on which delegation should start.',
      isPublished: false,
    },
    {
      id: uuid('article', 205),
      title: 'Verify device enrollment after a repair',
      categoryId: securityCategory,
      body: 'Check device ownership and enrollment status after a storage or mainboard replacement.',
      isPublished: false,
    },
  ].map((article) => ({ ...article, createdAt: date, updatedAt: date }));
}
