/** Prints the anomaly detector's verdict for every dataset × segment. Used to check the detector, not by the app. */
import { detectDrop } from "../src/domain/analysis";
import { COMMUNITIES, PLATFORMS } from "../src/domain/types";
import { createPgliteDb, migrate } from "../src/server/db/client";
import { SCENARIOS } from "../src/server/db/scenarios";
import { seedDatabase } from "../src/server/db/seed";
import { telemetryRepository } from "../src/server/repositories/telemetry";

const db = await createPgliteDb();
await migrate(db);
let t = Date.now();
await seedDatabase(db);
console.log(`seed: ${Date.now() - t} ms`);
const repo = telemetryRepository(db);
const segments = [{}, ...COMMUNITIES.map((community) => ({ community })), ...PLATFORMS.map((platform) => ({ platform }))];
let maxQuietZ = 0;
for (const s of SCENARIOS) {
  for (const metric of ["leads", "listing_views"] as const) {
    for (const seg of segments) {
      const e = detectDrop(await repo.hourlySeries(s.id, metric, seg));
      const label = `${s.id} ${metric} ${JSON.stringify(seg)}`;
      if (e.significant) console.log(`SIG  ${label}  onset=${e.onset} end=${e.end} effect=${e.effectPct}% z=${e.z} sd=${e.noiseSd}`);
      if (s.id === "quiet-week") maxQuietZ = Math.max(maxQuietZ, Math.abs(e.z));
    }
  }
}
console.log(`largest |z| on quiet-week (no incident), any segment: ${maxQuietZ}`);
await db.close();
