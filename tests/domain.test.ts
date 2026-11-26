import { describe, expect, it } from "vitest";
import { detectDrop, type HourPoint } from "@/domain/analysis";
import { assess, verdict } from "@/domain/hypotheses";
import { validateReport } from "@/domain/reportValidation";
import type { Evidence, Report } from "@/domain/types";

// ---------- synthetic series helpers ----------
const START = Date.parse("2026-09-29T00:00:00Z");
function series(fn: (i: number, hour: number) => number): HourPoint[] {
  return Array.from({ length: 21 * 24 }, (_, i) => ({ ts: new Date(START + i * 3_600_000).toISOString().replace(".000", ""), value: Math.round(fn(i, i % 24)) }));
}
// Deterministic ±10% wobble so noise SD is non-zero.
const wobble = (i: number) => 1 + 0.1 * Math.sin(i * 12.9898) * Math.cos(i * 78.233);
const base = (i: number, h: number) => (200 + 150 * Math.sin((Math.PI * (h - 3)) / 18)) * wobble(i);
const WEEK3 = 14 * 24;

describe("detectDrop", () => {
  it("finds nothing in stable data", () => {
    const e = detectDrop(series((i, h) => base(i, h)));
    expect(e.significant).toBe(false);
  });

  it("finds an ongoing step drop and its onset block", () => {
    const onsetHour = WEEK3 + 3 * 24 + 10; // day 18, 10:00
    const e = detectDrop(series((i, h) => base(i, h) * (i >= onsetHour ? 0.5 : 1)));
    expect(e.significant).toBe(true);
    expect(e.ongoing).toBe(true);
    expect(e.onset).toBe("2026-10-16T09:00:00Z"); // the 3h block containing 10:00
    expect(e.effectPct).toBeLessThan(-40);
  });

  it("finds a transient gap with an end", () => {
    const from = WEEK3 + 5 * 24 + 12, to = from + 6;
    const e = detectDrop(series((i, h) => base(i, h) * (i >= from && i < to ? 0.02 : 1)));
    expect(e.significant).toBe(true);
    expect(e.ongoing).toBe(false);
    expect(e.onset).toBe("2026-10-18T12:00:00Z");
    expect(e.end).toBe("2026-10-18T18:00:00Z");
  });

  it("ignores a short, mild dip (night-time noise guard)", () => {
    const from = WEEK3 + 2 * 24, to = from + 6;
    const e = detectDrop(series((i, h) => base(i, h) * (i >= from && i < to ? 0.8 : 1)));
    expect(e.significant).toBe(false);
  });

  it("rejects series that are too short", () => {
    expect(() => detectDrop([])).toThrow(/21 days/);
  });
});

// ---------- evidence fixtures ----------
const ev = (id: string, tool: string, facts: Record<string, unknown>, summary = ""): Evidence => ({ id, tool, args: {}, summary, facts, createdAt: "" });
const ANOMALY = ev("E1", "detect_anomaly", { significant: true, onset: "2026-10-16T09:00:00Z", end: null, ongoing: true, effectPct: -40.2, z: -30, segment: {} }, "leads -40.2%");
const PIPE_OK = ev("E2", "check_pipeline_health", { failedHours: [], overlapsEpisode: false });
const BY_PLATFORM_IOS = ev("E3", "breakdown", { dimension: "platform", segments: [{ value: "ios", effectPct: -78 }, { value: "android", effectPct: -2 }, { value: "web", effectPct: 1 }] });
const BY_PLATFORM_EVEN = ev("E3", "breakdown", { dimension: "platform", segments: [{ value: "ios", effectPct: -40 }, { value: "android", effectPct: -41 }, { value: "web", effectPct: -39 }] });
const changes = (list: Array<{ kind: "flag" | "deploy"; key: string; platform: string | null; ts: string }>) =>
  ev("E4", "list_changes", { changes: list.map((c) => ({ ...c, description: "", hoursFromOnset: (Date.parse(c.ts) - Date.parse("2026-10-16T09:00:00Z")) / 3_600_000 })) });
const status = (es: Evidence[]) => Object.fromEntries(assess(es).map((a) => [a.hypothesis, a.status]));

