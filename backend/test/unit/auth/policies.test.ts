import { describe, expect, it } from 'vitest';
import type { Principal } from '../../../src/auth/guard.js';
import * as policy from '../../../src/auth/policies.js';
import { ticketReadFilter } from '../../../src/auth/ticketAccess.js';

const NET = 'team-network';
const HW = 'team-hardware';

const who = (id: string, role: Principal['role'], teamIds: string[] = []): Principal => ({
  id,
  email: `${id}@x.test`,
  displayName: id,
  role,
  teamIds,
});

const erin = who('erin', 'EMPLOYEE');
const omar = who('omar', 'EMPLOYEE');
const tara = who('tara', 'TECHNICIAN', [NET]);
const tom = who('tom', 'TECHNICIAN', [NET, HW]);
const hana = who('hana', 'TECHNICIAN', [HW]);
const teamless = who('teamless', 'TECHNICIAN');
const admin = who('admin', 'ADMIN');

const tickets = {
  erinUnrouted: { requesterId: 'erin', assignedTeamId: null },
  erinNetwork: { requesterId: 'erin', assignedTeamId: NET },
  omarHardware: { requesterId: 'omar', assignedTeamId: HW },
  omarUnrouted: { requesterId: 'omar', assignedTeamId: null },
  taraOwnHardware: { requesterId: 'tara', assignedTeamId: HW },
};

type Name = keyof typeof tickets;
const names = Object.keys(tickets) as Name[];

/** [principal, tickets they can read, tickets they can edit (work on)] */
const expectations: [string, Principal, Name[], Name[]][] = [
  ['erin (employee)', erin, ['erinUnrouted', 'erinNetwork'], []],
  ['omar (employee)', omar, ['omarHardware', 'omarUnrouted'], []],
  [
    'tara (network technician)',
    tara,
    ['erinUnrouted', 'erinNetwork', 'omarUnrouted', 'taraOwnHardware'],
    ['erinUnrouted', 'erinNetwork', 'omarUnrouted'],
  ],
  [
    'tom (network + hardware)',
    tom,
    ['erinUnrouted', 'erinNetwork', 'omarHardware', 'omarUnrouted', 'taraOwnHardware'],
    ['erinUnrouted', 'erinNetwork', 'omarHardware', 'omarUnrouted', 'taraOwnHardware'],
  ],
  [
    'hana (hardware technician)',
    hana,
    ['erinUnrouted', 'omarHardware', 'omarUnrouted', 'taraOwnHardware'],
    ['erinUnrouted', 'omarHardware', 'omarUnrouted', 'taraOwnHardware'],
  ],
  ['technician with no active team', teamless, [], []],
  ['admin', admin, names, names],
];

describe('ticket policies: role × ownership × team', () => {
  it.each(expectations)('%s', (_label, p, canRead, canEdit) => {
    for (const n of names) {
      expect(policy.canReadTicket(p, tickets[n]), `read ${n}`).toBe(canRead.includes(n));
      expect(policy.canEditTicket(p, tickets[n]), `edit ${n}`).toBe(canEdit.includes(n));
      expect(policy.canComment(p, tickets[n]), `comment ${n}`).toBe(canRead.includes(n));
      // Internal notes and raw audit data follow edit scope, so a requester never sees them.
      expect(policy.canSeeInternalNotes(p, tickets[n]), `notes ${n}`).toBe(canEdit.includes(n));
      expect(policy.canAuthorInternalNote(p, tickets[n]), `author note ${n}`).toBe(
        canEdit.includes(n),
      );
      expect(policy.canViewRawAudit(p, tickets[n]), `audit ${n}`).toBe(canEdit.includes(n));
    }
  });

  it('a technician who requested a ticket outside their scope can read but not edit it', () => {
    expect(policy.canReadTicket(tara, tickets.taraOwnHardware)).toBe(true);
    expect(policy.canEditTicket(tara, tickets.taraOwnHardware)).toBe(false);
  });
});

describe('administration policies', () => {
  it.each([
    ['canManageAccounts', policy.canManageAccounts],
    ['canManageClassificationLabels', policy.canManageClassificationLabels],
    ['canViewAdminAnalytics', policy.canViewAdminAnalytics],
    ['canAdminister', policy.canAdminister],
  ])('%s is admin-only', (_n, fn) => {
    expect(fn(admin)).toBe(true);
    for (const p of [erin, tara, tom, teamless]) expect(fn(p)).toBe(false);
  });

  it('only staff can triage', () => {
    expect(policy.canTriage(erin)).toBe(false);
    expect([tara, teamless, admin].map(policy.canTriage)).toEqual([true, true, true]);
  });
});

describe('ticketReadFilter', () => {
  it('is unrestricted for admins and owner-only for employees', () => {
    expect(ticketReadFilter(admin)).toEqual({});
    expect(ticketReadFilter(erin)).toEqual({ requesterId: 'erin' });
  });

  it('gives technicians their teams plus the unrouted backlog, and teamless ones only their own', () => {
    expect(ticketReadFilter(tara)).toEqual({
      OR: [{ requesterId: 'tara' }, { assignedTeamId: null }, { assignedTeamId: { in: [NET] } }],
    });
    expect(ticketReadFilter(teamless)).toEqual({ requesterId: 'teamless' });
  });
});
