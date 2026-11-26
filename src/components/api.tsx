import type { Evidence } from "@/domain/types";
import type { InvestigationRow, ProposalRow, StepRow } from "@/server/repositories/investigations";

export class ApiClientError extends Error {
  constructor(message: string, public readonly status: number, public readonly details: string[] = []) {
    super(message);
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  } catch {
    throw new ApiClientError("Can't reach the server. Check your connection and try again.", 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiClientError(body?.error?.message ?? `Request failed (${res.status}).`, res.status, body?.error?.details ?? []);
  return body as T;
}

export interface Detail { investigation: InvestigationRow; steps: StepRow[]; evidence: Evidence[]; proposals: ProposalRow[] }
export interface DatasetInfo { id: string; title: string; description: string; defaultTask: string }
export interface ProviderInfo { name: "mock" | "anthropic"; label: string; available: boolean; reason?: string }

export const api = {
  datasets: () => call<{ datasets: DatasetInfo[]; providers: ProviderInfo[] }>("/api/datasets"),
  list: () => call<{ investigations: InvestigationRow[] }>("/api/investigations"),
  start: (body: { dataset: string; task: string; provider: string }) => call<{ id: string }>("/api/investigations", { method: "POST", body: JSON.stringify(body) }),
  detail: (id: string, afterSeq: number) => call<Detail>(`/api/investigations/${encodeURIComponent(id)}?afterSeq=${afterSeq}`),
  decide: (id: string, decision: "approve" | "reject" | "undo", body: { reviewer: string; note?: string }) =>
    call<{ id: string; status: string; result?: Record<string, unknown> }>(`/api/actions/${encodeURIComponent(id)}/${decision}`, { method: "POST", body: JSON.stringify(body) }),
  flags: () =>
    call<{
      flags: Array<{ dataset: string; flagKey: string; enabled: boolean; platform: string | null; description: string; updatedAt: string }>;
      audit: Array<{ id: number; ts: string; actor: string; action: string; target: string; details: Record<string, unknown> }>;
      tickets: Array<{ id: number; dataset: string; team: string; title: string; createdAt: string; createdBy: string; actionId: string | null }>;
    }>("/api/flags"),
};

export const STATUS_STYLE: Record<string, string> = {
  pending: "bg-canvas text-muted",
  running: "bg-brand-soft text-brand",
  completed: "bg-good-soft text-good",
  needs_info: "bg-warn-soft text-warn",
  insufficient_evidence: "bg-warn-soft text-warn",
  failed: "bg-danger-soft text-danger",
};
export const STATUS_LABEL: Record<string, string> = {
  pending: "Queued",
  running: "Investigating…",
  completed: "Completed",
  needs_info: "Needs information",
  insufficient_evidence: "Inconclusive",
  failed: "Stopped",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? ""}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export const fmtTime = (ts: string | null) =>
  // Postgres ::text gives "2026-10-21 15:01:05.5+00"; make it ISO before parsing.
  ts ? new Date(ts.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "";
