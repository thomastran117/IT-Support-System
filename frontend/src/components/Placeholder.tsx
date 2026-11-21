export function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <section
      aria-labelledby="page-title"
      className="app-card p-6"
    >
      <h1 id="page-title" className="text-2xl font-semibold">
        {title}
      </h1>
      <p className="mt-2 text-slate-600">{description}</p>
      <p className="mt-4 text-sm text-slate-500">Scaffolding only. Feature not implemented yet.</p>
    </section>
  );
}
