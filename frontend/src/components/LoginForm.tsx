'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { loginErrorMessage } from '@/lib/auth/client';
import { portalFor } from '@/lib/auth/roles';

const field = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 text-base';

interface FieldErrors {
  email?: string;
  password?: string;
}

export function LoginForm() {
  const { status, user, notice, signIn } = useAuth();
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Already signed in (or just signed in): go to the role's portal.
  useEffect(() => {
    if (status === 'authenticated' && user) router.replace(portalFor(user.role));
  }, [status, user, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');

    const next: FieldErrors = {};
    if (!email) next.email = 'Enter your email address.';
    else if (!/^\S+@\S+$/.test(email)) next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    setFormError(null);
    if (next.email || next.password) {
      (next.email ? emailRef : passwordRef).current?.focus();
      return;
    }

    setPending(true);
    try {
      await signIn(email, password);
      // Navigation happens in the effect above once the user is set; keep the form busy until then.
    } catch (err) {
      setFormError(loginErrorMessage(err));
      setPending(false);
      passwordRef.current?.select();
    }
  }

  const banner =
    formError ??
    (notice === 'expired'
      ? 'Your session has ended. Please sign in again.'
      : notice === 'network'
        ? 'Unable to reach the server. Check your connection and try again.'
        : null);

  return (
    <section
      aria-labelledby="login-title"
      className="mx-auto max-w-sm rounded-lg border border-slate-200 bg-white p-6"
    >
      <h1 id="login-title" className="text-2xl font-semibold">
        Sign in
      </h1>
      {banner && (
        <p role="alert" className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-red-800">
          {banner}
        </p>
      )}
      <form noValidate onSubmit={onSubmit} aria-busy={pending} className="mt-4 space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            ref={emailRef}
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? 'email-error' : undefined}
            className={field}
          />
          {errors.email && (
            <p id="email-error" className="mt-1 text-sm text-red-700">
              {errors.email}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            ref={passwordRef}
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            className={field}
          />
          {errors.password && (
            <p id="password-error" className="mt-1 text-sm text-red-700">
              {errors.password}
            </p>
          )}
        </div>
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-60"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}
