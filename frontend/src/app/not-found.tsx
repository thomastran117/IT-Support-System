import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="app-card mx-auto mt-16 max-w-xl p-6 text-center sm:p-8">
      <p className="text-xs font-bold tracking-[0.14em] text-accent uppercase">404 error</p>
      <h1 className="mt-2 text-2xl font-bold text-ink-strong">Page not found</h1>
      <p className="mt-2 text-muted">The page you requested does not exist.</p>
      <Link href="/" className="app-button-primary mt-5">
        Back to home
      </Link>
    </section>
  );
}
