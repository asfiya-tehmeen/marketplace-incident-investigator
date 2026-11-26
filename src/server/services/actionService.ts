import { z } from "zod";
import type { Db } from "../db/client";
import { log } from "../logger";
import type { ProposalRow } from "../repositories/investigations";

/**
 * Human-in-the-loop execution. Proposals are created by the orchestrator only;
 * this is the only code that changes flags or opens tickets, and only after a
 * named reviewer approves. Each transition is a guarded UPDATE so a double
 * click (or two reviewers) can't execute an action twice.
 */

export const Decision = z.object({
  reviewer: z.string().trim().min(2, "Enter your name so the decision is attributable.").max(60),
  note: z.string().trim().max(500).optional(),
});
export type ReviewDecision = z.infer<typeof Decision>;

export class ActionConflictError extends Error {}
export class ActionNotFoundError extends Error {}

export function actionService(db: Db) {
  const load = async (tx: Pick<Db, "query">, id: string): Promise<ProposalRow> => {
    const [row] = await tx.query<ProposalRow>(
      `SELECT id, investigation_id AS "investigationId", dataset, type, params, rationale, evidence_ids AS "evidenceIds", reversible, status
       FROM action_proposals WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!row) throw new ActionNotFoundError(`Action ${id} not found.`);
    return row;
  };
  const audit = (tx: Pick<Db, "query">, actor: string, action: string, target: string, details: Record<string, unknown>) =>
    tx.query("INSERT INTO audit_log (actor, action, target, details) VALUES ($1, $2, $3, $4::jsonb)", [actor, action, target, JSON.stringify(details)]);

  return {
    async approve(id: string, d: ReviewDecision) {
      return db.transaction(async (tx) => {
        const p = await load(tx, id);
        if (p.status !== "pending") throw new ActionConflictError(`Action is already ${p.status}.`);
        let result: Record<string, unknown>;
        let undoState: Record<string, unknown> | null = null;

        if (p.type === "rollback_feature_flag") {
          const key = String(p.params.flagKey);
          const [flag] = await tx.query<{ enabled: boolean; platform: string | null }>(
            "SELECT enabled, platform FROM feature_flags WHERE dataset = $1 AND flag_key = $2 FOR UPDATE",
            [p.dataset, key],
          );
          if (!flag) throw new ActionConflictError(`Flag ${key} no longer exists.`);
          if (!flag.enabled) throw new ActionConflictError(`Flag ${key} is already disabled; nothing to roll back.`);
          await tx.query("UPDATE feature_flags SET enabled = false, updated_at = now() WHERE dataset = $1 AND flag_key = $2", [p.dataset, key]);
          await tx.query(
            "INSERT INTO flag_changes (dataset, ts, flag_key, platform, old_enabled, new_enabled, actor, note) VALUES ($1, now(), $2, $3, true, false, $4, $5)",
            [p.dataset, key, flag.platform, d.reviewer, `Rollback approved from investigation ${p.investigationId}`],
          );
          result = { flagKey: key, enabled: false };
          undoState = { flagKey: key, enabled: true };
        } else if (p.type === "create_incident_ticket") {
          const body = `${p.rationale}\n\nEvidence: ${p.evidenceIds.join(", ")} (investigation ${p.investigationId})`;
          const [t] = await tx.query<{ id: number }>(
            "INSERT INTO tickets (dataset, team, title, body, created_by, action_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            [p.dataset, p.params.team, p.params.title, body, d.reviewer, p.id],
          );
          result = { ticketId: t!.id, team: p.params.team };
        } else {
          throw new ActionConflictError(`Unsupported action type ${p.type}.`);
        }

        await tx.query(
          `UPDATE action_proposals SET status = 'executed', decided_by = $2, decided_at = now(), decision_note = $3, result = $4::jsonb, undo_state = $5::jsonb WHERE id = $1`,
          [id, d.reviewer, d.note ?? null, JSON.stringify(result), undoState ? JSON.stringify(undoState) : null],
        );
        await audit(tx, d.reviewer, "approve_and_execute", id, { type: p.type, params: p.params, result, note: d.note });
        log.info("action executed", { id, type: p.type });
        return { id, status: "executed" as const, result };
      });
    },

    async reject(id: string, d: ReviewDecision) {
      return db.transaction(async (tx) => {
        const p = await load(tx, id);
        if (p.status !== "pending") throw new ActionConflictError(`Action is already ${p.status}.`);
        await tx.query(`UPDATE action_proposals SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, d.reviewer, d.note ?? null]);
        await audit(tx, d.reviewer, "reject", id, { type: p.type, params: p.params, note: d.note });
        return { id, status: "rejected" as const };
      });
    },

    /** Reverts an executed, reversible action, but only if nothing has changed since. */
    async undo(id: string, d: ReviewDecision) {
      return db.transaction(async (tx) => {
        const p = await load(tx, id);
        if (p.status !== "executed") throw new ActionConflictError(`Only executed actions can be undone (this one is ${p.status}).`);
        if (!p.reversible) throw new ActionConflictError("This action is not reversible.");
        const key = String(p.params.flagKey);
        const [flag] = await tx.query<{ enabled: boolean; platform: string | null }>("SELECT enabled, platform FROM feature_flags WHERE dataset = $1 AND flag_key = $2 FOR UPDATE", [p.dataset, key]);
        if (!flag || flag.enabled) throw new ActionConflictError(`Flag ${key} was changed after the rollback; undo would overwrite someone else's change.`);
        await tx.query("UPDATE feature_flags SET enabled = true, updated_at = now() WHERE dataset = $1 AND flag_key = $2", [p.dataset, key]);
        await tx.query(
          "INSERT INTO flag_changes (dataset, ts, flag_key, platform, old_enabled, new_enabled, actor, note) VALUES ($1, now(), $2, $3, false, true, $4, $5)",
          [p.dataset, key, flag.platform, d.reviewer, `Undo of ${id}`],
        );
        await tx.query("UPDATE action_proposals SET status = 'undone' WHERE id = $1", [id]);
        await audit(tx, d.reviewer, "undo", id, { flagKey: key, note: d.note });
        return { id, status: "undone" as const };
      });
    },

    async auditLog(limit = 50) {
      return db.query<{ id: number; ts: string; actor: string; action: string; target: string; details: Record<string, unknown> }>(
        `SELECT id, ts::text, actor, action, target, details FROM audit_log ORDER BY ts DESC, id DESC LIMIT $1`,
        [limit],
      );
    },

    async flags(dataset?: string) {
      return db.query<{ dataset: string; flagKey: string; enabled: boolean; platform: string | null; description: string; updatedAt: string }>(
        `SELECT dataset, flag_key AS "flagKey", enabled, platform, description, updated_at::text AS "updatedAt"
         FROM feature_flags ${dataset ? "WHERE dataset = $1" : ""} ORDER BY dataset, flag_key`,
        dataset ? [dataset] : [],
      );
    },

    async tickets() {
      return db.query<{ id: number; dataset: string; team: string; title: string; createdAt: string; createdBy: string; actionId: string | null }>(
        `SELECT id, dataset, team, title, created_at::text AS "createdAt", created_by AS "createdBy", action_id AS "actionId" FROM tickets ORDER BY id DESC LIMIT 50`,
      );
    },
  };
}
export type ActionService = ReturnType<typeof actionService>;
