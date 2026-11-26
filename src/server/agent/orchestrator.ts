import { buildDeterministicReport } from "@/domain/deterministicReport";
import { assess, verdict } from "@/domain/hypotheses";
import { validateReport } from "@/domain/reportValidation";
import { DEFAULT_BUDGET, Problem, type Assessment, type Budget, type Evidence, type InvestigationStatus, type Report } from "@/domain/types";
import { log } from "../logger";
import type { TelemetryRepository } from "../repositories/telemetry";
import { TOOL_BY_NAME, TOOLS, ToolUsageError, toolJsonSchema, type ToolOutput } from "../tools/registry";
import { checkActionPolicy } from "./policy";
import { parseTaskDeterministically, playbookDecision } from "./providers/mock";
import { Decision, Intake, ProviderError, type AgentProvider, type AgentView } from "./providers/types";

/**
 * Typed state machine:  intake → investigate (bounded loop) → report → propose → done
 *
 * Every transition is recorded in an append-only trace. The provider only
 * proposes; this module validates, enforces budgets and decides what happens.
 * It never throws: every outcome ends in a persisted status.
 */

/** Attempts per provider call for transient failures (timeout, 429, connection). */
export const TRANSIENT_ATTEMPTS = 3;

export interface InvestigationStore {
  step(kind: string, payload: Record<string, unknown>): Promise<void>;
  saveEvidence(e: Evidence): Promise<void>;
  setProblem(p: Problem): Promise<void>;
  saveProgress(assessments: Assessment[], usage: Usage): Promise<void>;
  finish(status: InvestigationStatus, fields: { report?: Report; outcomeNote?: string; usage: Usage; assessments: Assessment[] }): Promise<void>;
  createProposal(p: { type: string; params: Record<string, unknown>; rationale: string; evidenceIds: string[]; reversible: boolean }): Promise<string>;
}

export interface Usage {
  toolCalls: number;
  decisions: number;
  invalidOutputs: number;
  toolErrors: number;
  providerErrors: number;
  fallbacks: string[];
  wallMs: number;
}

export interface RunResult {
  status: InvestigationStatus;
  problem?: Problem;
  report?: Report;
  evidence: Evidence[];
  assessments: Assessment[];
  usage: Usage;
  proposals: Array<{ id: string; type: string; params: Record<string, unknown> }>;
  blockedActions: Array<{ type: string; reason: string }>;
  outcomeNote?: string;
}

