"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiClientError, fmtTime } from "./api";

type Data = Awaited<ReturnType<typeof api.flags>>;

export function FlagsView() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      setData(await api.flags());
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load.");
    }
  };
  useEffect(() => void load(), []);

  if (error)
    return (
      <div role="alert" className="flex items-center justify-between rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
        {error}
        <button type="button" onClick={() => void load()} className="rounded-md border border-danger/30 bg-white px-3 py-1.5 text-xs font-medium">Try again</button>
      </div>
    );
  if (!data) return <div className="h-64 rounded-xl skeleton" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Flags, tickets &amp; audit log</h1>
        <p className="text-sm text-muted">The only state the agent&apos;s actions can change, and only after a person approves. Simulated datasets.</p>
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="px-4 pt-4 text-left font-semibold">Feature flags</caption>
          <thead className="text-left text-xs text-muted">
            <tr><th className="px-4 py-2 font-medium">Dataset</th><th className="px-4 py-2 font-medium">Flag</th><th className="px-4 py-2 font-medium">Platform</th><th className="px-4 py-2 font-medium">State</th><th className="px-4 py-2 font-medium">Updated</th></tr>
          </thead>
          <tbody>
            {data.flags.map((f) => (
              <tr key={`${f.dataset}/${f.flagKey}`} className="border-t border-line">
                <td className="px-4 py-2 text-muted">{f.dataset}</td>
                <td className="px-4 py-2"><code className="font-mono text-xs">{f.flagKey}</code><div className="text-xs text-muted">{f.description}</div></td>
                <td className="px-4 py-2 text-muted">{f.platform ?? "all"}</td>
                <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${f.enabled ? "bg-good-soft text-good" : "bg-canvas text-muted"}`}>{f.enabled ? "On" : "Off"}</span></td>
                <td className="px-4 py-2 text-xs text-muted">{fmtTime(f.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="mb-2 font-semibold">Audit log</h2>
          {data.audit.length === 0 ? (
            <p className="text-sm text-muted">No approvals, rejections or undos yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.audit.map((a) => (
                <li key={a.id} className="border-b border-line pb-2 last:border-0">
                  <span className="font-medium">{a.actor}</span> <span className="text-muted">{a.action.replaceAll("_", " ")}</span>{" "}
                  <Link className="font-mono text-xs text-brand hover:underline" href={`/investigations/${a.target.replace(/-A\d+$/, "")}`}>{a.target}</Link>
                  <div className="text-xs text-muted">{fmtTime(a.ts)}{a.details.note ? ` · “${String(a.details.note)}”` : ""}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="mb-2 font-semibold">Tickets opened</h2>
          {data.tickets.length === 0 ? (
            <p className="text-sm text-muted">No tickets yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.tickets.map((t) => (
                <li key={t.id} className="border-b border-line pb-2 last:border-0">
                  <span className="font-medium">#{t.id} {t.title}</span>
                  <div className="text-xs text-muted">{t.team} · {t.dataset} · by {t.createdBy} · {fmtTime(t.createdAt)}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
