"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { HYPOTHESES, DEFAULT_BUDGET, type Assessment, type Evidence, type HypothesisId } from "@/domain/types";
import type { ProposalRow, StepRow } from "@/server/repositories/investigations";
import { api, ApiClientError, fmtTime, StatusPill, type Detail } from "./api";

const POLL_MS = 700;
const ACTIVE = new Set(["pending", "running"]);

export function InvestigationView({ id }: { id: string }) {
  const [detail, setDetail] = useState<Omit<Detail, "steps"> | null>(null);
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const d = await api.detail(id, lastSeq.current);
      if (!alive.current) return;
      if (d.steps.length) {
        lastSeq.current = d.steps.at(-1)!.seq;
        setSteps((s) => [...s, ...d.steps]);
      }
      setDetail({ investigation: d.investigation, evidence: d.evidence, proposals: d.proposals });
      setError(null);
      return d.investigation.status;
    } catch (err) {
      if (alive.current) setError(err instanceof ApiClientError ? err.message : "Could not load the investigation.");
      return err instanceof ApiClientError && err.status === 404 ? "missing" : undefined;
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const status = await refresh();
      if (alive.current && status !== "missing" && (status === undefined || ACTIVE.has(status))) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  const jump = (evId: string) => {
    document.getElementById(`ev-${evId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(null);
    requestAnimationFrame(() => setFlashId(evId));
  };

  if (!detail) {
    return error ? (
      <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
        {error} <Link href="/" className="underline">Back to investigations</Link>
      </div>
    ) : (
      <div className="space-y-3">
        <div className="h-20 rounded-xl skeleton" />
        <div className="h-64 rounded-xl skeleton" />
      </div>
    );
  }

  const inv = detail.investigation;
  const running = ACTIVE.has(inv.status);
  const started = steps.find((s) => s.kind === "started")?.payload as { isLlm?: boolean } | undefined;
  const usage = inv.usage ?? {};

  return (
    <div className="space-y-5">
      <header className="rounded-2xl border border-line bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted">
              <Link href="/" className="hover:underline">Investigations</Link> / {inv.id}
            </p>
            <h1 className="mt-1 text-lg font-semibold tracking-tight">&ldquo;{inv.task}&rdquo;</h1>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              <Badge>{inv.datasetTitle}</Badge>
              <Badge tone="warn">Simulated data</Badge>
              <Badge>{inv.provider === "mock" ? "Deterministic playbook (no LLM)" : `LLM: ${inv.provider}`}</Badge>
              {inv.problem && <Badge>Problem: {inv.problem.metric} · {[inv.problem.segment.community, inv.problem.segment.platform].filter(Boolean).join(" / ") || "all traffic"}</Badge>}
            </div>
          </div>
          <StatusPill status={inv.status} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <Meter label="Tool calls" value={usage.toolCalls ?? 0} max={DEFAULT_BUDGET.maxToolCalls} />
          <Meter label="Decisions" value={usage.decisions ?? 0} max={DEFAULT_BUDGET.maxDecisions} />
          <Stat label="Rejected model outputs" value={String(usage.invalidOutputs ?? 0)} />
          <Stat label="Elapsed" value={usage.wallMs ? `${(usage.wallMs / 1000).toFixed(1)} s` : running ? "…" : "–"} />
        </dl>
        {started?.isLlm === false && <p className="mt-3 text-xs text-muted">This run used the deterministic playbook. The tools, validation and approval flow are the same ones a language model goes through.</p>}
      </header>

      {inv.status === "needs_info" && (
        <Callout tone="warn" title="The agent needs more information before investigating">
          <p>{inv.outcomeNote}</p>
          <Link href="/" className="mt-2 inline-block text-sm font-medium underline">Start a new investigation with more detail</Link>
        </Callout>
      )}
      {(inv.status === "failed" || inv.status === "insufficient_evidence" || (inv.status === "completed" && inv.outcomeNote)) && inv.outcomeNote && (
        <Callout tone={inv.status === "failed" ? "danger" : "warn"} title={inv.status === "failed" ? "Stopped safely" : "Note"}>
          <p>{inv.outcomeNote}</p>
        </Callout>
      )}
      {error && <p role="alert" className="text-sm text-danger">Live updates paused: {error}</p>}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-5">
          {inv.report ? <ReportCard report={inv.report} onCite={jump} /> : running ? <div className="h-40 rounded-xl skeleton" aria-label="Report pending" /> : null}
          {detail.proposals.length > 0 && <Proposals proposals={detail.proposals} onChange={() => void refresh()} onCite={jump} />}
          <EvidenceList evidence={detail.evidence} flashId={flashId} running={running} />
          <Trace steps={steps} running={running} />
        </div>
        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start" aria-label="Hypotheses">
          <Hypotheses assessments={inv.assessments} onCite={jump} />
        </aside>
      </div>
    </div>
  );
}

// ───────────────────────────── pieces ─────────────────────────────

function ReportCard({ report, onCite }: { report: NonNullable<Detail["investigation"]["report"]>; onCite: (id: string) => void }) {
  const title = report.conclusion === "undetermined" ? "Cause not determined" : HYPOTHESES[report.conclusion as HypothesisId];
  return (
    <section aria-labelledby="report-title" className="rounded-xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="report-title" className="text-base font-semibold">{title}</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${report.confidence === "high" ? "bg-good-soft text-good" : report.confidence === "medium" ? "bg-warn-soft text-warn" : "bg-canvas text-muted"}`}>
          {report.confidence} confidence
        </span>
      </div>
      <p className="mt-2 text-sm">{report.summary}</p>
      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Findings</h3>
      <ul className="mt-1 space-y-1.5 text-sm">
        {report.claims.map((c, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-1.5">
            <span>{c.text}</span>
            {c.evidenceIds.map((id) => <Cite key={id} id={id} onCite={onCite} />)}
          </li>
        ))}
      </ul>
      {report.alternatives.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Alternatives considered</h3>
          <ul className="mt-1 space-y-1.5 text-sm">
            {report.alternatives.map((a) => (
              <li key={a.hypothesis} className="flex flex-wrap items-baseline gap-1.5">
                <span className={`rounded px-1.5 text-xs font-medium ${a.verdict === "rejected" ? "bg-canvas text-muted" : "bg-warn-soft text-warn"}`}>{a.verdict}</span>
                <span className="font-medium">{HYPOTHESES[a.hypothesis]}</span>
                <span className="text-muted">{a.reason}</span>
                {a.evidenceIds.map((id) => <Cite key={id} id={id} onCite={onCite} />)}
              </li>
            ))}
          </ul>
        </>
      )}
      {report.openQuestions.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Open questions</h3>
          <ul className="mt-1 list-disc pl-5 text-sm text-muted">{report.openQuestions.map((q) => <li key={q}>{q}</li>)}</ul>
        </>
      )}
    </section>
  );
}

