'use client';

export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <section role="alert" className="app-card mx-auto max-w-xl p-6 text-center sm:p-8">
      <h1 className="text-2xl font-bold text-slate-950">Something went wrong</h1>
      <p className="mt-2 text-slate-600">
        An unexpected error occurred. Your work has not been submitted.
      </p>
      <button type="button" onClick={reset} className="app-button-primary mt-5">
        Try again
      </button>
    </section>
  );
}
