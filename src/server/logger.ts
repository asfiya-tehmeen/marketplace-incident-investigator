type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = /key|token|secret|password|authorization/i;

/** Structured JSON logs. Secrets are redacted by key name; long strings are truncated. */
function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.test(k)) out[k] = "[redacted]";
    else if (typeof v === "string" && v.length > 300) out[k] = v.slice(0, 300) + "…";
    else if (v instanceof Error) out[k] = { name: v.name, message: v.message };
    else out[k] = v;
  }
  return out;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const min = (process.env.LOG_LEVEL as Level | undefined) ?? "info";
  if (ORDER[level] < (ORDER[min] ?? 20)) return;
  if (process.env.VITEST && level !== "error") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...sanitize(fields) });
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
