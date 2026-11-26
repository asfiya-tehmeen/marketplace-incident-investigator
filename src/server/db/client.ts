import { config } from "../config";
import { log } from "../logger";
import { MIGRATIONS } from "./migrations";

/**
 * Minimal database port. Two adapters:
 *  - `pg` Pool when DATABASE_URL is set (Docker Compose, Neon, RDS…)
 *  - PGlite (Postgres compiled to WASM) otherwise: zero-setup demo and hermetic tests.
 * Both speak the same SQL dialect, so repositories don't know which one is in use.
 */
export interface Db {
  readonly kind: "postgres" | "pglite";
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Pick<Db, "query" | "exec">) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createPgDb(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  // UTC everywhere: date casts and day-step series depend on the session time zone.
  const pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5_000, statement_timeout: 15_000, options: "-c TimeZone=UTC" });
  pool.on("error", (err) => log.error("pg pool error", { err }));
  const query = async <T,>(text: string, params?: unknown[]) => (await pool.query(text, params)).rows as T[];
  return {
    kind: "postgres",
    query,
    exec: async (sql) => void (await pool.query(sql)),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async <T,>(t: string, p?: unknown[]) => (await client.query(t, p)).rows as T[],
          exec: async (s: string) => void (await client.query(s)),
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) {
    // PGlite creates only the last path segment; a fresh clone has no `.data/` yet.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir, { recursive: true });
  }
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  await pg.exec("SET TIME ZONE 'UTC'");
  return {
    kind: "pglite",
    query: async <T,>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    exec: async (sql) => void (await pg.exec(sql)),
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({
          query: async <T,>(t: string, p?: unknown[]) => (await tx.query<T>(t, p)).rows,
          exec: async (s: string) => void (await tx.exec(s)),
        }),
      ),
    close: () => pg.close(),
  };
}

export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ id: string }>("SELECT id FROM schema_migrations")).map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}

// Survive Next.js dev-server hot reloads: one connection per process.
const g = globalThis as unknown as { __miiDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!g.__miiDb) {
    g.__miiDb = initDb().catch((err) => {
      g.__miiDb = undefined; // allow a retry on the next request
      throw err;
    });
  }
  return g.__miiDb;
}

async function initDb(): Promise<Db> {
  const cfg = config();
  const db = cfg.DATABASE_URL ? await createPgDb(cfg.DATABASE_URL) : await createPgliteDb(cfg.PGLITE_DIR);
  const applied = await migrate(db);
  if (applied.length) log.info("migrations applied", { applied, kind: db.kind });
  if (cfg.AUTO_SEED) {
    const [row] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM datasets");
    if (!row || row.n === 0) {
      const { seedDatabase } = await import("./seed");
      const n = await seedDatabase(db);
      log.info("database seeded", { datasets: n, kind: db.kind });
    }
  }
  return db;
}
