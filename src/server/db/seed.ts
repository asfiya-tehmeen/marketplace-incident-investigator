import type { Db } from "./client";
import { BASELINE_SQL, SCENARIOS } from "./scenarios";

const SAFE_ID = /^[a-z0-9-]{2,40}$/;

/**
 * Rebuilds every simulated dataset. Scenario SQL holds several statements, which
 * the extended (parameterised) protocol can't run in one call, so the dataset id
 * is inlined as a literal. That is safe only because ids come from SCENARIOS and
 * are checked against SAFE_ID first.
 */
export async function seedDatabase(db: Db): Promise<number> {
  await db.transaction(async (tx) => {
    await tx.exec(`
      DELETE FROM audit_log; DELETE FROM tickets; DELETE FROM action_proposals; DELETE FROM evidence;
      DELETE FROM investigation_steps; DELETE FROM investigations;
      DELETE FROM listing_samples; DELETE FROM agency_supply_daily; DELETE FROM pipeline_runs;
      DELETE FROM flag_changes; DELETE FROM feature_flags; DELETE FROM deployments; DELETE FROM metric_hourly; DELETE FROM datasets;`);
    for (const s of SCENARIOS) {
      if (!SAFE_ID.test(s.id)) throw new Error(`unsafe dataset id: ${s.id}`);
      await tx.query("INSERT INTO datasets (id, title, description, default_task) VALUES ($1, $2, $3, $4)", [s.id, s.title, s.description, s.defaultTask]);
      const lit = `'${s.id}'`;
      await tx.exec(BASELINE_SQL.replaceAll("$1", lit));
      if (s.inject.trim()) await tx.exec(s.inject.replaceAll("$1", lit));
    }
  });
  return SCENARIOS.length;
}
