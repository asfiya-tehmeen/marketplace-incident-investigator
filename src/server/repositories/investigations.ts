import type { Assessment, Evidence, InvestigationStatus, Problem, Report } from "@/domain/types";
import type { InvestigationStore, Usage } from "../agent/orchestrator";
import type { Db } from "../db/client";

export interface InvestigationRow {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  dataset: string;
  datasetTitle: string;
  task: string;
  provider: string;
  status: InvestigationStatus;
  problem: Problem | null;
  report: Report | null;
  assessments: Assessment[];
  usage: Partial<Usage>;
  outcomeNote: string | null;
}

export interface StepRow { seq: number; createdAt: string; kind: string; payload: Record<string, unknown> }
export interface ProposalRow {
  id: string;
  investigationId: string;
  dataset: string;
  type: string;
  params: Record<string, unknown>;
  rationale: string;
  evidenceIds: string[];
  reversible: boolean;
  status: "pending" | "rejected" | "executed" | "failed" | "undone";
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  result: Record<string, unknown> | null;
}

const INV_COLS = `i.id, i.created_at::text AS "createdAt", i.finished_at::text AS "finishedAt", i.dataset, d.title AS "datasetTitle",
  i.task, i.provider, i.status, i.problem, i.report, i.assessments, i.usage, i.outcome_note AS "outcomeNote"`;
const PROP_COLS = `id, investigation_id AS "investigationId", dataset, type, params, rationale, evidence_ids AS "evidenceIds", reversible, status,
  created_at::text AS "createdAt", decided_by AS "decidedBy", decided_at::text AS "decidedAt", decision_note AS "decisionNote", result`;

export function investigationRepository(db: Db) {
  return {
    async create(i: { id: string; dataset: string; task: string; provider: string }): Promise<void> {
      await db.query("INSERT INTO investigations (id, dataset, task, provider, status) VALUES ($1, $2, $3, $4, 'pending')", [i.id, i.dataset, i.task, i.provider]);
    },

    /** Atomic pending → running. Returns false if someone else already started it. */
    async claim(id: string): Promise<boolean> {
      const rows = await db.query("UPDATE investigations SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id", [id]);
      return rows.length === 1;
    },

    async get(id: string): Promise<InvestigationRow | undefined> {
      const [row] = await db.query<InvestigationRow>(`SELECT ${INV_COLS} FROM investigations i JOIN datasets d ON d.id = i.dataset WHERE i.id = $1`, [id]);
      return row;
    },

    async list(limit = 30): Promise<InvestigationRow[]> {
      return db.query<InvestigationRow>(`SELECT ${INV_COLS} FROM investigations i JOIN datasets d ON d.id = i.dataset ORDER BY i.created_at DESC, i.id LIMIT $1`, [limit]);
    },

    async steps(id: string, afterSeq = 0): Promise<StepRow[]> {
      return db.query<StepRow>(`SELECT seq, created_at::text AS "createdAt", kind, payload FROM investigation_steps WHERE investigation_id = $1 AND seq > $2 ORDER BY seq`, [id, afterSeq]);
    },

    async evidence(id: string): Promise<Evidence[]> {
      return db.query<Evidence>(
        `SELECT id, tool, args, summary, facts, untrusted_text AS "untrustedText", created_at::text AS "createdAt"
         FROM evidence WHERE investigation_id = $1 ORDER BY created_at, length(id), id`,
        [id],
      );
    },

    async proposals(id: string): Promise<ProposalRow[]> {
      return db.query<ProposalRow>(`SELECT ${PROP_COLS} FROM action_proposals WHERE investigation_id = $1 ORDER BY created_at, id`, [id]);
    },

    async proposal(id: string): Promise<ProposalRow | undefined> {
      const [row] = await db.query<ProposalRow>(`SELECT ${PROP_COLS} FROM action_proposals WHERE id = $1`, [id]);
      return row;
    },

    async datasets() {
      return db.query<{ id: string; title: string; description: string; defaultTask: string }>(
        `SELECT id, title, description, default_task AS "defaultTask" FROM datasets ORDER BY id`,
      );
    },

    /** The orchestrator's persistence port for one investigation. */
    store(investigationId: string, dataset: string): InvestigationStore {
      let seq = 0;
      let proposalSeq = 0;
      return {
        async step(kind, payload) {
          seq++;
          await db.query("INSERT INTO investigation_steps (investigation_id, seq, kind, payload) VALUES ($1, $2, $3, $4::jsonb)", [investigationId, seq, kind, JSON.stringify(payload)]);
        },
        async saveEvidence(e) {
          await db.query(
            `INSERT INTO evidence (investigation_id, id, tool, args, summary, facts, untrusted_text) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::text[])`,
            [investigationId, e.id, e.tool, JSON.stringify(e.args), e.summary, JSON.stringify(e.facts), e.untrustedText ?? []],
          );
        },
        async setProblem(p) {
          await db.query("UPDATE investigations SET problem = $2::jsonb, updated_at = now() WHERE id = $1", [investigationId, JSON.stringify(p)]);
        },
        async saveProgress(assessments, usage) {
          await db.query("UPDATE investigations SET assessments = $2::jsonb, usage = $3::jsonb, updated_at = now() WHERE id = $1", [investigationId, JSON.stringify(assessments), JSON.stringify(usage)]);
        },
        async finish(status, f) {
          await db.query(
            `UPDATE investigations SET status = $2, report = $3::jsonb, outcome_note = $4, usage = $5::jsonb, assessments = $6::jsonb, finished_at = now(), updated_at = now() WHERE id = $1`,
            [investigationId, status, f.report ? JSON.stringify(f.report) : null, f.outcomeNote ?? null, JSON.stringify(f.usage), JSON.stringify(f.assessments)],
          );
        },
        async createProposal(p) {
          proposalSeq++;
          const id = `${investigationId}-A${proposalSeq}`;
          await db.query(
            `INSERT INTO action_proposals (id, investigation_id, dataset, type, params, rationale, evidence_ids, reversible, status)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::text[], $8, 'pending')`,
            [id, investigationId, dataset, p.type, JSON.stringify(p.params), p.rationale, p.evidenceIds, p.reversible],
          );
          return id;
        },
      };
    },
  };
}
export type InvestigationRepository = ReturnType<typeof investigationRepository>;
