'use client';

import type {
  AdminAuditEntry,
  AdminUser,
  AdminUserList,
  Role,
  UserWithTemporaryPassword,
} from '@smartdesk/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ApiError, NetworkError } from '@/lib/auth/client';
import { ROLE_LABEL } from '@/lib/auth/roles';

const ROLES: Role[] = ['EMPLOYEE', 'TECHNICIAN', 'ADMIN'];
const input = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 text-base';
const smallButton =
  'rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50';

const ACTION_TEXT: Record<AdminAuditEntry['action'], string> = {
  USER_CREATED: 'created',
  USER_ACTIVATED: 'activated',
  USER_DEACTIVATED: 'deactivated',
  ROLE_CHANGED: 'changed the role of',
  PASSWORD_RESET: 'reset the password of',
};

function describeError(err: unknown): string {
  if (err instanceof NetworkError) return 'Unable to reach the server. Try again.';
  // Server messages for these endpoints are written to be shown to administrators.
  if (err instanceof ApiError && err.status < 500) return err.message;
  return 'Something went wrong. Please try again.';
}

interface Secret {
  email: string;
  password: string;
  reason: 'created' | 'reset';
}

export function UserAdmin() {
  const { api, user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, log] = await Promise.all([
        api.request<AdminUserList>('/api/admin/users?limit=200'),
        api.request<AdminAuditEntry[]>('/api/admin/audit-log?limit=20'),
      ]);
      setUsers(list.items);
      setAudit(log);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const changeRole = (u: AdminUser, role: Role) =>
    act(async () => {
      await api.request(`/api/admin/users/${u.id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
    });

  const toggleActive = (u: AdminUser) => {
    const verb = u.isActive ? 'deactivate' : 'activate';
    if (u.isActive && !window.confirm(`Deactivate ${u.email}? They will be signed out everywhere.`))
      return;
    return act(async () => {
      await api.request(`/api/admin/users/${u.id}/${verb}`, { method: 'POST' });
    });
  };

  const resetPassword = (u: AdminUser) => {
    if (!window.confirm(`Issue a new one-time password for ${u.email}? Their sessions will end.`))
      return;
    return act(async () => {
      const res = await api.request<UserWithTemporaryPassword>(
        `/api/admin/users/${u.id}/reset-password`,
        { method: 'POST' },
      );
      setSecret({ email: u.email, password: res.temporaryPassword, reason: 'reset' });
    });
  };

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setCreateError(null);
    setBusy(true);
    try {
      const res = await api.request<UserWithTemporaryPassword>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: String(data.get('email') ?? '').trim(),
          displayName: String(data.get('displayName') ?? '').trim(),
          role: String(data.get('role')),
        }),
      });
      setSecret({ email: res.user.email, password: res.temporaryPassword, reason: 'created' });
      form.reset();
      await load();
    } catch (err) {
      setCreateError(
        err instanceof ApiError && err.status === 400
          ? 'Check the email, name and role, then try again.'
          : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-10">
      {error && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-red-800">
          {error}
        </p>
      )}

      {secret && (
        <section
          aria-labelledby="secret-title"
          className="rounded border border-amber-300 bg-amber-50 p-4"
        >
          <h3 id="secret-title" className="font-semibold">
            One-time password for {secret.email}
          </h3>
          <p className="mt-1 text-sm">
            {secret.reason === 'created' ? 'Account created.' : 'Password reset.'} This password is
            shown only once. Give it to the user securely; they sign in with it.
          </p>
          <p className="mt-2">
            <code data-testid="temporary-password" className="rounded bg-white px-2 py-1 text-base">
              {secret.password}
            </code>
          </p>
          <button type="button" className={`${smallButton} mt-3`} onClick={() => setSecret(null)}>
            I have copied it, hide
          </button>
        </section>
      )}

      <section aria-labelledby="create-title">
        <h2 id="create-title" className="text-xl font-semibold">
          Add a user
        </h2>
        {createError && (
          <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-3 text-red-800">
            {createError}
          </p>
        )}
        <form onSubmit={onCreate} className="mt-3 grid gap-4 sm:grid-cols-4 sm:items-end">
          <div>
            <label htmlFor="new-email" className="block text-sm font-medium">
              Email
            </label>
            <input id="new-email" name="email" type="email" required className={input} />
          </div>
          <div>
            <label htmlFor="new-name" className="block text-sm font-medium">
              Display name
            </label>
            <input id="new-name" name="displayName" required maxLength={120} className={input} />
          </div>
          <div>
            <label htmlFor="new-role" className="block text-sm font-medium">
              Role
            </label>
            <select id="new-role" name="role" defaultValue="EMPLOYEE" className={input}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-60"
          >
            Create user
          </button>
        </form>
      </section>

      <section aria-labelledby="users-title">
        <h2 id="users-title" className="text-xl font-semibold">
          User accounts
        </h2>
        {users === null ? (
          <p role="status" className="mt-3 text-slate-600">
            Loading users…
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded border border-slate-200 bg-white">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">User accounts</caption>
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="p-2">
                    Name
                  </th>
                  <th scope="col" className="p-2">
                    Email
                  </th>
                  <th scope="col" className="p-2">
                    Role
                  </th>
                  <th scope="col" className="p-2">
                    Status
                  </th>
                  <th scope="col" className="p-2">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === me?.id;
                  return (
                    <tr key={u.id} className="border-t border-slate-200">
                      <td className="p-2">{u.displayName}</td>
                      <td className="p-2">{u.email}</td>
                      <td className="p-2">
                        <select
                          aria-label={`Role for ${u.email}`}
                          value={u.role}
                          disabled={busy || self}
                          onChange={(e) => void changeRole(u, e.target.value as Role)}
                          className="rounded border border-slate-300 px-2 py-1 disabled:opacity-60"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-2">{u.isActive ? 'Active' : 'Inactive'}</td>
                      <td className="flex flex-wrap gap-2 p-2">
                        <button
                          type="button"
                          aria-label={`${u.isActive ? 'Deactivate' : 'Activate'} ${u.email}`}
                          disabled={busy || (self && u.isActive)}
                          onClick={() => void toggleActive(u)}
                          className={smallButton}
                        >
                          {u.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          type="button"
                          aria-label={`Reset password for ${u.email}`}
                          disabled={busy || self}
                          onClick={() => void resetPassword(u)}
                          className={smallButton}
                        >
                          Reset password
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="audit-title">
        <h2 id="audit-title" className="text-xl font-semibold">
          Recent account changes
        </h2>
        {audit.length === 0 ? (
          <p className="mt-3 text-slate-600">No changes recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-1 text-sm">
            {audit.map((a) => (
              <li key={a.id}>
                <time dateTime={a.createdAt} className="text-slate-500">
                  {new Date(a.createdAt).toLocaleString()}
                </time>{' '}
                {a.actor.email} {ACTION_TEXT[a.action]} {a.target.email}
                {a.action === 'ROLE_CHANGED' && a.details.from && a.details.to
                  ? ` (${String(a.details.from)} to ${String(a.details.to)})`
                  : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
