import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().optional().transform((v) => (v ? v : undefined)),
  PGLITE_DIR: z.string().default(".data/pglite"),
  DEFAULT_PROVIDER: z.enum(["mock", "anthropic"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  AUTO_SEED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Per-client investigations started per minute (each may call a paid model several times).
  START_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
});

export type Config = z.infer<typeof EnvSchema>;
let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  cached = parsed.data;
  return cached;
}
