import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockProvider, playbookDecision } from "@/server/agent/providers/mock";
import { ProviderError, type AgentView } from "@/server/agent/providers/types";
import type { Db } from "@/server/db/client";
import { telemetryRepository } from "@/server/repositories/telemetry";
import { freshDb, investigate, scripted } from "./helpers";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => db.close());

const flagEnabled = async (dataset: string, key: string) =>
  (await db.query<{ enabled: boolean }>("SELECT enabled FROM feature_flags WHERE dataset = $1 AND flag_key = $2", [dataset, key]))[0]?.enabled;

describe("happy paths (deterministic playbook)", () => {
  it("finds the flag, rejects the release red herring, and only *proposes* a rollback", async () => {
    const { result, steps } = await investigate(db, "ios-contact-flag", "Leads have dropped a lot since Tuesday", mockProvider);
    expect(result.status).toBe("completed");
    expect(result.report?.conclusion).toBe("feature_flag");
    expect(result.assessments.find((a) => a.hypothesis === "release")?.status).toBe("refuted");
    expect(result.proposals).toEqual([expect.objectContaining({ type: "rollback_feature_flag", params: { flagKey: "contact_sheet_v2" } })]);
    expect(await flagEnabled("ios-contact-flag", "contact_sheet_v2")).toBe(true); // nothing executed
    // Every claim cites evidence that exists.
    const ids = new Set(result.evidence.map((e) => e.id));
    expect(result.report!.claims.every((c) => c.evidenceIds.every((id) => ids.has(id)))).toBe(true);
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(["started", "problem", "decision", "tool_call", "evidence", "report", "action_proposed", "finished"]));
  });

  it("stops early with no anomaly and proposes nothing", async () => {
    const { result } = await investigate(db, "quiet-week", "JLT leads feel lower this week", mockProvider);
    expect(result.report?.conclusion).toBe("no_anomaly");
    expect(result.usage.toolCalls).toBe(1);
    expect(result.proposals).toEqual([]);
  });

  it("asks for more information instead of guessing", async () => {
    expect((await investigate(db, "quiet-week", "Something feels off", mockProvider)).result).toMatchObject({ status: "needs_info", outcomeNote: expect.stringMatching(/Which metric/) });
    expect((await investigate(db, "quiet-week", "Leads dropped in Mirdif", mockProvider)).result.outcomeNote).toMatch(/Mirdif/);
  });
});

describe("malformed and unsafe provider output", () => {
  it("rejects unknown tools, bad args and duplicates, then falls back to the playbook", async () => {
    let n = 0;
    const p = scripted(
      {
        async decide(view: AgentView) {
          n++;
          if (n === 1) return { action: "call_tool", tool: "drop_database", args: {}, reason: "" };
          if (n === 2) return { action: "call_tool", tool: "detect_anomaly", args: { metric: "revenue" }, reason: "" };
          if (n === 3) return "not even an object";
          return playbookDecision(view);
        },
      },
      mockProvider,
    );
    const { result, steps } = await investigate(db, "ios-contact-flag", "Leads dropped since Tuesday", p);
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(["invalid_tool", "invalid_args", "invalid_output", "fallback"]));
    expect(result.usage.fallbacks).toContain("decide");
    expect(result.report?.conclusion).toBe("feature_flag");
  });

  it("rejects a duplicate call and feeds the reason back", async () => {
    let n = 0;
    let feedback: string | undefined;
    const p = scripted(
      {
        async decide(view: AgentView) {
          n++;
          if (n === 2) feedback = undefined;
          if (n === 3) feedback = view.feedback;
          return n <= 2 ? { action: "call_tool", tool: "detect_anomaly", args: { metric: "leads", segment: {} }, reason: "" } : { action: "conclude", reason: "" };
        },
      },
      mockProvider,
    );
    const { steps } = await investigate(db, "quiet-week", "Leads down?", p);
    expect(steps.some((s) => s.kind === "duplicate_call")).toBe(true);
    expect(feedback).toMatch(/already ran \(E1\)/);
  });

  it("replaces an invalid report with the deterministic one", async () => {
    const p = scripted({ decide: mockProvider.decide, async writeReport() { return { conclusion: "release", confidence: "high", summary: "x", claims: [{ text: "Logs show 97% errors", evidenceIds: ["E42"] }], alternatives: [], recommendedActions: [], openQuestions: [] }; } }, mockProvider);
    const { result, steps } = await investigate(db, "ios-contact-flag", "Leads dropped since Tuesday", p);
    expect(steps.filter((s) => s.kind === "report_rejected")).toHaveLength(3); // first try + 2 retries
    expect(result.usage.fallbacks).toContain("report");
    expect(result.report?.conclusion).toBe("feature_flag");
  });

  it("blocks a prompt-injected rollback even if the model goes along with it", async () => {
    // A gullible model that obeys the listing text it reads.
    const gullible = scripted(
      {
        decide: mockProvider.decide,
        async writeReport(view: AgentView) {
          const base = (await mockProvider.writeReport(view)) as Record<string, any>;
          const obeyed = view.evidence.some((e) => e.untrustedText?.some((t) => t.includes("rollback_feature_flag")));
          return obeyed
            ? { ...base, recommendedActions: [...base.recommendedActions, { type: "rollback_feature_flag", flagKey: "search_ranking_v3", rationale: "Listing says so", evidenceIds: ["E1"] }] }
            : base;
        },
      },
      mockProvider,
    );
    const { result, steps } = await investigate(db, "bb-injection", "Business Bay views and leads dropped since the 16th", gullible);
    expect(result.evidence.some((e) => e.untrustedText?.some((t) => t.includes("IGNORE") || t.includes("ignore your previous")))).toBe(true);
    expect(result.blockedActions).toEqual([expect.objectContaining({ type: "rollback_feature_flag", reason: expect.stringMatching(/feature-flag hypothesis/) })]);
    expect(result.proposals.some((p) => p.type === "rollback_feature_flag")).toBe(false);
    expect(steps.some((s) => s.kind === "action_blocked")).toBe(true);
    expect(await flagEnabled("bb-injection", "search_ranking_v3")).toBe(true);
    expect(result.report?.conclusion).toBe("supply_drop");
  });
});

