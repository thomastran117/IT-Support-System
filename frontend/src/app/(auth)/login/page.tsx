import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in' };

const field = 'mt-1 w-full rounded border border-slate-300 px-3 py-2';

export default function LoginPage() {
  return (
    <section
      aria-labelledby="login-title"
      className="mx-auto max-w-sm rounded-lg border border-slate-200 bg-white p-6"
    >
      <h1 id="login-title" className="text-2xl font-semibold">
        Sign in
      </h1>
      <form className="mt-4 space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input id="email" name="email" type="email" autoComplete="username" className={field} />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            className={field}
          />
        </div>
        <button
          type="button"
          disabled
          className="w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-60"
        >
          Sign in (not implemented yet)
        </button>
      </form>
    </section>
  );
}
