import { z } from "zod";
import type { Verdict } from "@/domain/hypotheses";
import type { Assessment, Problem } from "@/domain/types";

/**
 * What a provider sees each step. Built by the orchestrator; evidence is
 * summarised, and untrusted text is fenced and labelled.
 */
export interface AgentView {
  task: string;
  problem: Problem;
  evidence: Array<{ id: string; tool: string; args: Record<string, unknown>; summary: string; facts: Record<string, unknown>; untrustedText?: string[] }>;
  assessments: Assessment[];
  verdict: Verdict;
  remaining: { toolCalls: number; decisions: number };
  /** Tools that failed after retries; calling them again with the same arguments is refused. */
  failedTools: string[];
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  /** Validation feedback from the previous attempt, if it was rejected. */
  feedback?: string;
}

/**
 * Providers return `unknown`: the orchestrator validates everything, including
 * the deterministic mock, so tests exercise the same checks a model faces.
 */
export interface AgentProvider {
  readonly name: string;
  /** True only for providers that call a real model. Shown in the UI. */
  readonly isLlm: boolean;
  interpretTask(input: { task: string; now: string; feedback?: string }): Promise<unknown>;
  decide(view: AgentView): Promise<unknown>;
  writeReport(view: AgentView): Promise<unknown>;
}

export const Intake = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), problem: z.object({ metric: z.string(), segment: z.record(z.string(), z.unknown()), statement: z.string() }) }),
  z.object({ status: z.literal("need_info"), question: z.string().min(1).max(300) }),
]);

export const Decision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("call_tool"), tool: z.string(), args: z.record(z.string(), z.unknown()), reason: z.string().max(400) }),
  z.object({ action: z.literal("conclude"), reason: z.string().max(400) }),
  z.object({ action: z.literal("need_info"), question: z.string().min(1).max(300) }),
]);
export type Decision = z.infer<typeof Decision>;

export class ProviderError extends Error {
  constructor(public readonly kind: "timeout" | "rate_limited" | "auth" | "refused" | "unavailable" | "bad_request" | "malformed", message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
