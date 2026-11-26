import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Incident Investigator",
  description: "A bounded, evidence-first agent that explains marketplace metric drops and asks before acting.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body className="min-h-screen">
        <header className="border-b border-line bg-white">
          <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3" aria-label="Main">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-brand text-sm text-white">⌕</span>
              Incident Investigator
            </Link>
            <div className="flex gap-1 text-sm">
              <Link href="/" className="rounded-md px-3 py-1.5 text-muted hover:bg-canvas hover:text-ink">Investigations</Link>
              <Link href="/flags" className="rounded-md px-3 py-1.5 text-muted hover:bg-canvas hover:text-ink">Flags &amp; audit</Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted">
          Demo project. All telemetry, releases, flags and listings are simulated datasets; actions change only this demo&apos;s database.
        </footer>
      </body>
    </html>
  );
}
