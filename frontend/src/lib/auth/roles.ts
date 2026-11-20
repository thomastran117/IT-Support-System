import type { Role } from '@smartdesk/contracts';

/** Where each role lands after signing in, and the only portal it may use. */
export const PORTAL: Record<Role, string> = {
  EMPLOYEE: '/employee',
  TECHNICIAN: '/technician',
  ADMIN: '/admin',
};

export const portalFor = (role: Role): string => PORTAL[role];

export const ROLE_LABEL: Record<Role, string> = {
  EMPLOYEE: 'Employee',
  TECHNICIAN: 'Technician',
  ADMIN: 'Administrator',
};
