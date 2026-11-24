'use client';

import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { loginErrorMessage } from '@/lib/auth/client';
import { portalFor } from '@/lib/auth/roles';
import { BrandMark, Notice } from './ui';
import { ThemeSelect } from './ui/ThemeSelect';

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
      className="flex min-h-dvh items-center justify-center px-4 py-8 sm:px-8"
    >
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <BrandMark />
        </div>
        <div className="app-card p-6 sm:p-9">
          <h1 id="login-title" className="text-3xl font-semibold tracking-tight text-ink-strong">
            Sign in
          </h1>
          <p className="mt-2 text-sm text-muted">Use your work email and password.</p>
          {banner && (
            <div className="mt-5">
              <Notice role="alert" tone="danger">
                {banner}
              </Notice>
            </div>
          )}
          <form noValidate onSubmit={onSubmit} aria-busy={pending} className="mt-6 space-y-5">
            <div>
              <label htmlFor="email" className="app-label">
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
                className="app-field"
              />
              {errors.email && (
                <p id="email-error" className="mt-1.5 text-sm text-danger">
                  {errors.email}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="password" className="app-label">
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
                className="app-field"
              />
              {errors.password && (
                <p id="password-error" className="mt-1.5 text-sm text-danger">
                  {errors.password}
                </p>
              )}
            </div>
            <button type="submit" disabled={pending} className="app-button-primary w-full">
              {pending ? 'Signing in…' : 'Sign in'}
              <ArrowRight aria-hidden="true" size={16} />
            </button>
          </form>
        </div>
        <div className="mt-5 flex justify-center">
          <ThemeSelect />
        </div>
      </div>
    </section>
  );
}