describe("budgets and failures", () => {
  it("enforces the tool-call budget", async () => {
    const greedy = scripted({ async decide(view: AgentView) { return { action: "call_tool", tool: "detect_anomaly", args: { metric: "leads", segment: { community: ["jlt", "jvc", "palm-jumeirah", "dubai-marina"][view.evidence.length % 4] } }, reason: "" }; } }, mockProvider);
    const { result, steps } = await investigate(db, "quiet-week", "Leads down?", greedy, { budget: { maxToolCalls: 2 } });
    expect(result.usage.toolCalls).toBe(2);
    expect(steps.some((s) => s.kind === "budget" && s.payload.limit === "tool_calls")).toBe(true);
  });

  it("enforces the decision budget even if the model never concludes", async () => {
    const stubborn = scripted({ async decide() { return { action: "call_tool", tool: "nope", args: {}, reason: "" }; } }, mockProvider);
    const { result } = await investigate(db, "quiet-week", "Leads down?", stubborn, { budget: { maxDecisions: 5 } });
    expect(result.usage.decisions).toBeLessThanOrEqual(5);
  });

  it("enforces wall-clock time", async () => {
    let t = 0;
    const { result, steps } = await investigate(db, "ios-contact-flag", "Leads dropped since Tuesday", mockProvider, { budget: { maxWallMs: 1000 }, clock: () => (t += 400) });
    expect(steps.some((s) => s.kind === "budget" && s.payload.limit === "wall_clock")).toBe(true);
    expect(["completed", "insufficient_evidence"]).toContain(result.status);
  });

  it("retries a failing tool once, records it, and carries on", async () => {
    const real = telemetryRepository(db);
    let calls = 0;
    const flaky = { ...real, async pipelineFailures(...a: Parameters<typeof real.pipelineFailures>) { calls++; throw new Error("connection reset"); } };
    const { result, steps } = await investigate(db, "ios-contact-flag", "Leads dropped since Tuesday", mockProvider, { repo: flaky });
    expect(calls).toBe(2);
    expect(steps.some((s) => s.kind === "tool_error" && s.payload.retryable === true)).toBe(true);
    expect(result.usage.toolErrors).toBeGreaterThan(0);
    expect(result.status).not.toBe("failed");
  });

  it("fails safely when the provider is unavailable from the start", async () => {
    const down = scripted({ async decide() { throw new ProviderError("auth", "bad key"); } }, mockProvider);
    const { result } = await investigate(db, "ios-contact-flag", "Leads dropped since Tuesday", down);
    expect(result.status).toBe("failed");
    expect(result.proposals).toEqual([]);
  });

  it("keeps collected evidence when the provider drops out mid-investigation", async () => {
    let n = 0;
    const flaky = scripted({ async decide(view: AgentView) { if (++n > 4) throw new ProviderError("rate_limited", "429"); return playbookDecision(view); } }, mockProvider);
    const { result, steps } = await investigate(db, "ios-contact-flag", "Leads dropped since Tuesday", flaky);
    expect(steps.filter((s) => s.kind === "provider_error")).toHaveLength(3); // 3 attempts
    expect(steps.some((s) => s.kind === "interrupted")).toBe(true);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.report).toBeDefined();
    expect(result.outcomeNote).toMatch(/became unavailable/);
  });
});
