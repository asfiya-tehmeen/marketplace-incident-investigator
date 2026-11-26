import { z } from "zod";
import { runInvestigation } from "../agent/orchestrator";
import { availableProviders, createProvider } from "../agent/providers";
import type { Db } from "../db/client";
import { INVESTIGATION_NOW } from "../db/scenarios";
import { log } from "../logger";
import { investigationRepository } from "../repositories/investigations";
import { telemetryRepository } from "../repositories/telemetry";

export const StartRequest = z.object({
  dataset: z.string().regex(/^[a-z0-9-]{2,40}$/, "Unknown dataset."),
  task: z.string().trim().min(5, "Describe what you noticed (at least a few words).").max(500, "Keep the task under 500 characters."),
  provider: z.enum(["mock", "anthropic"]).default("mock"),
});
export type StartRequest = z.infer<typeof StartRequest>;

export class BadStartError extends Error {}

/** Investigations stuck in pending/running this long were interrupted (e.g. a restart). */
const STALE_AFTER = "10 minutes";

export function investigationService(db: Db) {
  const invs = investigationRepository(db);
  return {
    async start(req: StartRequest): Promise<{ id: string }> {
      const datasets = await invs.datasets();
      if (!datasets.some((d) => d.id === req.dataset)) throw new BadStartError(`Unknown dataset "${req.dataset}".`);
      const p = availableProviders().find((x) => x.name === req.provider);
      if (!p?.available) throw new BadStartError(`${p?.label ?? req.provider} is not available: ${p?.reason ?? "not configured"}.`);
      const id = `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await invs.create({ id, dataset: req.dataset, task: req.task, provider: req.provider });
      return { id };
    },

    /** Runs a pending investigation. Safe to call twice: only one caller wins the claim. */
    async execute(id: string): Promise<void> {
      if (!(await invs.claim(id))) return;
      const row = await invs.get(id);
      if (!row) return;
      try {
        const provider = createProvider(row.provider as "mock" | "anthropic");
        await runInvestigation(
          { dataset: row.dataset, task: row.task, provider, now: INVESTIGATION_NOW },
          { repo: telemetryRepository(db), store: invs.store(id, row.dataset) },
        );
      } catch (err) {
        // runInvestigation never throws; this guards provider construction (e.g. missing key).
        log.error("could not run investigation", { id, err });
        await db.query("UPDATE investigations SET status = 'failed', outcome_note = $2, finished_at = now() WHERE id = $1", [id, `Could not start: ${(err as Error).message}`.slice(0, 300)]);
      }
    },

    async sweepStale(): Promise<number> {
      const rows = await db.query(
        `UPDATE investigations SET status = 'failed', finished_at = now(), outcome_note = 'Interrupted before it finished (for example, the server restarted).'
         WHERE status IN ('pending', 'running') AND updated_at < now() - interval '${STALE_AFTER}' RETURNING id`,
      );
      return rows.length;
    },

    async detail(id: string, afterSeq = 0) {
      const inv = await invs.get(id);
      if (!inv) return undefined;
      const [steps, evidence, proposals] = await Promise.all([invs.steps(id, afterSeq), invs.evidence(id), invs.proposals(id)]);
      return { investigation: inv, steps, evidence, proposals };
    },

    list: () => invs.list(),
    datasets: () => invs.datasets(),
  };
}
