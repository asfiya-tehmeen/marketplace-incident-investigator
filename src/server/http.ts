import { NextResponse } from "next/server";
import type { z } from "zod";
import { log } from "./logger";
import { ActionConflictError, ActionNotFoundError } from "./services/actionService";
import { BadStartError } from "./services/investigationService";

export function errorResponse(status: number, code: string, message: string, requestId: string, details?: string[]) {
  return NextResponse.json({ error: { code, message, details, requestId } }, { status });
}

export async function handleJson<S extends z.ZodType, R>(req: Request, schema: S, fn: (body: z.infer<S>) => Promise<R>, status = 200): Promise<NextResponse> {
  const requestId = crypto.randomUUID().slice(0, 8);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.", requestId);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    return errorResponse(400, "invalid_request", "The request did not pass validation.", requestId, details);
  }
  return run(requestId, () => fn(parsed.data), status);
}

export async function run<R>(requestId: string, fn: () => Promise<R>, status = 200): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn(), { status, headers: { "x-request-id": requestId } });
  } catch (err) {
    if (err instanceof ActionNotFoundError || err instanceof NotFoundError) return errorResponse(404, "not_found", err.message, requestId);
    if (err instanceof ActionConflictError) return errorResponse(409, "conflict", err.message, requestId);
    if (err instanceof BadStartError) return errorResponse(422, "cannot_start", err.message, requestId);
    if (err instanceof RateLimitedError) return errorResponse(429, "rate_limited", err.message, requestId);
    log.error("unhandled api error", { requestId, err });
    return errorResponse(500, "internal_error", "Something went wrong on our side. Please try again.", requestId);
  }
}

export class NotFoundError extends Error {}
export class RateLimitedError extends Error {}

const windows = new Map<string, { start: number; count: number }>();
/** Fixed-window, per-instance limiter (protects the model budget in a single-instance demo). */
export function checkRateLimit(key: string, limit: number, windowMs = 60_000, now = Date.now()): void {
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000) windows.clear();
    return;
  }
  if (++w.count > limit) throw new RateLimitedError("Too many investigations started. Please wait a minute.");
}

export const clientKey = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
export const newRequestId = () => crypto.randomUUID().slice(0, 8);
