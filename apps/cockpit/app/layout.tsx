import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cursor Community Atlas',
  description:
    'Internal cockpit for the Cursor Community Atlas. See SPEC.md for the canonical specification.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-50 antialiased">{children}</body>
    </html>
  );
}
