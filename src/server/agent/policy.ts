import type { Assessment, Evidence, RecommendedAction, Report } from "@/domain/types";
import type { TelemetryRepository } from "../repositories/telemetry";

/**
 * Decides whether a recommended action may even be *proposed* for human
 * approval. Nothing here executes anything. The checks are independent of the
 * model's reasoning, so an injected or confused recommendation is dropped.
 */
export interface PolicyResult {
  allowed: boolean;
  reason: string;
  reversible: boolean;
}

export async function checkActionPolicy(
  action: RecommendedAction,
  ctx: { dataset: string; repo: TelemetryRepository; report: Report; evidence: readonly Evidence[]; assessments: readonly Assessment[] },
): Promise<PolicyResult> {
  const cited = new Set(action.evidenceIds);
  if (![...cited].every((id) => ctx.evidence.some((e) => e.id === id))) return deny("cites evidence that does not exist");

  if (action.type === "rollback_feature_flag") {
    const flagAssessment = ctx.assessments.find((a) => a.hypothesis === "feature_flag");
    if (ctx.report.conclusion !== "feature_flag" || flagAssessment?.status !== "supported") {
      return deny("a flag rollback requires the feature-flag hypothesis to be supported by evidence");
    }
    const flag = await ctx.repo.flag(ctx.dataset, action.flagKey);
    if (!flag) return deny(`flag "${action.flagKey}" does not exist`);
    if (!flag.enabled) return deny(`flag "${action.flagKey}" is already disabled`);
    const changeEvidence = ctx.evidence.filter((e) => e.tool === "list_changes" && cited.has(e.id));
    const changedNearOnset = changeEvidence.some((e) =>
      (e.facts.changes as Array<{ kind: string; key: string; nearOnset: boolean }>).some((c) => c.kind === "flag" && c.key === action.flagKey && c.nearOnset),
    );
    if (!changedNearOnset) return deny(`no cited evidence shows "${action.flagKey}" changing near the onset`);
    return { allowed: true, reason: "flag changed at the onset and the drop is concentrated on its platform", reversible: true };
  }

  if (action.type === "create_incident_ticket") {
    if (ctx.report.conclusion === "no_anomaly") return deny("no incident to open a ticket for");
    return { allowed: true, reason: "ticket cites existing evidence", reversible: false };
  }

  return deny("unknown action type");
}

const deny = (reason: string): PolicyResult => ({ allowed: false, reason, reversible: false });
