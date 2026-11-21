'use client';

import { CircleCheck, Headphones, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { loginErrorMessage } from '@/lib/auth/client';
import { portalFor } from '@/lib/auth/roles';
import { BrandMark } from './ui';

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
    <div className="grid min-h-screen bg-white lg:grid-cols-[minmax(22rem,0.9fr)_minmax(30rem,1.1fr)]">
      <section className="relative hidden overflow-hidden bg-[#0b1f3a] p-10 text-white lg:flex lg:flex-col xl:p-14">
        <div aria-hidden="true" className="absolute -top-36 -right-28 size-[30rem] rounded-full bg-blue-500/15 blur-3xl" />
        <div aria-hidden="true" className="absolute -bottom-40 -left-20 size-[26rem] rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative"><BrandMark /></div>
        <div className="relative my-auto max-w-lg py-16">
          <p className="text-sm font-bold tracking-[0.14em] text-blue-300 uppercase">Support operations</p>
          <h2 className="mt-4 text-4xl font-bold tracking-[-0.04em] xl:text-5xl">
            Every support request, clearly organized.
          </h2>
          <p className="mt-5 text-lg leading-8 text-slate-300">
            SmartDesk gives employees and IT teams one dependable place to report, route, and resolve issues.
          </p>
          <ul className="mt-9 space-y-4 text-sm text-slate-200">
            {[
              'Track requests from intake through resolution',
              'Keep teams aligned with clear ownership and priority',
              'Preserve a complete, accountable service history',
            ].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <span className="grid size-6 place-items-center rounded-full bg-blue-400/15 text-blue-300">
                  <CircleCheck aria-hidden="true" size={15} />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-300">Secure internal IT support workspace</p>
      </section>

      <section aria-labelledby="login-title" className="flex min-h-screen items-center justify-center bg-[#f4f7fb] p-5 sm:p-8">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden"><BrandMark /></div>
          <div className="app-card p-6 sm:p-8">
            <span className="grid size-11 place-items-center rounded-xl bg-blue-50 text-blue-700">
              <Headphones aria-hidden="true" size={22} />
            </span>
            <h1 id="login-title" className="mt-5 text-2xl font-bold tracking-[-0.025em] text-slate-950">Sign in</h1>
            <p className="mt-2 text-sm text-slate-600">Access your SmartDesk support workspace.</p>
            {banner && (
              <p role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">{banner}</p>
            )}
            <form noValidate onSubmit={onSubmit} aria-busy={pending} className="mt-6 space-y-5">
              <div>
                <label htmlFor="email" className="app-label">Email</label>
                <input ref={emailRef} id="email" name="email" type="email" autoComplete="username" required aria-invalid={errors.email ? true : undefined} aria-describedby={errors.email ? 'email-error' : undefined} className="app-field" />
                {errors.email && <p id="email-error" className="mt-1.5 text-sm text-rose-700">{errors.email}</p>}
              </div>
              <div>
                <label htmlFor="password" className="app-label">Password</label>
                <input ref={passwordRef} id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={errors.password ? true : undefined} aria-describedby={errors.password ? 'password-error' : undefined} className="app-field" />
                {errors.password && <p id="password-error" className="mt-1.5 text-sm text-rose-700">{errors.password}</p>}
              </div>
              <button type="submit" disabled={pending} className="app-button-primary w-full">
                <LockKeyhole aria-hidden="true" size={16} />
                {pending ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>
          <p className="mt-5 flex items-center justify-center gap-2 text-sm text-slate-600">
            <ShieldCheck aria-hidden="true" size={15} />
            Protected by secure session authentication
          </p>
        </div>
      </section>
    </div>
  );
}