function Proposals({ proposals, onChange, onCite }: { proposals: ProposalRow[]; onChange: () => void; onCite: (id: string) => void }) {
  const [reviewer, setReviewer] = useState("");
  useEffect(() => {
    try {
      setReviewer(localStorage.getItem("mii-reviewer") ?? "");
    } catch {
      /* storage unavailable: start empty */
    }
  }, []);
  const remember = (v: string) => {
    setReviewer(v);
    try {
      localStorage.setItem("mii-reviewer", v);
    } catch {
      /* ignore */
    }
  };
  return (
    <section aria-labelledby="actions-title" className="rounded-xl border border-line bg-white p-5">
      <h2 id="actions-title" className="text-base font-semibold">Proposed actions</h2>
      <p className="text-sm text-muted">Nothing runs until a named person approves. Every decision is written to the audit log.</p>
      <label className="mt-3 block max-w-xs text-sm">
        <span className="font-medium">Your name</span>
        <input value={reviewer} onChange={(e) => remember(e.target.value)} placeholder="e.g. On-call lead" className="mt-1 w-full rounded-lg border border-line px-3 py-1.5" />
      </label>
      <ul className="mt-3 space-y-3">
        {proposals.map((p) => <ProposalCard key={p.id} p={p} reviewer={reviewer} onChange={onChange} onCite={onCite} />)}
      </ul>
    </section>
  );
}

