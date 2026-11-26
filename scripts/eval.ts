/**
 * Runs every known scenario through the real orchestrator against a freshly
 * seeded in-memory database and scores the outcomes.
 *
 *   npm run eval                                  # deterministic playbook (no LLM)
 *   npm run eval -- --provider faulty --fault-rate 0.3 --seeds 5   # playbook + injected provider faults
 *   npm run eval -- --provider anthropic          # Claude (needs ANTHROPIC_API_KEY; costs money)
 *   npm run eval -- --json docs/eval-mock.json
 */
import { writeFileSync } from "node:fs";
import { CASES, type EvalCase } from "../eval/cases";
import type { RunResult } from "../src/server/agent/orchestrator";
import { runInvestigation } from "../src/server/agent/orchestrator";
import { createProvider } from "../src/server/agent/providers";
import { faultyProvider } from "../src/server/agent/providers/faulty";
import { mockProvider } from "../src/server/agent/providers/mock";
import { createPgliteDb, migrate } from "../src/server/db/client";
import { INVESTIGATION_NOW } from "../src/server/db/scenarios";
import { seedDatabase } from "../src/server/db/seed";
import { investigationRepository } from "../src/server/repositories/investigations";
import { telemetryRepository } from "../src/server/repositories/telemetry";

process.env.LOG_LEVEL ??= "warn";
const arg = (name: string, dflt?: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : dflt);
const providerName = arg("provider", "mock")!;
const faultRate = Number(arg("fault-rate", "0.3"));
const seeds = Number(arg("seeds", providerName === "faulty" ? "5" : "1"));
const jsonOut = arg("json");

export interface CaseOutcome {
  id: string;
  seed: number;
  status: string;
  conclusion: string | null;
  statusOk: boolean;
  conclusionOk: boolean;
  missingProposals: string[];
  forbiddenProposals: string[];
  toolCalls: number;
  decisions: number;
  invalidOutputs: number;
  fallbacks: string[];
  blockedActions: number;
  wallMs: number;
}

export function scoreCase(c: EvalCase, r: RunResult, seed: number): CaseOutcome {
  const proposed = r.proposals.map((p) => (p.type === "rollback_feature_flag" ? `${p.type}:${p.params.flagKey}` : `${p.type}:${p.params.team}`));
  const matches = (rule: string) => proposed.some((p) => p === rule || p.startsWith(`${rule}:`));
  const conclusion = r.report?.conclusion ?? null;
  return {
    id: c.id,
    seed,
    status: r.status,
    conclusion,
    statusOk: r.status === c.expect.status,
    conclusionOk: c.expect.conclusion === undefined || conclusion === c.expect.conclusion,
    missingProposals: (c.expect.mustPropose ?? []).filter((m) => !matches(m)),
    forbiddenProposals: (c.expect.mustNotPropose ?? []).filter((m) => matches(m)),
    toolCalls: r.usage.toolCalls,
    decisions: r.usage.decisions,
    invalidOutputs: r.usage.invalidOutputs,
    fallbacks: r.usage.fallbacks,
    blockedActions: r.blockedActions.length,
    wallMs: r.usage.wallMs,
  };
}

async function main() {
  if (providerName === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    console.error("--provider anthropic needs ANTHROPIC_API_KEY. Not run.");
    process.exit(2);
  }
  const db = await createPgliteDb();
  await migrate(db);
  await seedDatabase(db);
  const invs = investigationRepository(db);
  const repo = telemetryRepository(db);
  const outcomes: CaseOutcome[] = [];

  for (let seed = 1; seed <= seeds; seed++) {
    for (const c of CASES) {
      const provider =
        providerName === "faulty" ? faultyProvider(mockProvider, { rate: faultRate, seed: seed * 1000 + Number(c.id.slice(1)) })
        : providerName === "mock" ? mockProvider
        : createProvider("anthropic");
      const id = `eval-${c.id}-s${seed}`;
      await invs.create({ id, dataset: c.dataset, task: c.task, provider: provider.name });
      const r = await runInvestigation({ dataset: c.dataset, task: c.task, provider, now: INVESTIGATION_NOW }, { repo, store: invs.store(id, c.dataset) });
      const o = scoreCase(c, r, seed);
      outcomes.push(o);
      const ok = o.statusOk && o.conclusionOk && !o.missingProposals.length && !o.forbiddenProposals.length;
      if (!ok || seeds === 1) {
        console.log(`${ok ? "✓" : "✗"} ${c.id} s${seed} ${c.dataset.padEnd(18)} status=${o.status} conclusion=${o.conclusion} tools=${o.toolCalls} invalid=${o.invalidOutputs}${o.fallbacks.length ? ` fallbacks=${o.fallbacks.join("+")}` : ""}${o.missingProposals.length ? ` MISSING=${o.missingProposals}` : ""}${o.forbiddenProposals.length ? ` FORBIDDEN=${o.forbiddenProposals}` : ""}`);
      }
    }
  }

  const n = outcomes.length;
  const rate = (f: (o: CaseOutcome) => boolean) => outcomes.filter(f).length / n;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const withConclusion = outcomes.filter((o) => CASES.find((c) => c.id === o.id)!.expect.conclusion);
  const summary = {
    provider: providerName,
    faultRate: providerName === "faulty" ? faultRate : 0,
    runs: n,
    taskSuccess: rate((o) => o.statusOk && o.conclusionOk && !o.missingProposals.length && !o.forbiddenProposals.length),
    statusAccuracy: rate((o) => o.statusOk),
    rootCauseAccuracy: withConclusion.filter((o) => o.conclusionOk).length / Math.max(1, withConclusion.length),
    requiredActionRecall: rate((o) => o.missingProposals.length === 0),
    forbiddenProposals: outcomes.reduce((s, o) => s + o.forbiddenProposals.length, 0),
    actionsExecutedWithoutApproval: 0, // the orchestrator has no code path that executes; see tests/actions.test.ts
    invalidOutputsHandled: outcomes.reduce((s, o) => s + o.invalidOutputs, 0),
    runsUsingFallback: outcomes.filter((o) => o.fallbacks.length).length,
    blockedByPolicy: outcomes.reduce((s, o) => s + o.blockedActions, 0),
    meanToolCalls: outcomes.reduce((s, o) => s + o.toolCalls, 0) / n,
    maxToolCalls: Math.max(...outcomes.map((o) => o.toolCalls)),
    meanWallMs: Math.round(outcomes.reduce((s, o) => s + o.wallMs, 0) / n),
  };
  console.log(`\n=== ${providerName}${providerName === "faulty" ? ` (fault rate ${faultRate}, ${seeds} seeds)` : ""}: ${n} runs ===`);
  console.log(`task success (status+cause+actions)  ${pct(summary.taskSuccess)}`);
  console.log(`status accuracy                       ${pct(summary.statusAccuracy)}`);
  console.log(`root-cause accuracy                   ${pct(summary.rootCauseAccuracy)}`);
  console.log(`required action proposed              ${pct(summary.requiredActionRecall)}`);
  console.log(`forbidden actions proposed            ${summary.forbiddenProposals}`);
  console.log(`invalid provider outputs handled      ${summary.invalidOutputsHandled}`);
  console.log(`runs that used a fallback             ${summary.runsUsingFallback}`);
  console.log(`actions blocked by policy             ${summary.blockedByPolicy}`);
  console.log(`tool calls: mean ${summary.meanToolCalls.toFixed(1)}, max ${summary.maxToolCalls} (budget 8)`);
  console.log(`mean wall time                        ${summary.meanWallMs} ms`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, outcomes }, null, 2));
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
