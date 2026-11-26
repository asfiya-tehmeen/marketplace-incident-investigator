import { hoursBetween } from "./analysis";
import type { Assessment, Evidence, HypothesisId } from "./types";

/**
 * Deterministic hypothesis assessment from evidence facts. The model may choose
 * which tools to run, but it cannot change these verdicts; the report validator
 * only accepts conclusions that are "supported" here.
 */

/** A change counts as a cause only if it lands this close to the onset. */
export const CHANGE_WINDOW_BEFORE_H = 6;
export const CHANGE_WINDOW_AFTER_H = 3;
/** A platform "concentrates" the drop if it fell this much while others stayed near baseline. */
export const CONCENTRATED_DROP = -30;
export const OTHERS_STABLE = -10;
export const SUPPLY_DROP = -20;
export const CONVERSION_STABLE = 10;

interface AnomalyFacts { significant: boolean; onset: string | null; end: string | null; ongoing: boolean; effectPct: number; z: number }
interface PipelineFacts { failedHours: string[]; overlapsEpisode: boolean; checkedFrom: string; checkedTo: string }
interface BreakdownFacts { dimension: string; segments: Array<{ value: string; effectPct: number }> }
interface ChangeFacts { changes: Array<{ kind: "deploy" | "flag"; key: string; platform: string | null; ts: string; hoursFromOnset: number | null; description: string }> }
interface SupplyFacts { effectPct: number; topAgency: string | null; topAgencyEffectPct: number | null }
interface FunnelFacts { viewsEffectPct: number; leadsEffectPct: number; conversionEffectPct: number }

const latest = <T,>(ev: Evidence[], tool: string): { e: Evidence; f: T } | undefined => {
  const e = [...ev].reverse().find((x) => x.tool === tool && !("error" in x.facts));
  return e ? { e, f: e.facts as T } : undefined;
};

export function nearOnset(changeTs: string, onset: string): boolean {
  const h = hoursBetween(onset, changeTs); // negative = before onset
  return h >= -CHANGE_WINDOW_BEFORE_H && h <= CHANGE_WINDOW_AFTER_H;
}

