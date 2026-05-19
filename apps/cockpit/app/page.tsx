export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-start justify-center gap-6 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
        cursor / community / atlas
      </p>
      <h1 className="text-balance text-4xl font-semibold leading-tight md:text-5xl">
        Cursor Community Atlas — Phase 0 scaffold complete
      </h1>
      <p className="max-w-2xl text-pretty text-base leading-relaxed text-neutral-300">
        This is the operator cockpit. Phase 0 stands up the monorepo, locks the type contracts in{' '}
        <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-sm">
          packages/core
        </code>
        , and scaffolds every adapter, intelligence service, workflow, and API surface for the
        phases that follow.
      </p>
      <p className="max-w-2xl text-pretty text-base leading-relaxed text-neutral-400">
        Phase 1 lands the schema migrations and the Luma adapter. See{' '}
        <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-sm">SPEC.md</code> for
        the canonical specification and{' '}
        <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-sm">AGENTS.md</code>{' '}
        for the operating manual.
      </p>
      <ul className="grid w-full gap-2 text-sm text-neutral-400 sm:grid-cols-2">
        <li className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
          <span className="block font-mono text-xs uppercase text-neutral-500">Next up</span>
          <span className="text-neutral-100">Phase 1: Foundation</span>
        </li>
        <li className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
          <span className="block font-mono text-xs uppercase text-neutral-500">Owner</span>
          <span className="text-neutral-100">Community Engineering</span>
        </li>
      </ul>
    </main>
  );
}