export async function runInvestigation(
  input: { dataset: string; task: string; provider: AgentProvider; now: string; budget?: Partial<Budget> },
  deps: { repo: TelemetryRepository; store: InvestigationStore; clock?: () => number },
): Promise<RunResult> {
  const budget: Budget = { ...DEFAULT_BUDGET, ...input.budget };
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const provider = input.provider;
  const store = deps.store;
  const usage: Usage = { toolCalls: 0, decisions: 0, invalidOutputs: 0, toolErrors: 0, providerErrors: 0, fallbacks: [], wallMs: 0 };
  const evidence: Evidence[] = [];
  let assessments: Assessment[] = assess(evidence);
  let problem: Problem | undefined;
  const proposals: RunResult["proposals"] = [];
  const blockedActions: RunResult["blockedActions"] = [];
  const elapsed = () => clock() - started;

  const finish = async (status: InvestigationStatus, extra: { report?: Report; outcomeNote?: string } = {}): Promise<RunResult> => {
    usage.wallMs = elapsed();
    await store.finish(status, { ...extra, usage, assessments });
    await store.step("finished", { status, outcomeNote: extra.outcomeNote, usage });
    log.info("investigation finished", { status, provider: provider.name, toolCalls: usage.toolCalls, decisions: usage.decisions, wallMs: usage.wallMs });
    return { status, problem, report: extra.report, evidence, assessments, usage, proposals, blockedActions, outcomeNote: extra.outcomeNote };
  };

  /** Calls the provider with a timeout and one retry for transient failures. */
  const callProvider = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withTimeout(fn(), budget.providerTimeoutMs, `${label} timed out after ${budget.providerTimeoutMs} ms`);
      } catch (err) {
        usage.providerErrors++;
        const kind = err instanceof ProviderError ? err.kind : "unavailable";
        await store.step("provider_error", { label, kind, message: (err as Error).message, attempt });
        const transient = kind === "timeout" || kind === "rate_limited" || kind === "unavailable";
        if (!transient || attempt >= TRANSIENT_ATTEMPTS - 1) throw err;
        await sleep(400 * 2 ** attempt); // 0.4 s, 0.8 s
      }
    }
  };

  try {
    await store.step("started", { provider: provider.name, isLlm: provider.isLlm, budget, task: input.task });

    // ── INTAKE ────────────────────────────────────────────────────────────
    let feedback: string | undefined;
    for (let attempt = 0; attempt <= budget.maxRetriesPerStep && !problem; attempt++) {
      const raw = await callProvider("intake", () => provider.interpretTask({ task: input.task, now: input.now, feedback }));
      const intake = Intake.safeParse(raw);
      if (intake.success && intake.data.status === "need_info") {
        await store.step("need_info", { question: intake.data.question, phase: "intake" });
        return finish("needs_info", { outcomeNote: intake.data.question });
      }
      const p = intake.success && intake.data.status === "ok" ? Problem.safeParse(intake.data.problem) : null;
      if (p?.success) {
        problem = p.data;
        break;
      }
      usage.invalidOutputs++;
      feedback = p ? `Invalid problem: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : "Output did not match the intake schema.";
      await store.step("invalid_output", { phase: "intake", feedback, attempt });
    }
    if (!problem) {
      // Fail safe: the deterministic parser either finds a problem or asks a question.
      usage.fallbacks.push("intake");
      const fb = Intake.parse(parseTaskDeterministically(input.task));
      await store.step("fallback", { phase: "intake", reason: "provider output stayed invalid" });
      if (fb.status === "need_info") return finish("needs_info", { outcomeNote: fb.question });
      problem = Problem.parse(fb.problem);
    }
    await store.setProblem(problem);
    await store.step("problem", { problem });

    // ── INVESTIGATE ───────────────────────────────────────────────────────
    const ctx = { dataset: input.dataset, repo: deps.repo, problem, evidence };
    const seen = new Map<string, string>();
    // Tool+args that failed after retries. Re-calling them would loop until the budget runs out.
    const failedKeys = new Set<string>();
    const failedTools = new Set<string>();
    let invalidStreak = 0;
    let usePlaybook = false;
    let interrupted: string | undefined;
    feedback = undefined;

    while (true) {
      if (usage.decisions >= budget.maxDecisions) {
        await store.step("budget", { limit: "decisions", used: usage.decisions });
        break;
      }
      if (elapsed() >= budget.maxWallMs) {
        await store.step("budget", { limit: "wall_clock", usedMs: elapsed() });
        break;
      }
      const view = buildView(input.task, problem, evidence, assessments, budget, usage, [...failedTools], feedback);
      usage.decisions++;
      let raw: unknown;
      try {
        raw = usePlaybook ? playbookDecision(view) : await callProvider("decide", () => provider.decide(view));
      } catch (err) {
        // Keep the evidence already collected: stop investigating and report on it.
        interrupted = `The model became unavailable after ${usage.toolCalls} tool call(s) (${(err as Error).message}); the report is built from the evidence collected so far.`;
        await store.step("interrupted", { phase: "investigate", message: (err as Error).message });
        break;
      }
      const d = Decision.safeParse(raw);
      if (!d.success) {
        feedback = `Your last output was not a valid decision (${d.error.issues[0]?.message}). Call exactly one tool, or conclude.`;
        if (await rejectDecision("invalid_output", { phase: "investigate", feedback })) continue;
        break;
      }
      const decision = d.data;
      await store.step("decision", { ...decision, source: usePlaybook ? "playbook-fallback" : provider.name });

      if (decision.action === "need_info") {
        await store.step("need_info", { question: decision.question, phase: "investigate" });
        return finish("needs_info", { outcomeNote: decision.question });
      }
      if (decision.action === "conclude") break;

      // call_tool
      const def = TOOL_BY_NAME.get(decision.tool);
      if (!def) {
        feedback = `Unknown tool "${decision.tool}". Allowed: ${TOOLS.map((t) => t.name).join(", ")}.`;
        if (await rejectDecision("invalid_tool", { tool: decision.tool, feedback })) continue;
        break;
      }
      const args = def.input.safeParse(decision.args);
      if (!args.success) {
        feedback = `Invalid arguments for ${def.name}: ${args.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}`;
        if (await rejectDecision("invalid_args", { tool: def.name, args: decision.args, feedback })) continue;
        break;
      }
      const key = `${def.name}:${stableStringify(args.data)}`;
      if (seen.has(key)) {
        feedback = `${def.name} with these arguments already ran (${seen.get(key)}). Use that evidence or choose a different step.`;
        if (await rejectDecision("duplicate_call", { tool: def.name, feedback })) continue;
        break;
      }
      if (failedKeys.has(key)) {
        feedback = `${def.name} with these arguments already failed after retries. It is unavailable; use other tools or conclude.`;
        if (await rejectDecision("unavailable_tool", { tool: def.name, feedback })) continue;
        break;
      }
      if (usage.toolCalls >= budget.maxToolCalls) {
        await store.step("budget", { limit: "tool_calls", used: usage.toolCalls });
        break;
      }
      invalidStreak = 0;
      feedback = undefined;
      usage.toolCalls++;
      await store.step("tool_call", { tool: def.name, args: args.data, reason: decision.reason });

      const result = await runTool(() => def.run(ctx, args.data), budget.toolTimeoutMs);
      if (result.kind === "usage_error") {
        feedback = result.message;
        await store.step("tool_error", { tool: def.name, message: result.message, retryable: false });
        continue;
      }
      if (result.kind === "failed") {
        usage.toolErrors++;
        failedKeys.add(key);
        failedTools.add(def.name);
        await store.step("tool_error", { tool: def.name, message: result.message, retryable: true, attempts: 2 });
        feedback = `${def.name} failed (${result.message}). Try another step or conclude.`;
        continue;
      }
      const e: Evidence = {
        id: `E${evidence.length + 1}`,
        tool: def.name,
        args: args.data as Record<string, unknown>,
        summary: result.output.summary,
        facts: result.output.facts,
        untrustedText: result.output.untrustedText,
        createdAt: new Date().toISOString(),
      };
      evidence.push(e);
      seen.set(key, e.id);
      await store.saveEvidence(e);
      assessments = assess(evidence);
      await store.saveProgress(assessments, { ...usage, wallMs: elapsed() });
      await store.step("evidence", { id: e.id, tool: e.tool, summary: e.summary, assessments: Object.fromEntries(assessments.map((a) => [a.hypothesis, a.status])) });
    }

    // Shared handling for rejected decisions: count it, and after too many in a
    // row switch to the deterministic playbook rather than looping forever.
    async function rejectDecision(kind: string, payload: Record<string, unknown>): Promise<boolean> {
      usage.invalidOutputs++;
      invalidStreak++;
      await store.step(kind, payload);
      if (invalidStreak > budget.maxRetriesPerStep && !usePlaybook) {
        usePlaybook = true;
        usage.fallbacks.push("decide");
        await store.step("fallback", { phase: "investigate", reason: `${invalidStreak} invalid outputs in a row; continuing with the deterministic playbook` });
      }
      return usage.decisions < budget.maxDecisions;
    }

    if (evidence.length === 0) {
      if (interrupted) return finish("failed", { outcomeNote: interrupted.replace("; the report is built from the evidence collected so far", "") });
      return finish("insufficient_evidence", { outcomeNote: "No evidence could be collected (all tool calls failed or were rejected)." });
    }

    // ── REPORT ────────────────────────────────────────────────────────────
    const v = verdict(assessments);
    let report: Report | undefined;
    feedback = undefined;
    for (let attempt = 0; attempt <= budget.maxRetriesPerStep && !report; attempt++) {
      const view = buildView(input.task, problem, evidence, assessments, budget, usage, [...failedTools], feedback);
      let raw: unknown;
      try {
        raw = await callProvider("report", () => provider.writeReport(view));
      } catch {
        // Evidence is already collected and deterministic; don't throw it away
        // because the model can't write prose. Fall through to the fallback.
        break;
      }
      const checked = validateReport(raw, evidence, assessments, v);
      if (checked.ok) {
        report = checked.report;
        break;
      }
      usage.invalidOutputs++;
      feedback = `Report rejected: ${checked.problems.join(" ")}`;
      await store.step("report_rejected", { attempt, problems: checked.problems });
    }
    if (!report) {
      usage.fallbacks.push("report");
      report = buildDeterministicReport(problem, evidence, assessments);
      await store.step("fallback", { phase: "report", reason: "provider report failed validation; using the deterministic report" });
    }
    await store.step("report", { conclusion: report.conclusion, confidence: report.confidence });

    // ── PROPOSE (never execute) ───────────────────────────────────────────
    const dedupe = new Set<string>();
    for (const action of report.recommendedActions) {
      const key = action.type === "rollback_feature_flag" ? `${action.type}:${action.flagKey}` : `${action.type}:${action.team}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      const policy = await checkActionPolicy(action, { dataset: input.dataset, repo: deps.repo, report, evidence, assessments });
      if (!policy.allowed) {
        blockedActions.push({ type: action.type, reason: policy.reason });
        await store.step("action_blocked", { action, reason: policy.reason });
        continue;
      }
      const { type, rationale, evidenceIds, ...params } = action;
      const id = await store.createProposal({ type, params, rationale, evidenceIds, reversible: policy.reversible });
      proposals.push({ id, type, params });
      await store.step("action_proposed", { id, type, params, reversible: policy.reversible, requires: "human approval" });
    }

    const status: InvestigationStatus = v.kind === "open" ? "insufficient_evidence" : "completed";
    const notes = [interrupted, v.kind === "open" ? "The drop is real but no hypothesis is supported within the budget." : undefined].filter(Boolean);
    return finish(status, { report, outcomeNote: notes.length ? notes.join(" ") : undefined });
  } catch (err) {
    log.error("investigation failed", { err, provider: provider.name });
    try {
      return await finish("failed", { outcomeNote: `Stopped safely: ${(err as Error).message}`.slice(0, 300) });
    } catch {
      return { status: "failed", problem, evidence, assessments, usage, proposals, blockedActions, outcomeNote: "Stopped safely; the trace could not be saved." };
    }
  }
}

function buildView(task: string, problem: Problem, evidence: Evidence[], assessments: Assessment[], budget: Budget, usage: Usage, failedTools: string[], feedback?: string): AgentView {
  return {
    task,
    problem,
    evidence: evidence.map(({ createdAt: _c, ...e }) => e),
    assessments,
    verdict: verdict(assessments),
    remaining: { toolCalls: budget.maxToolCalls - usage.toolCalls, decisions: budget.maxDecisions - usage.decisions },
    failedTools,
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t) })),
    feedback,
  };
}

type ToolRun = { kind: "ok"; output: ToolOutput } | { kind: "usage_error"; message: string } | { kind: "failed"; message: string };

/** One retry for infrastructure failures; usage errors go straight back to the model. */
async function runTool(fn: () => Promise<ToolOutput>, timeoutMs: number): Promise<ToolRun> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { kind: "ok", output: await withTimeout(fn(), timeoutMs, `tool timed out after ${timeoutMs} ms`) };
    } catch (err) {
      if (err instanceof ToolUsageError) return { kind: "usage_error", message: err.message };
      last = (err as Error).message;
      if (attempt === 0) await sleep(200);
    }
  }
  return { kind: "failed", message: last };
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderError("timeout", message)), ms);
    }),
  ]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