export function assess(evidence: Evidence[]): Assessment[] {
  const anomaly = latest<AnomalyFacts>(evidence, "detect_anomaly");
  const pipeline = latest<PipelineFacts>(evidence, "check_pipeline_health");
  const platform = [...evidence].reverse().find((e) => e.tool === "breakdown" && (e.facts as unknown as BreakdownFacts).dimension === "platform");
  const changes = latest<ChangeFacts>(evidence, "list_changes");
  const supply = latest<SupplyFacts>(evidence, "get_supply");
  const funnel = latest<FunnelFacts>(evidence, "funnel_check");

  const out: Record<HypothesisId, Assessment> = {
    no_anomaly: { hypothesis: "no_anomaly", status: "untested", reason: "No anomaly scan yet.", evidenceIds: [] },
    data_gap: { hypothesis: "data_gap", status: "untested", reason: "Pipeline health not checked.", evidenceIds: [] },
    feature_flag: { hypothesis: "feature_flag", status: "untested", reason: "Recent changes not listed.", evidenceIds: [] },
    release: { hypothesis: "release", status: "untested", reason: "Recent changes not listed.", evidenceIds: [] },
    supply_drop: { hypothesis: "supply_drop", status: "untested", reason: "Supply not checked.", evidenceIds: [] },
  };
  if (!anomaly) return Object.values(out);

  if (!anomaly.f.significant) {
    out.no_anomaly = { hypothesis: "no_anomaly", status: "supported", reason: `Largest dip is ${anomaly.f.effectPct}% (z=${anomaly.f.z}), below the significance bar.`, evidenceIds: [anomaly.e.id] };
    for (const h of ["data_gap", "feature_flag", "release", "supply_drop"] as const) {
      out[h] = { hypothesis: h, status: "refuted", reason: "There is no significant drop to explain.", evidenceIds: [anomaly.e.id] };
    }
    return Object.values(out);
  }
  out.no_anomaly = { hypothesis: "no_anomaly", status: "refuted", reason: `Drop of ${anomaly.f.effectPct}% (z=${anomaly.f.z}) is significant.`, evidenceIds: [anomaly.e.id] };
  const onset = anomaly.f.onset!;

  // Data gap
  if (pipeline) {
    out.data_gap = pipeline.f.overlapsEpisode
      ? { hypothesis: "data_gap", status: "supported", reason: `Ingestion failed for ${pipeline.f.failedHours.length} hour(s) overlapping the drop.`, evidenceIds: [pipeline.e.id, anomaly.e.id] }
      : { hypothesis: "data_gap", status: "refuted", reason: "Ingestion pipeline was healthy throughout the drop.", evidenceIds: [pipeline.e.id] };
  }

  // Platform concentration (used by flag and release). If the anomaly was measured
  // on a single platform, the drop is on that platform by construction.
  const scopedPlatform = (anomaly.f as unknown as { segment?: { platform?: string } }).segment?.platform ?? null;
  const pf = platform?.facts as unknown as BreakdownFacts | undefined;
  const hit = pf?.segments.filter((s) => s.effectPct <= CONCENTRATED_DROP).map((s) => s.value) ?? [];
  const othersStable = pf ? pf.segments.filter((s) => !hit.includes(s.value)).every((s) => s.effectPct > OTHERS_STABLE) : false;
  const concentratedOn = scopedPlatform ?? (pf && hit.length === 1 && othersStable ? hit[0]! : null);
  const platformKnown = Boolean(scopedPlatform || pf);

  if (changes) {
    for (const kind of ["flag", "deploy"] as const) {
      const h = kind === "flag" ? "feature_flag" : "release";
      const near = changes.f.changes.filter((c) => c.kind === kind && nearOnset(c.ts, onset));
      const ids = [changes.e.id, anomaly.e.id, ...(platform ? [platform.id] : [])];
      if (near.length === 0) {
        out[h] = { hypothesis: h, status: "refuted", reason: `No ${kind === "flag" ? "flag change" : "release"} within ${CHANGE_WINDOW_BEFORE_H}h before / ${CHANGE_WINDOW_AFTER_H}h after the onset.`, evidenceIds: [changes.e.id] };
        continue;
      }
      const matching = near.filter((c) => c.platform === null || c.platform === concentratedOn);
      if (!platformKnown) {
        out[h] = { hypothesis: h, status: "weak", reason: `${near.map((c) => c.key).join(", ")} changed near the onset; platform breakdown not yet checked.`, evidenceIds: ids };
      } else if (concentratedOn && matching.some((c) => c.platform === concentratedOn)) {
        const c = matching.find((x) => x.platform === concentratedOn)!;
        out[h] = { hypothesis: h, status: "supported", reason: `${c.key} (${c.platform}) changed ${Math.abs(c.hoursFromOnset ?? 0)}h ${(c.hoursFromOnset ?? 0) <= 0 ? "before" : "after"} the onset, and the drop is concentrated on ${concentratedOn}.`, evidenceIds: ids };
      } else {
        out[h] = { hypothesis: h, status: "weak", reason: `${near.map((c) => `${c.key} (${c.platform ?? "all"})`).join(", ")} changed near the onset, but the drop is not concentrated on that platform.`, evidenceIds: ids };
      }
    }
  }

  // Supply
  if (supply) {
    const convStable = funnel ? Math.abs(funnel.f.conversionEffectPct) <= CONVERSION_STABLE : null;
    const ids = [supply.e.id, ...(funnel ? [funnel.e.id] : [])];
    if (supply.f.effectPct > SUPPLY_DROP) {
      out.supply_drop = { hypothesis: "supply_drop", status: "refuted", reason: `Active listings changed ${supply.f.effectPct}%, not enough to explain the drop.`, evidenceIds: ids };
    } else if (convStable === false) {
      out.supply_drop = { hypothesis: "supply_drop", status: "weak", reason: `Supply fell ${supply.f.effectPct}%, but conversion also moved ${funnel!.f.conversionEffectPct}%, so supply alone doesn't explain it.`, evidenceIds: ids };
    } else {
      out.supply_drop = {
        hypothesis: "supply_drop",
        status: convStable ? "supported" : "weak",
        reason: `Active listings fell ${supply.f.effectPct}%${supply.f.topAgency ? ` (largest: ${supply.f.topAgency}, ${supply.f.topAgencyEffectPct}%)` : ""}${convStable ? " while conversion stayed stable" : "; conversion not checked"}.`,
        evidenceIds: ids,
      };
    }
  }
  return Object.values(out);
}

export type Verdict =
  | { kind: "conclusive"; hypothesis: HypothesisId; confidenceCap: "high" | "medium" }
  | { kind: "ambiguous"; candidates: HypothesisId[] }
  | { kind: "open" };

/** What the evidence currently allows the agent to conclude. */
export function verdict(assessments: Assessment[]): Verdict {
  const supported = assessments.filter((a) => a.status === "supported").map((a) => a.hypothesis);
  if (supported.length === 1) {
    const h = supported[0]!;
    if (h === "no_anomaly") return { kind: "conclusive", hypothesis: h, confidenceCap: "high" };
    const untested = assessments.filter((a) => a.status === "untested" && a.hypothesis !== h).length;
    const weak = assessments.filter((a) => a.status === "weak").length;
    return { kind: "conclusive", hypothesis: h, confidenceCap: untested === 0 && weak === 0 ? "high" : "medium" };
  }
  if (supported.length > 1) return { kind: "ambiguous", candidates: supported };
  return { kind: "open" };
}
