import { runInvestigation } from "@/server/agent/orchestrator";
import type { AgentProvider } from "@/server/agent/providers/types";
import { createPgliteDb, migrate, type Db } from "@/server/db/client";
import { INVESTIGATION_NOW } from "@/server/db/scenarios";
import { seedDatabase } from "@/server/db/seed";
import { investigationRepository } from "@/server/repositories/investigations";
import { telemetryRepository, type TelemetryRepository } from "@/server/repositories/telemetry";
import type { Budget } from "@/domain/types";

export async function freshDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  await seedDatabase(db);
  return db;
}

let counter = 0;
export async function investigate(
  db: Db,
  dataset: string,
  task: string,
  provider: AgentProvider,
  opts: { budget?: Partial<Budget>; repo?: TelemetryRepository; clock?: () => number } = {},
) {
  const invs = investigationRepository(db);
  const id = `t${++counter}-${Date.now()}`;
  await invs.create({ id, dataset, task, provider: provider.name });
  const result = await runInvestigation(
    { dataset, task, provider, now: INVESTIGATION_NOW, budget: opts.budget },
    { repo: opts.repo ?? telemetryRepository(db), store: invs.store(id, dataset), clock: opts.clock },
  );
  return { id, result, steps: await invs.steps(id), invs };
}

/** A provider built from three functions, for scripted misbehaviour. */
export function scripted(p: Partial<AgentProvider> & Pick<AgentProvider, "decide">, fallback: AgentProvider): AgentProvider {
  return { name: "scripted", isLlm: false, interpretTask: fallback.interpretTask, writeReport: fallback.writeReport, ...p };
}
