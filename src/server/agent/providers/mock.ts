import { buildDeterministicReport } from "@/domain/deterministicReport";
import { COMMUNITIES, type Community, type Metric, type Platform } from "@/domain/types";
import type { AgentProvider, AgentView } from "./types";

/**
 * Deterministic provider: a fixed investigation playbook, not a language model.
 * It drives the real orchestrator, tools, database and validators, which makes
 * demos and tests reproducible and free. The UI labels it as "Deterministic
 * playbook (no LLM)".
 */

const COMMUNITY_ALIASES: Array<[RegExp, Community]> = [
  [/\b(dubai\s+)?marina\b/i, "dubai-marina"],
  [/\bjlt\b|\bjumeirah lakes? towers\b/i, "jlt"],
  [/\bbusiness bay\b/i, "business-bay"],
  [/\bjvc\b|\bjumeirah village circle\b/i, "jvc"],
  [/\bdowntown\b/i, "downtown-dubai"],
  [/\b(the\s+)?palm\b/i, "palm-jumeirah"],
];
const NOT_PLACES = /^(the|a|an|my|our|all|general|total|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|ios|android|web)$/i;

export function parseTaskDeterministically(task: string): unknown {
  const metric: Metric | undefined = /\b(leads?|enquir(?:y|ies)|calls?|contacts?)\b/i.test(task)
    ? "leads"
    : /\b(views?|traffic|impressions)\b/i.test(task)
      ? "listing_views"
      : /\bsearch(?:es)?\b/i.test(task)
        ? "searches"
        : undefined;
  const community = COMMUNITY_ALIASES.find(([re]) => re.test(task))?.[1];
  const platform: Platform | undefined = /\b(ios|iphone)\b/i.test(task) ? "ios" : /\bandroid\b/i.test(task) ? "android" : /\b(web|desktop|website)\b/i.test(task) ? "web" : undefined;

  const place = [...task.matchAll(/\b(?:in|at)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/g)].map((m) => m[1]!).find((p) => !NOT_PLACES.test(p.split(" ")[0]!) && !COMMUNITY_ALIASES.some(([re]) => re.test(p)));
  if (place && !community) {
    return { status: "need_info", question: `I don't have data for "${place}". I can investigate: ${COMMUNITIES.join(", ")}. Which area do you mean?` };
  }
  if (!metric) {
    return { status: "need_info", question: "Which metric changed (leads, listing views or searches), and roughly where (an area or a platform)?" };
  }
  const segment = { ...(community ? { community } : {}), ...(platform ? { platform } : {}) };
  const where = [community, platform].filter(Boolean).join(" / ") || "all traffic";
  return { status: "ok", problem: { metric, segment, statement: `${metric} for ${where} appear to have dropped.` } };
}

export function playbookDecision(view: AgentView): unknown {
  const ev = view.evidence;
  // A tool that failed counts as "done" so the playbook routes around it.
  const has = (tool: string, pred: (f: Record<string, unknown>) => boolean = () => true) =>
    view.failedTools.includes(tool) || ev.some((e) => e.tool === tool && pred(e.facts));
  const latest = (tool: string) => [...ev].reverse().find((e) => e.tool === tool)?.facts;
  const { metric, segment } = view.problem;
  const call = (tool: string, args: Record<string, unknown>, reason: string) => ({ action: "call_tool", tool, args, reason });

  if (view.remaining.toolCalls <= 0) return { action: "conclude", reason: "Tool budget exhausted." };

  const anomaly = latest("detect_anomaly");
  if (!anomaly) return call("detect_anomaly", { metric, segment }, "First establish whether there is a significant drop and when it started.");
  if (!anomaly.significant) return { action: "conclude", reason: "No significant drop; nothing further to explain." };

  const pipeline = latest("check_pipeline_health");
  if (!has("check_pipeline_health")) return call("check_pipeline_health", {}, "Rule out missing data before blaming user behaviour.");
  if (pipeline?.overlapsEpisode) return { action: "conclude", reason: "Ingestion failed during the drop: data gap." };

  if (!has("funnel_check")) return call("funnel_check", { segment }, "Separate traffic/supply drops from conversion breaks.");
  if (!segment.platform && !has("breakdown", (f) => f.dimension === "platform")) {
    return call("breakdown", { metric, dimension: "platform" }, "A release or flag usually hits one platform.");
  }
  if (!has("list_changes")) return call("list_changes", { hoursBefore: 48, hoursAfter: 12 }, "Look for deployments or flag changes near the onset.");

  // Concrete examples for the reviewer once supply is known to have dropped. This
  // runs before concluding, which also means untrusted listing text reaches the
  // evidence, so the injection defences are exercised in mock mode too.
  const funnel = latest("funnel_check") as { viewsEffectPct: number; conversionEffectPct: number } | undefined;
  const supply = latest("get_supply") as { effectPct: number } | undefined;
  if (supply && supply.effectPct <= -20 && segment.community && !has("sample_listings")) {
    return call("sample_listings", { community: segment.community, limit: 3 }, "Look at example listings to see why supply fell.");
  }
  if (view.verdict.kind === "conclusive") return { action: "conclude", reason: `Evidence supports ${view.verdict.hypothesis}.` };
  if (!has("get_supply") && funnel && funnel.viewsEffectPct <= -15) {
    return call("get_supply", segment.community ? { community: segment.community } : {}, "Views fell along with leads: check whether listings disappeared.");
  }
  return { action: "conclude", reason: "Playbook complete." };
}

export const mockProvider: AgentProvider = {
  name: "mock",
  isLlm: false,
  async interpretTask({ task }) {
    return parseTaskDeterministically(task);
  },
  async decide(view) {
    return playbookDecision(view);
  },
  async writeReport(view) {
    return buildDeterministicReport(view.problem, view.evidence.map((e) => ({ ...e, createdAt: "" })), view.assessments);
  },
};
