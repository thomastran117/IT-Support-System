/**
 * The first public response to a ticket (SD-021), defined once.
 *
 * It is the first comment that is
 *   - public (not an internal note),
 *   - written by a technician or an administrator, and
 *   - not written by the requester (a technician answering their own ticket is not a response),
 * posted on or after the ticket was created. "First" means earliest `created_at`; comments are
 * append-only, so it never changes. It is stored as `tickets.first_response_at`. The SQL backfill in
 * migration 0006 and `backfillFirstResponse` implement the same rule.
 */
export interface FirstResponseCandidate {
  isInternal: boolean;
  authorId: string;
  authorRole: 'EMPLOYEE' | 'TECHNICIAN' | 'ADMIN';
  requesterId: string;
}

export function countsAsFirstResponse(c: FirstResponseCandidate): boolean {
  return (
    !c.isInternal &&
    c.authorId !== c.requesterId &&
    (c.authorRole === 'TECHNICIAN' || c.authorRole === 'ADMIN')
  );
}