function ProposalCard({ p, reviewer, onChange, onCite }: { p: ProposalRow; reviewer: string; onChange: () => void; onCite: (id: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const title = p.type === "rollback_feature_flag" ? `Disable feature flag "${p.params.flagKey}"` : `Open a ticket for the ${p.params.team} team: “${p.params.title}”`;
  const act = async (decision: "approve" | "reject" | "undo") => {
    setBusy(true);
    setErr(null);
    try {
      await api.decide(p.id, decision, { reviewer, note: note || undefined });
      onChange();
    } catch (e) {
      setErr(e instanceof ApiClientError ? [e.message, ...e.details].join(" ") : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{title}</p>
        <span className="text-xs text-muted">{p.reversible ? "Reversible" : "Not reversible"} · {p.status}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{p.rationale}</p>
      <div className="mt-1 flex flex-wrap gap-1">{p.evidenceIds.map((id) => <Cite key={id} id={id} onCite={onCite} />)}</div>
      {p.status === "pending" && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex-1 text-xs">
            <span className="text-muted">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-lg border border-line px-3 py-1.5 text-sm" />
          </label>
          <button type="button" disabled={busy || reviewer.trim().length < 2} onClick={() => void act("approve")} className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
            Approve &amp; run
          </button>
          <button type="button" disabled={busy || reviewer.trim().length < 2} onClick={() => void act("reject")} className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium disabled:opacity-40">
            Reject
          </button>
        </div>
      )}
      {p.status === "pending" && reviewer.trim().length < 2 && <p className="mt-1 text-xs text-muted">Enter your name above to approve or reject.</p>}
      {p.status !== "pending" && (
        <p className="mt-2 text-sm">
          <strong>{p.status === "executed" ? "Executed" : p.status === "rejected" ? "Rejected" : p.status === "undone" ? "Undone" : p.status}</strong>
          {p.decidedBy && <> by {p.decidedBy}</>} {p.decidedAt && <>· {fmtTime(p.decidedAt)}</>}
          {p.result && <span className="text-muted"> · {JSON.stringify(p.result)}</span>}
        </p>
      )}
      {p.status === "executed" && p.reversible && (
        <button type="button" disabled={busy || reviewer.trim().length < 2} onClick={() => void act("undo")} className="mt-2 rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40">
          Undo
        </button>
      )}
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
    </li>
  );
}

const ASSESS_STYLE: Record<string, string> = {
  supported: "border-good/40 bg-good-soft",
  weak: "border-warn/40 bg-warn-soft",
  refuted: "border-line bg-canvas opacity-70",
  untested: "border-dashed border-line bg-white",
};

function Hypotheses({ assessments, onCite }: { assessments: Assessment[]; onCite: (id: string) => void }) {
  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <h2 className="text-sm font-semibold">Hypotheses</h2>
      <p className="mb-3 text-xs text-muted">Status is computed by code from the evidence; the model cannot change it.</p>
      <ul className="space-y-2">
        {(assessments.length ? assessments : (Object.keys(HYPOTHESES) as HypothesisId[]).map((h) => ({ hypothesis: h, status: "untested", reason: "", evidenceIds: [] }) as Assessment)).map((a) => (
          <li key={a.hypothesis} className={`rounded-lg border p-2.5 text-xs ${ASSESS_STYLE[a.status]}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink">{HYPOTHESES[a.hypothesis]}</span>
              <span className="shrink-0 font-semibold uppercase tracking-wide">{a.status}</span>
            </div>
            {a.reason && <p className="mt-1 text-muted">{a.reason}</p>}
            {a.evidenceIds.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{a.evidenceIds.map((id) => <Cite key={id} id={id} onCite={onCite} />)}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EvidenceList({ evidence, flashId, running }: { evidence: Evidence[]; flashId: string | null; running: boolean }) {
  return (
    <section aria-labelledby="evidence-title" className="rounded-xl border border-line bg-white p-5">
      <h2 id="evidence-title" className="text-base font-semibold">Evidence</h2>
      <p className="text-sm text-muted">Produced by tool code from the database. The model never writes evidence.</p>
      {evidence.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{running ? "Collecting…" : "No evidence was collected."}</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {evidence.map((e) => (
            <li key={e.id} id={`ev-${e.id}`} className={`scroll-mt-24 rounded-lg border border-line p-3 ${flashId === e.id ? "flash" : ""}`}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="rounded bg-ink px-1.5 font-mono text-xs text-white">{e.id}</span>
                <code className="font-mono text-xs text-muted">{e.tool}({Object.keys(e.args).length ? JSON.stringify(e.args) : ""})</code>
              </div>
              <p className="mt-1 text-sm">{e.summary}</p>
              {e.untrustedText && e.untrustedText.length > 0 && (
                <div className="mt-2 rounded-md border border-warn/40 bg-warn-soft p-2 text-xs">
                  <p className="font-semibold text-warn">Untrusted listing text: shown as data, never followed as instructions</p>
                  <ul className="mt-1 space-y-1 font-mono text-[11px] text-ink/80">{e.untrustedText.map((t, i) => <li key={i} className="break-words">“{t}”</li>)}</ul>
                </div>
              )}
              <details className="mt-1 text-xs text-muted">
                <summary className="cursor-pointer">Facts</summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-canvas p-2 font-mono text-[11px]">{JSON.stringify(e.facts, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const STEP_LABEL: Record<string, string> = {
  started: "Started", problem: "Problem understood", decision: "Decision", tool_call: "Tool call", evidence: "Evidence recorded",
  invalid_output: "Rejected output", invalid_tool: "Rejected: unknown tool", invalid_args: "Rejected: bad arguments", duplicate_call: "Rejected: duplicate",
  unavailable_tool: "Rejected: tool unavailable", tool_error: "Tool error", provider_error: "Provider error", fallback: "Fallback", budget: "Budget limit",
  interrupted: "Interrupted", report_rejected: "Report rejected", report: "Report accepted", action_proposed: "Action proposed",
  action_blocked: "Action blocked by policy", need_info: "Needs information", finished: "Finished",
};
const STEP_TONE = (k: string) =>
  /rejected|invalid|duplicate|unavailable|blocked/.test(k) ? "text-warn" : /error|interrupted/.test(k) ? "text-danger" : /fallback|budget/.test(k) ? "text-brand" : "text-muted";

function Trace({ steps, running }: { steps: StepRow[]; running: boolean }) {
  return (
    <section aria-labelledby="trace-title" className="rounded-xl border border-line bg-white p-5">
      <h2 id="trace-title" className="text-base font-semibold">Trace</h2>
      <p className="text-sm text-muted">Every step, in order, as stored in the append-only audit trail.</p>
      <ol className="mt-3 space-y-1.5 border-l border-line pl-4 text-sm" aria-live="polite">
        {steps.map((s) => (
          <li key={s.seq} className="relative">
            <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-line" aria-hidden />
            <span className={`font-medium ${STEP_TONE(s.kind)}`}>{STEP_LABEL[s.kind] ?? s.kind}</span>{" "}
            <span className="text-muted">{describeStep(s)}</span>
          </li>
        ))}
        {running && <li className="text-muted">…</li>}
      </ol>
    </section>
  );
}

function describeStep(s: StepRow): string {
  const p = s.payload as Record<string, any>;
  switch (s.kind) {
    case "started": return `${p.isLlm ? "LLM" : "deterministic playbook"} · budget ${p.budget?.maxToolCalls} tool calls / ${p.budget?.maxDecisions} decisions`;
    case "problem": return `${p.problem?.metric} · ${JSON.stringify(p.problem?.segment)}`;
    case "decision": return p.action === "call_tool" ? `→ ${p.tool} · ${p.reason ?? ""}` : `${p.action} · ${p.reason ?? p.question ?? ""}`;
    case "tool_call": return `${p.tool}(${JSON.stringify(p.args)})`;
    case "evidence": return `${p.id}: ${p.summary}`;
    case "report": return `${p.conclusion} (${p.confidence})`;
    case "action_proposed": return `${p.type} ${JSON.stringify(p.params)}: awaiting human approval`;
    case "action_blocked": return `${p.action?.type} ${p.action?.flagKey ?? ""}: ${p.reason}`;
    case "report_rejected": return (p.problems ?? []).join(" ");
    case "finished": return `${p.status}${p.outcomeNote ? `: ${p.outcomeNote}` : ""}`;
    default: return p.feedback ?? p.message ?? p.reason ?? p.question ?? (p.limit ? `${p.limit} reached` : "");
  }
}

function Cite({ id, onCite }: { id: string; onCite: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onCite(id)} className="rounded bg-brand-soft px-1.5 font-mono text-[11px] text-brand hover:bg-brand hover:text-white" aria-label={`Show evidence ${id}`}>
      {id}
    </button>
  );
}

const Badge = ({ children, tone }: { children: React.ReactNode; tone?: "warn" }) => (
  <span className={`rounded-full px-2 py-0.5 ${tone === "warn" ? "bg-warn-soft text-warn" : "bg-canvas text-muted"}`}>{children}</span>
);

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-1 flex items-center gap-2">
        <span className="tabular-nums font-medium text-ink">{value} / {max}</span>
        <span className="h-1.5 flex-1 rounded-full bg-canvas" aria-hidden>
          <span className="block h-1.5 rounded-full bg-brand" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
        </span>
      </dd>
    </div>
  );
}
const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-muted">{label}</dt>
    <dd className="mt-1 font-medium tabular-nums text-ink">{value}</dd>
  </div>
);

function Callout({ tone, title, children }: { tone: "warn" | "danger"; title: string; children: React.ReactNode }) {
  return (
    <div role="status" className={`rounded-xl border p-4 text-sm ${tone === "danger" ? "border-danger/30 bg-danger-soft" : "border-warn/30 bg-warn-soft"}`}>
      <p className="font-semibold">{title}</p>
      {children}
    </div>
  );
}
