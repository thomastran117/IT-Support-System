import { createHash } from 'node:crypto';

/**
 * Version-controlled evaluation dataset for category classification (SD-039).
 *
 * - Every ticket is SYNTHETIC. No real people, systems, hostnames or credentials appear here.
 * - `reference` is the evaluator's own label, written by hand with a one-line `rationale`. It is
 *   independent of any model: nothing in this module reads a model prediction, and the harness never
 *   hands a label to a provider (see `run.ts`). Labels must never be generated or "fixed up" from AI output.
 * - Changing any case, label or category list changes `datasetHash()`. Bump `DATASET_VERSION`
 *   whenever you do, so a report always names the exact data it measured.
 *
 * The ids below belong to this harness only (they are not database ids), so the evaluation runs
 * with no database. The names match the categories and teams in the seed data.
 */
export const DATASET_VERSION = '1.0.0';

export interface EvalRef {
  id: string;
  name: string;
}

const id = (kind: 'c' | 't', n: number) =>
  `e${kind === 'c' ? '0' : '1'}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const EVAL_CATEGORIES: readonly EvalRef[] = [
  { id: id('c', 1), name: 'Hardware' },
  { id: id('c', 2), name: 'Software' },
  { id: id('c', 3), name: 'Network/VPN' },
  { id: id('c', 4), name: 'Access/Accounts' },
];

export const EVAL_TEAMS: readonly EvalRef[] = [
  { id: id('t', 1), name: 'Network & Access' },
  { id: id('t', 2), name: 'Hardware & Devices' },
];

/** Teams that are acceptable for a category (a secondary check; the headline metric is category). */
export const ALLOWED_TEAMS_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {
  Hardware: ['Hardware & Devices'],
  Software: ['Hardware & Devices', 'Network & Access'],
  'Network/VPN': ['Network & Access'],
  'Access/Accounts': ['Network & Access'],
};

export type CategoryName = 'Hardware' | 'Software' | 'Network/VPN' | 'Access/Accounts';

export interface EvalCase {
  id: string;
  title: string;
  description: string;
  /** The evaluator's reference category. Never derived from AI output. */
  reference: CategoryName;
  /** Why the evaluator chose it; mandatory for the ambiguous cases. */
  rationale: string;
}

const c = (
  n: number,
  reference: CategoryName,
  title: string,
  description: string,
  rationale: string,
): EvalCase => ({
  id: `EV-${String(n).padStart(3, '0')}`,
  title,
  description,
  reference,
  rationale,
});

export const EVAL_CASES: readonly EvalCase[] = [
  // --- Hardware ---------------------------------------------------------------------------
  c(
    1,
    'Hardware',
    'Laptop will not power on',
    'My work laptop does not turn on even when plugged in. The charging light stays off.',
    'Physical device fault.',
  ),
  c(
    2,
    'Hardware',
    'Printer shows paper jam',
    'The third floor printer says paper jam but I removed all the paper. Print jobs are stuck.',
    'Printer is a physical device.',
  ),
  c(
    3,
    'Hardware',
    'Second monitor flickers',
    'My external monitor flickers every few minutes. Swapping the cable did not help.',
    'Display hardware.',
  ),
  c(
    4,
    'Hardware',
    'Keyboard keys not responding',
    'Several keys on my keyboard stopped working after I spilled water on it.',
    'Peripheral damage.',
  ),
  c(
    5,
    'Hardware',
    'Docking station not charging',
    'The docking station no longer charges my laptop or detects the monitors.',
    'Dock is a hardware accessory.',
  ),
  c(
    6,
    'Hardware',
    'Mouse cursor jumps',
    'The wireless mouse moves erratically. I replaced the battery already.',
    'Peripheral fault.',
  ),
  c(
    7,
    'Hardware',
    'Laptop battery drains in an hour',
    'My laptop battery only lasts about an hour and the case feels hot.',
    'Battery hardware wear.',
  ),
  c(
    8,
    'Hardware',
    'Headset has no microphone',
    'My USB headset plays sound but nobody can hear me. It worked last week on another desk.',
    'Faulty device; same headset worked elsewhere, so not a software setting.',
  ),
  c(
    9,
    'Hardware',
    'Webcam shows black screen',
    'The built-in camera is black in every video call. The lens looks cracked.',
    'Cracked lens points to hardware.',
  ),
  c(
    10,
    'Hardware',
    'Desk phone has no dial tone',
    'The handset on my desk phone is dead. I checked the cable at both ends.',
    'Telephone hardware.',
  ),
  // --- Software ---------------------------------------------------------------------------
  c(
    11,
    'Software',
    'Need a licence for design tool',
    'I need a licence for the design application to finish a project this week.',
    'Application licensing.',
  ),
  c(
    12,
    'Software',
    'Spreadsheet crashes on open',
    'The spreadsheet application closes immediately when I open the quarterly report file.',
    'Application crash.',
  ),
  c(
    13,
    'Software',
    'Install the accounting package',
    'Please install the accounting package on my machine. My manager approved it.',
    'Software installation request.',
  ),
  c(
    14,
    'Software',
    'Email client will not sync',
    'My email application shows a sync error and has not received new messages since morning.',
    'Client application fault (account and network are fine).',
  ),
  c(
    15,
    'Software',
    'Update fails with error code',
    'The operating system update fails at 40 percent and rolls back every night.',
    'Operating system update failure.',
  ),
  c(
    16,
    'Software',
    'PDF editor asks to activate',
    'The PDF editor says the trial has expired and asks me to activate it.',
    'Application activation.',
  ),
  c(
    17,
    'Software',
    'Browser extension broke the intranet',
    'After adding a browser extension the intranet pages are blank. Removing it fixes it.',
    'Browser software issue.',
  ),
  c(
    18,
    'Software',
    'Video call app has no audio',
    'The conferencing application shows no audio devices even though my speakers work in other programs.',
    'Application configuration.',
  ),
  c(
    19,
    'Software',
    'Antivirus scan will not finish',
    'The endpoint security scan has been running for two days at the same percentage.',
    'Security software behaviour.',
  ),
  c(
    20,
    'Software',
    'Macro in report stopped working',
    'The macro that builds our monthly report now returns a type mismatch error.',
    'Office application scripting.',
  ),
  // --- Network/VPN ------------------------------------------------------------------------
  c(
    21,
    'Network/VPN',
    'VPN disconnects every hour',
    'The VPN drops about once an hour and I have to reconnect.',
    'VPN connectivity.',
  ),
  c(
    22,
    'Network/VPN',
    'Wi-Fi unstable in meeting rooms',
    'The wireless network keeps dropping in the second floor meeting rooms during calls.',
    'Wireless connectivity.',
  ),
  c(
    23,
    'Network/VPN',
    'No network at my desk',
    'The wired network port at my desk gives no connection. Other desks work.',
    'Wired network port.',
  ),
  c(
    24,
    'Network/VPN',
    'Cannot reach internal file share',
    'I can browse the internet but the shared drive path times out from the office network.',
    'Network path to a service.',
  ),
  c(
    25,
    'Network/VPN',
    'Very slow internet',
    'Pages take a minute to load for everyone on the fourth floor since this morning.',
    'Site connectivity affecting a group.',
  ),
  c(
    26,
    'Network/VPN',
    'VPN client stuck connecting',
    'The VPN client sits on connecting and never completes from my home network.',
    'VPN client connectivity.',
  ),
  c(
    27,
    'Network/VPN',
    'Guest Wi-Fi not working',
    'Visitors cannot join the guest wireless network, it asks for a portal page that never loads.',
    'Wireless network.',
  ),
  c(
    28,
    'Network/VPN',
    'DNS name will not resolve',
    'The internal wiki name does not resolve on my laptop but the IP address works.',
    'Name resolution.',
  ),
  c(
    29,
    'Network/VPN',
    'Remote desktop cannot connect',
    'I cannot reach my office desktop with remote desktop from home. It times out.',
    'Remote connectivity; the desktop itself is on.',
  ),
  c(
    30,
    'Network/VPN',
    'Video calls drop with packet loss',
    'Calls freeze for several seconds. A speed test shows large packet loss on the office network.',
    'Network quality.',
  ),
  // --- Access/Accounts --------------------------------------------------------------------
  c(
    31,
    'Access/Accounts',
    'Forgot my password',
    'I forgot my account password and need it reset so I can sign in.',
    'Password reset.',
  ),
  c(
    32,
    'Access/Accounts',
    'Account locked after attempts',
    'My account is locked after too many failed sign in attempts.',
    'Account lockout.',
  ),
  c(
    33,
    'Access/Accounts',
    'Need access to finance folder',
    'Please give me read access to the finance shared folder for the audit.',
    'Permission request.',
  ),
  c(
    34,
    'Access/Accounts',
    'New starter needs an account',
    'A new employee starts Monday and needs an account and a mailbox.',
    'Account creation.',
  ),
  c(
    35,
    'Access/Accounts',
    'Authenticator app on new phone',
    'I replaced my phone and cannot get verification codes any more. I need multi-factor reset.',
    'Multi-factor authentication.',
  ),
  c(
    36,
    'Access/Accounts',
    'Remove leaver access',
    'A colleague left last Friday. Please disable their account and remove their group memberships.',
    'Account deprovisioning.',
  ),
  c(
    37,
    'Access/Accounts',
    'Sign in says access denied',
    'I can sign in to the portal but every page says access denied after the team change.',
    'Authorisation after a role change.',
  ),
  c(
    38,
    'Access/Accounts',
    'Single sign-on loops',
    'Signing in sends me back to the login page again and again even though I type my details correctly.',
    'Authentication, not network: the credentials and connectivity are fine.',
  ),
  c(
    39,
    'Access/Accounts',
    'Shared mailbox permission',
    'Please add me to the support shared mailbox so I can send on its behalf.',
    'Mailbox permission.',
  ),
  c(
    40,
    'Access/Accounts',
    'Password expires too often',
    'My password expires after two weeks and I get no reminder. Can this be changed?',
    'Password policy for an account.',
  ),
];

/** Stable, order-independent description of everything that defines the dataset. */
export function datasetHash(cases: readonly EvalCase[] = EVAL_CASES): string {
  const canonical = JSON.stringify({
    categories: EVAL_CATEGORIES,
    teams: EVAL_TEAMS,
    cases: [...cases].sort((a, b) => a.id.localeCompare(b.id)),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export const categoryByName = (name: string): EvalRef => {
  const found = EVAL_CATEGORIES.find((x) => x.name === name);
  if (!found) throw new Error(`Unknown evaluation category: ${name}`);
  return found;
};
