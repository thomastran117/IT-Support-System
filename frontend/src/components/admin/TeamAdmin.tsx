'use client';

import type { AdminTeamDto, AdminTeamMemberDto } from '@smartdesk/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Notice } from '@/components/ui';
import { catalogApi, describeCatalogError } from '@/lib/admin/catalogApi';
import { useAuth } from '@/lib/auth/AuthProvider';
import { inputClass, primaryButton } from '../tickets/ui';
import { CatalogManager } from './CatalogManager';
import { smallButton } from './catalogParts';

export function TeamAdmin() {
  const { api } = useAuth();
  const catalog = useMemo(() => catalogApi(api), [api]);
  return (
    <CatalogManager<AdminTeamDto>
      noun="team"
      plural="teams"
      load={catalog.teams}
      create={catalog.createTeam}
      update={catalog.updateTeam}
      setActive={catalog.setTeamActive}
      meta={(t) => `${t.memberCount} ${t.memberCount === 1 ? 'member' : 'members'}`}
      deactivationEffects={(t) => (
        <>
          <p>
            It will no longer be offered when tickets are routed, and nobody can be added to it.
            Members stay on it.
          </p>
          <p className="mt-1">
            The {t.ticketCount} {t.ticketCount === 1 ? 'ticket' : 'tickets'} already assigned to it
            keep it as their team, so history and reports still resolve it. You can reactivate it at
            any time.
          </p>
        </>
      )}
      renderExtra={(team, reload) => <Members team={team} onChanged={reload} />}
    />
  );
}

function Members({ team, onChanged }: { team: AdminTeamDto; onChanged: () => Promise<void> }) {
  const { api } = useAuth();
  const catalog = useMemo(() => catalogApi(api), [api]);
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<AdminTeamMemberDto[] | null>(null);
  const [technicians, setTechnicians] = useState<{ id: string; displayName: string }[]>([]);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, techs] = await Promise.all([catalog.members(team.id), catalog.technicians()]);
      setMembers(list);
      setTechnicians(techs.items.map((u) => ({ id: u.id, displayName: u.displayName })));
      setError(null);
    } catch (err) {
      setError(describeCatalogError(err));
    }
  }, [catalog, team.id]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const change = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setChoice('');
      await refresh();
      await onChanged();
    } catch (err) {
      setError(describeCatalogError(err));
    } finally {
      setBusy(false);
    }
  };

  const memberIds = new Set((members ?? []).map((m) => m.id));
  const candidates = technicians.filter((t) => !memberIds.has(t.id));
  const panelId = `members-${team.id}`;

  return (
    <div>
      <button
        type="button"
        className={smallButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? 'Hide' : 'Manage'} members of ${team.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide members' : 'Manage members'}
      </button>
      {open && (
        <div id={panelId} className="mt-3 space-y-3 border-t border-line pt-3">
          {error && (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          )}
          {members === null ? (
            <p role="status" className="text-sm text-muted">
              Loading members…
            </p>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted">No members yet.</p>
          ) : (
            <ul className="divide-y divide-line" aria-label={`Members of ${team.name}`}>
              {members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-sm">
                    <span className="font-medium">{m.displayName}</span>{' '}
                    <span className="text-muted">
                      {m.email}
                      {!m.isActive ? ' (inactive account)' : ''} · {m.assignedTicketCount} assigned
                    </span>
                  </span>
                  <button
                    type="button"
                    className={smallButton}
                    aria-label={`Remove ${m.displayName} from ${team.name}`}
                    disabled={busy}
                    onClick={() => void change(() => catalog.removeMember(team.id, m.id))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {team.isActive ? (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label
                  htmlFor={`add-member-${team.id}`}
                  className="mb-1 block text-sm font-medium text-muted-strong"
                >
                  Add a technician
                </label>
                <select
                  id={`add-member-${team.id}`}
                  className={inputClass}
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {candidates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className={primaryButton}
                disabled={busy || !choice}
                onClick={() => void change(() => catalog.addMember(team.id, choice))}
              >
                Add to team
              </button>
            </div>
          ) : (
            <p className="text-sm text-muted">
              Reactivate the team to add members. Existing members can still be removed.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
