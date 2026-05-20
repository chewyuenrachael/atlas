/**
 * Cockpit top navigation. Server component — no interactivity needed beyond
 * link clicks. Renders on every page via `app/layout.tsx`.
 */
import Link from 'next/link';

const LINKS: { href: string; label: string }[] = [
  { href: '/map', label: 'Map' },
  { href: '/tables', label: 'Tables' },
  { href: '/ask', label: 'Ask' },
];

export function Nav(): JSX.Element {
  return (
    <nav className="border-b border-neutral-900 bg-neutral-950">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3 text-sm">
        <Link href="/map" className="font-mono text-xs uppercase tracking-widest text-neutral-400">
          cursor / community / atlas
        </Link>
        <div className="flex items-center gap-1">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded px-3 py-1 text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-100"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
