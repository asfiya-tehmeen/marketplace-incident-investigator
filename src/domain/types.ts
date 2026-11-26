import { z } from "zod";

export const METRICS = ["searches", "listing_views", "leads"] as const;
export const PLATFORMS = ["ios", "android", "web"] as const;
export const COMMUNITIES = ["dubai-marina", "jlt", "business-bay", "jvc", "downtown-dubai", "palm-jumeirah"] as const;

export const Metric = z.enum(METRICS);
export const Platform = z.enum(PLATFORMS);
export const Community = z.enum(COMMUNITIES);
export type Metric = z.infer<typeof Metric>;
export type Platform = z.infer<typeof Platform>;
export type Community = z.infer<typeof Community>;

export const Segment = z
  .object({ community: Community.optional(), platform: Platform.optional() })
  .strict();
export type Segment = z.infer<typeof Segment>;

/** What the agent was asked to explain, after intake. */
export const Problem = z.object({
  metric: Metric,
  segment: Segment,
  /** Plain restatement shown to the user. */
  statement: z.string().min(1).max(300),
});
export type Problem = z.infer<typeof Problem>;

export const HYPOTHESES = {
  data_gap: "Tracking or ingestion gap (the drop is in the data, not in user behaviour)",
  feature_flag: "A feature-flag change broke part of the funnel",
  release: "An app or web release introduced a regression",
  supply_drop: "Fewer active listings (supply), not lower demand or conversion",
  no_anomaly: "No significant anomaly: within normal variation",
} as const;
export type HypothesisId = keyof typeof HYPOTHESES;
export const HypothesisId = z.enum(Object.keys(HYPOTHESES) as [HypothesisId, ...HypothesisId[]]);

export type AssessmentStatus = "supported" | "weak" | "refuted" | "untested";
export interface Assessment {
  hypothesis: HypothesisId;
  status: AssessmentStatus;
  reason: string;
  evidenceIds: string[];
}

/** Produced only by tool code, never by the model. */
export interface Evidence {
  id: string; // "E1", "E2", …
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  facts: Record<string, unknown>;
  /** Free text from listings or other user-generated content; never treated as instructions. */
  untrustedText?: string[];
  createdAt: string;
}

export const ACTION_TYPES = ["rollback_feature_flag", "create_incident_ticket"] as const;
export const TEAMS = ["mobile", "web", "supply", "data-platform", "search"] as const;

export const RecommendedAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rollback_feature_flag"),
    flagKey: z.string().regex(/^[a-z0-9_]{2,60}$/),
    rationale: z.string().min(1).max(500),
    evidenceIds: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal("create_incident_ticket"),
    team: z.enum(TEAMS),
    title: z.string().min(5).max(120),
    rationale: z.string().min(1).max(500),
    evidenceIds: z.array(z.string()).min(1),
  }),
]);
export type RecommendedAction = z.infer<typeof RecommendedAction>;

/** The structured report the provider must return; validated against evidence before it is accepted. */
export const Report = z.object({
  conclusion: z.union([HypothesisId, z.literal("undetermined")]),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z.string().min(1).max(800),
  claims: z
    .array(z.object({ text: z.string().min(1).max(400), evidenceIds: z.array(z.string()).min(1) }))
    .min(1)
    .max(10),
  alternatives: z
    .array(z.object({ hypothesis: HypothesisId, verdict: z.enum(["rejected", "possible"]), reason: z.string().max(400), evidenceIds: z.array(z.string()) }))
    .max(5),
  recommendedActions: z.array(RecommendedAction).max(3),
  openQuestions: z.array(z.string().max(300)).max(5),
});
export type Report = z.infer<typeof Report>;

export type InvestigationStatus =
  | "pending"
  | "running"
  | "completed"
  | "needs_info"
  | "insufficient_evidence"
  | "failed";

export interface Budget {
  maxToolCalls: number;
  maxDecisions: number;
  maxRetriesPerStep: number;
  maxWallMs: number;
  toolTimeoutMs: number;
  providerTimeoutMs: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxToolCalls: 8,
  maxDecisions: 14,
  maxRetriesPerStep: 2,
  maxWallMs: 120_000,
  toolTimeoutMs: 5_000,
  providerTimeoutMs: 45_000,
};
