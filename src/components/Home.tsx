"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { InvestigationRow } from "@/server/repositories/investigations";
import { api, ApiClientError, fmtTime, StatusPill, type DatasetInfo, type ProviderInfo } from "./api";

export function Home() {
  const router = useRouter();
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [list, setList] = useState<InvestigationRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dataset, setDataset] = useState("");
  const [task, setTask] = useState("");
  const [provider, setProvider] = useState<"mock" | "anthropic">("mock");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; details: string[] } | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const [d, l] = await Promise.all([api.datasets(), api.list()]);
      setDatasets(d.datasets);
      setProviders(d.providers);
      setList(l.investigations);
      if (!dataset && d.datasets[0]) {
        const first = d.datasets.find((x) => x.id === "ios-contact-flag") ?? d.datasets[0];
        setDataset(first.id);
        setTask(first.defaultTask);
      }
    } catch (err) {
      setLoadError(err instanceof ApiClientError ? err.message : "Could not load.");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = datasets?.find((d) => d.id === dataset);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { id } = await api.start({ dataset, task, provider });
      router.push(`/investigations/${id}`);
    } catch (err) {
      const e2 = err instanceof ApiClientError ? err : new ApiClientError("Could not start.", 0);
      setSubmitError({ message: e2.message, details: e2.details });
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <div role="alert" className="flex items-center justify-between rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
        {loadError}
        <button type="button" onClick={() => void load()} className="rounded-md border border-danger/30 bg-white px-3 py-1.5 text-xs font-medium">Try again</button>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <form onSubmit={start} className="space-y-5 rounded-2xl border border-line bg-white p-5 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Investigate a metric drop</h1>
          <p className="text-sm text-muted">
            The agent checks a fixed set of read-only tools, records every piece of evidence, weighs alternative causes, and only{" "}
            <em>proposes</em> actions. A person approves them.
          </p>
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium">Simulated incident world</legend>
          {!datasets ? (
            <div className="grid gap-2 sm:grid-cols-2">{Array.from({ length: 6 }, (_, i) => <div key={i} className="h-20 rounded-lg skeleton" />)}</div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {datasets.map((d) => (
                <label key={d.id} className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm ${dataset === d.id ? "border-brand bg-brand-soft" : "border-line hover:border-brand/50"}`}>
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="dataset"
                      value={d.id}
                      checked={dataset === d.id}
                      onChange={() => {
                        setDataset(d.id);
                        setTask(d.defaultTask);
                      }}
                      className="accent-[var(--color-brand)]"
                    />
                    <span className="font-medium">{d.title}</span>
                  </span>
                  <span className="text-xs text-muted">{d.description}</span>
                </label>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">Each world is three weeks of simulated hourly telemetry with one injected cause (or none). The agent is not told which.</p>
        </fieldset>

        <div>
          <label htmlFor="task" className="mb-1 block text-sm font-medium">What did you notice?</label>
          <textarea id="task" rows={2} maxLength={500} value={task} onChange={(e) => setTask(e.target.value)} className="w-full resize-none rounded-lg border border-line px-3 py-2 focus:border-brand focus:outline-none" />
          <p className="text-xs text-muted">Try vague or wrong phrasing too: &ldquo;Something feels off&rdquo;, or a place with no data such as &ldquo;Leads dropped in Mirdif&rdquo;.</p>
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium">Reasoning provider</legend>
          <div className="flex flex-col gap-2 sm:flex-row">
            {providers.map((p) => (
              <label key={p.name} className={`flex flex-1 items-start gap-2 rounded-lg border p-3 text-sm ${!p.available ? "opacity-60" : "cursor-pointer"} ${provider === p.name ? "border-brand bg-brand-soft" : "border-line"}`}>
                <input type="radio" name="provider" disabled={!p.available} checked={provider === p.name} onChange={() => setProvider(p.name)} className="mt-1 accent-[var(--color-brand)]" />
                <span>
                  <span className="font-medium">{p.label}</span>
                  <span className="block text-xs text-muted">{p.name === "mock" ? "Fixed investigation playbook. Same tools, validation and approvals; no language model." : p.available ? "Model chooses tools and writes the report; code validates everything." : p.reason}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {submitError && (
          <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {submitError.message}
            {submitError.details.map((d) => <div key={d} className="text-xs">{d}</div>)}
          </div>
        )}
        <button type="submit" disabled={submitting || !selected || task.trim().length < 5} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-40">
          {submitting ? "Starting…" : "Start investigation"}
        </button>
      </form>

      <section aria-labelledby="recent" className="space-y-3">
        <h2 id="recent" className="text-sm font-semibold">Recent investigations</h2>
        {!list ? (
          <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <div key={i} className="h-16 rounded-lg skeleton" />)}</div>
        ) : list.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">None yet. Start one on the left.</p>
        ) : (
          <ul className="space-y-2">
            {list.map((i) => (
              <li key={i.id}>
                <Link href={`/investigations/${i.id}`} className="block rounded-lg border border-line bg-white p-3 hover:border-brand/50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{i.task}</span>
                    <StatusPill status={i.status} />
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {i.datasetTitle} · {i.provider === "mock" ? "playbook" : i.provider} · {fmtTime(i.createdAt)}
                    {i.report && <> · <strong className="text-ink">{i.report.conclusion.replace("_", " ")}</strong></>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
