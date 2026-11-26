/** Applies pending migrations to DATABASE_URL (or the local PGlite directory). */
import { createPgDb, createPgliteDb, migrate } from "../src/server/db/client";

const url = process.env.DATABASE_URL;
const db = url ? await createPgDb(url) : await createPgliteDb(process.env.PGLITE_DIR ?? ".data/pglite");
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date.", `(${db.kind})`);
await db.close();
