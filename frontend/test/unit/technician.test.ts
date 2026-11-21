import { describe, expect, it, vi } from 'vitest';
import type { TicketTimelineEntry } from '@smartdesk/contracts';
import { ApiError, NetworkError, type ApiClient } from '../../src/lib/auth/client';
import { technicianApi } from '../../src/lib/technician/api';
import {
  canRoute,
  describeStaffEvent,
  describeTriageError,
  formatAge,
  statusActions,
  transitionRequest,
} from '../../src/lib/technician/format';

describe('formatAge', () => {
  it.each([
    [0, '0 min'],
    [-5, '0 min'],
    [59.4, '59 min'],
    [60, '1 h'],
    [200, '3 h 20 min'],
    [24 * 60, '1 d'],
    [2 * 24 * 60 + 4 * 60 + 30, '2 d 4 h'],
  ])('%s minutes -> %s', (minutes, text) => {
    expect(formatAge(minutes)).toBe(text);
  });
});

describe('status actions follow the backend workflow', () => {
  it('offers exactly the legal next steps', () => {
    expect(statusActions('OPEN')).toEqual([]);
    expect(statusActions('TRIAGED').map((a) => a.to)).toEqual(['IN_PROGRESS']);
    expect(statusActions('IN_PROGRESS').map((a) => a.to)).toEqual(['RESOLVED']);
    expect(statusActions('RESOLVED').map((a) => a.to)).toEqual(['CLOSED', 'OPEN']);
    expect(statusActions('CLOSED').map((a) => a.to)).toEqual(['OPEN']);
  });

  it('requires a summary only to resolve', () => {
    const needs = (['OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const).flatMap((s) =>
      statusActions(s).filter((a) => a.needsSummary),
    );
    expect(needs.map((a) => a.to)).toEqual(['RESOLVED']);
  });

  it('allows re-routing only while unresolved', () => {
    expect(['OPEN', 'TRIAGED', 'IN_PROGRESS'].every((s) => canRoute(s as never))).toBe(true);
    expect(canRoute('RESOLVED')).toBe(false);
    expect(canRoute('CLOSED')).toBe(false);
  });

  it('sends the version and a trimmed summary only when resolving', () => {
    const [resolve] = statusActions('IN_PROGRESS');
    expect(transitionRequest(resolve!, 4, '  Fixed it  ')).toEqual({
      to: 'RESOLVED',
      expectedVersion: 4,
      resolutionSummary: 'Fixed it',
    });
    const [start] = statusActions('TRIAGED');
    expect(transitionRequest(start!, 2, 'ignored')).toEqual({
      to: 'IN_PROGRESS',
      expectedVersion: 2,
    });
  });
});

describe('describeTriageError', () => {
  it('recognises a version conflict by its machine-readable code', () => {
    const err = new ApiError(409, 'Ticket was changed', { code: 'VERSION_CONFLICT' });
    expect(describeTriageError(err).kind).toBe('conflict');
  });

  it('does not treat other 409s as a reload-worthy conflict', () => {
    const err = new ApiError(409, 'A RESOLVED ticket cannot move to TRIAGED', {
      code: 'INVALID_TRANSITION',
    });
    expect(describeTriageError(err)).toEqual({
      kind: 'validation',
      message: 'A RESOLVED ticket cannot move to TRIAGED',
    });
  });

  it.each([
    [new ApiError(422, 'Category is unknown or inactive'), 'validation'],
    [new ApiError(400, 'Validation failed'), 'validation'],
    [new ApiError(403, 'no'), 'forbidden'],
    [new ApiError(404, 'no'), 'gone'],
    [new NetworkError(), 'network'],
    [new ApiError(500, 'boom'), 'other'],
    [new Error('x'), 'other'],
  ])('maps %# to %s', (err, kind) => {
    expect(describeTriageError(err).kind).toBe(kind);
  });

  it('never echoes server internals for unexpected failures', () => {
    expect(describeTriageError(new ApiError(500, 'SELECT * FROM tickets')).message).not.toMatch(
      /SELECT/,
    );
  });
});

describe('describeStaffEvent', () => {
  const entry = (over: Partial<TicketTimelineEntry>): TicketTimelineEntry => ({
    id: 'e',
    type: 'CREATED',
    occurredAt: '2026-03-01T00:00:00Z',
    actor: { id: 'u', name: 'Tara' },
    details: null,
    ...over,
  });

  it('names the actor, and falls back to System', () => {
    expect(describeStaffEvent(entry({ type: 'RESOLVED' }))).toBe('Tara resolved the ticket');
    expect(describeStaffEvent(entry({ type: 'RESOLVED', actor: null }))).toBe(
      'System resolved the ticket',
    );
  });

  it('distinguishes internal notes from replies', () => {
    expect(
      describeStaffEvent(entry({ type: 'COMMENT_ADDED', details: { isInternal: true } })),
    ).toBe('Tara added an internal note');
    expect(
      describeStaffEvent(entry({ type: 'COMMENT_ADDED', details: { isInternal: false } })),
    ).toBe('Tara replied');
  });

  it('tells first assignment from reassignment', () => {
    expect(describeStaffEvent(entry({ type: 'TEAM_ASSIGNED' }))).toContain(
      'assigned a support team',
    );
    expect(describeStaffEvent(entry({ type: 'TEAM_REASSIGNED' }))).toContain('another team');
  });
});

describe('technicianApi', () => {
  function fake() {
    const request = vi.fn().mockResolvedValue({});
    return { request, api: technicianApi({ request } as unknown as ApiClient) };
  }

  it('builds a scoped, filtered team queue request', async () => {
    const { request, api } = fake();
    await api.teamQueue('t1', {
      priority: ['CRITICAL', 'HIGH'],
      categoryId: 'c1',
      mine: true,
      limit: 10,
      offset: 20,
    });
    const url = new URL(`http://x${request.mock.calls[0]![0] as string}`);
    expect(url.pathname).toBe('/api/technician/queue');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      teamId: 't1',
      priority: 'CRITICAL,HIGH',
      categoryId: 'c1',
      mine: 'true',
      limit: '10',
      offset: '20',
    });
  });

  it('omits empty filters and offset zero', async () => {
    const { request, api } = fake();
    await api.unassigned({ priority: [], limit: 10, offset: 0 });
    expect(request).toHaveBeenCalledWith('/api/technician/unassigned?limit=10');
  });

  it('posts routing and transitions with the version', async () => {
    const { request, api } = fake();
    await api.approveRouting('a/b', {
      categoryId: 'c',
      priority: 'HIGH',
      teamId: 't',
      assigneeId: null,
      expectedVersion: 3,
    });
    const [path, init] = request.mock.calls[0]! as [string, RequestInit];
    expect(path).toBe('/api/tickets/a%2Fb/routing');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ expectedVersion: 3, assigneeId: null });
  });
});
