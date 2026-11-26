/** Rebuilds all simulated datasets and clears investigations. Safe to re-run. */
import { createPgDb, createPgliteDb, migrate } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";

const url = process.env.DATABASE_URL;
const db = url ? await createPgDb(url) : await createPgliteDb(process.env.PGLITE_DIR ?? ".data/pglite");
await migrate(db);
const started = Date.now();
const n = await seedDatabase(db);
console.log(`Seeded ${n} simulated datasets in ${Date.now() - started} ms (${db.kind}).`);
await db.close();
