import { verdict } from "./hypotheses";
import { HYPOTHESES, type Assessment, type Evidence, type HypothesisId, type Problem, type RecommendedAction, type Report } from "./types";

/**
 * Builds a report purely from evidence and assessments. Used by the mock
 * provider and as the fail-safe when a model can't produce a valid report.
 * Every sentence is derived from evidence summaries, so it always validates.
 */
export function buildDeterministicReport(problem: Problem, evidence: readonly Evidence[], assessments: readonly Assessment[]): Report {
  const v = verdict([...assessments]);
  const anomaly = [...evidence].reverse().find((e) => e.tool === "detect_anomaly");
  const conclusion: Report["conclusion"] = v.kind === "conclusive" ? v.hypothesis : "undetermined";
  const confidence: Report["confidence"] = v.kind === "conclusive" ? v.confidenceCap : "low";

  const claims: Report["claims"] = [];
  if (anomaly) claims.push({ text: anomaly.summary, evidenceIds: [anomaly.id] });
  for (const a of assessments) {
    if (a.status === "supported" && a.hypothesis !== "no_anomaly" && a.evidenceIds.length) {
      claims.push({ text: `${HYPOTHESES[a.hypothesis]}: ${a.reason}`, evidenceIds: a.evidenceIds });
    }
  }
  for (const id of ["breakdown", "funnel_check", "get_supply"]) {
    const e = [...evidence].reverse().find((x) => x.tool === id);
    if (e && claims.length < 6) claims.push({ text: e.summary, evidenceIds: [e.id] });
  }
  // Callers never ask for a report without evidence (the orchestrator stops first).

  const alternatives: Report["alternatives"] = assessments
    .filter((a) => a.hypothesis !== conclusion && a.status !== "untested" && !(conclusion === "no_anomaly"))
    .slice(0, 5)
    .map((a) => ({ hypothesis: a.hypothesis, verdict: a.status === "refuted" ? "rejected" : "possible", reason: a.reason, evidenceIds: a.evidenceIds }));

  const untested = assessments.filter((a) => a.status === "untested").map((a) => HYPOTHESES[a.hypothesis].toLowerCase());
  const openQuestions = conclusion === "no_anomaly" ? [] : untested.slice(0, 3).map((u) => `Not checked: ${u}.`);

  const summary =
    conclusion === "no_anomaly"
      ? `No significant drop in ${problem.metric} for ${segmentText(problem)}. ${anomaly?.summary ?? ""}`.trim()
      : conclusion === "undetermined"
        ? `The drop in ${problem.metric} for ${segmentText(problem)} is real, but the evidence does not single out a cause.`
        : `Most likely cause: ${HYPOTHESES[conclusion].toLowerCase()}. ${assessments.find((a) => a.hypothesis === conclusion)?.reason ?? ""}`;

  return { conclusion, confidence, summary: summary.slice(0, 800), claims: claims.slice(0, 10), alternatives, recommendedActions: recommend(conclusion, evidence, assessments), openQuestions };
}

function segmentText(p: Problem): string {
  return [p.segment.community, p.segment.platform].filter(Boolean).join(" / ") || "all traffic";
}

function recommend(conclusion: Report["conclusion"], evidence: readonly Evidence[], assessments: readonly Assessment[]): RecommendedAction[] {
  const a = (h: HypothesisId) => assessments.find((x) => x.hypothesis === h)!;
  const changes = [...evidence].reverse().find((e) => e.tool === "list_changes");
  const near = ((changes?.facts.changes as Array<{ kind: string; key: string; platform: string | null; nearOnset: boolean }>) ?? []).filter((c) => c.nearOnset);
  switch (conclusion) {
    case "feature_flag": {
      const flag = near.find((c) => c.kind === "flag");
      if (!flag || !changes) return [];
      return [{ type: "rollback_feature_flag", flagKey: flag.key, rationale: `Disable ${flag.key}: ${a("feature_flag").reason}`.slice(0, 500), evidenceIds: a("feature_flag").evidenceIds }];
    }
    case "release": {
      const dep = near.find((c) => c.kind === "deploy");
      const team = dep?.platform === "web" ? "web" : "mobile";
      return [{ type: "create_incident_ticket", team, title: `Lead drop after ${dep?.key ?? "release"}`.slice(0, 120), rationale: a("release").reason.slice(0, 500), evidenceIds: a("release").evidenceIds }];
    }
    case "supply_drop":
      return [{ type: "create_incident_ticket", team: "supply", title: "Large drop in active listings", rationale: a("supply_drop").reason.slice(0, 500), evidenceIds: a("supply_drop").evidenceIds }];
    case "data_gap":
      return [{ type: "create_incident_ticket", team: "data-platform", title: "Backfill missing event data", rationale: a("data_gap").reason.slice(0, 500), evidenceIds: a("data_gap").evidenceIds }];
    default:
      return [];
  }
}