describe("hypothesis assessment", () => {
  it("supports a flag that changed at the onset on the platform that dropped", () => {
    const s = status([ANOMALY, PIPE_OK, BY_PLATFORM_IOS, changes([{ kind: "flag", key: "contact_sheet_v2", platform: "ios", ts: "2026-10-16T10:00:00Z" }])]);
    expect(s).toMatchObject({ feature_flag: "supported", release: "refuted", data_gap: "refuted", no_anomaly: "refuted" });
  });

  it("treats contradictory evidence as weak: change at onset but the drop is not on its platform", () => {
    const s = status([ANOMALY, BY_PLATFORM_EVEN, changes([{ kind: "flag", key: "x", platform: "ios", ts: "2026-10-16T10:00:00Z" }])]);
    expect(s.feature_flag).toBe("weak");
  });

  it("refutes a change that happened a day before the onset (red herring)", () => {
    const s = status([ANOMALY, BY_PLATFORM_IOS, changes([{ kind: "deploy", key: "ios-app 7.4.0", platform: "ios", ts: "2026-10-15T09:00:00Z" }])]);
    expect(s.release).toBe("refuted");
  });

  it("reports ambiguity when two hypotheses are supported", () => {
    const es = [
      ANOMALY,
      ev("E2", "check_pipeline_health", { failedHours: ["2026-10-16T12:00:00Z"], overlapsEpisode: true }),
      BY_PLATFORM_IOS,
      changes([{ kind: "flag", key: "f", platform: "ios", ts: "2026-10-16T09:00:00Z" }]),
    ];
    const v = verdict(assess(es));
    expect(v).toEqual({ kind: "ambiguous", candidates: expect.arrayContaining(["data_gap", "feature_flag"]) });
  });

  it("does not support supply when conversion also broke", () => {
    const s = status([ANOMALY, ev("E5", "get_supply", { effectPct: -35, topAgency: "A", topAgencyEffectPct: -90 }), ev("E6", "funnel_check", { viewsEffectPct: -35, leadsEffectPct: -70, conversionEffectPct: -54 })]);
    expect(s.supply_drop).toBe("weak");
  });

  it("concludes no anomaly and refutes everything else when the dip is not significant", () => {
    const v = verdict(assess([ev("E1", "detect_anomaly", { significant: false, onset: null, end: null, effectPct: -6, z: -1.2 })]));
    expect(v).toEqual({ kind: "conclusive", hypothesis: "no_anomaly", confidenceCap: "high" });
  });
});

describe("report validation", () => {
  const evidence = [ANOMALY, PIPE_OK, BY_PLATFORM_IOS, changes([{ kind: "flag", key: "contact_sheet_v2", platform: "ios", ts: "2026-10-16T10:00:00Z" }])];
  const assessments = assess(evidence);
  const v = verdict(assessments);
  const good: Report = {
    conclusion: "feature_flag",
    confidence: "medium",
    summary: "The contact sheet flag broke iOS leads.",
    claims: [{ text: "Leads fell 40.2% from the onset.", evidenceIds: ["E1"] }, { text: "iOS fell 78% while Android and web were flat.", evidenceIds: ["E3"] }],
    alternatives: [{ hypothesis: "data_gap", verdict: "rejected", reason: "Pipeline healthy.", evidenceIds: ["E2"] }],
    recommendedActions: [{ type: "rollback_feature_flag", flagKey: "contact_sheet_v2", rationale: "r", evidenceIds: ["E4"] }],
    openQuestions: [],
  };

  it("accepts a report that matches the evidence", () => {
    expect(validateReport(good, evidence, assessments, v)).toMatchObject({ ok: true });
  });

  it.each([
    ["malformed output", { nonsense: true }, /schema/],
    ["a citation to evidence that doesn't exist", { ...good, claims: [{ text: "Logs confirm it.", evidenceIds: ["E99"] }] }, /E99/],
    ["an unsupported conclusion", { ...good, conclusion: "release" }, /not supported/],
    ["overconfidence", { ...good, confidence: "high" }, /exceeds/],
    ["a number not in the cited evidence", { ...good, claims: [{ text: "Leads fell 97%.", evidenceIds: ["E1"] }] }, /97%/],
    ["rejecting an alternative the evidence didn't refute", { ...good, alternatives: [{ hypothesis: "supply_drop", verdict: "rejected", reason: "", evidenceIds: [] }] }, /untested/],
  ])("rejects %s", (_name, report, pattern) => {
    const r = validateReport(report, evidence, assessments, v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toMatch(pattern);
  });
});
