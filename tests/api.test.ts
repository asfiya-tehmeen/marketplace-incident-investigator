import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as decidePOST } from "@/app/api/actions/[id]/[decision]/route";
import { GET as datasetsGET } from "@/app/api/datasets/route";
import { GET as detailGET } from "@/app/api/investigations/[id]/route";
import { GET as listGET } from "@/app/api/investigations/route";
import { mockProvider } from "@/server/agent/providers/mock";
import type { Db } from "@/server/db/client";
import { investigationService } from "@/server/services/investigationService";
import { freshDb, investigate } from "./helpers";

let db: Db;
beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  db = await freshDb();
  (globalThis as unknown as { __miiDb?: Promise<Db> }).__miiDb = Promise.resolve(db);
});
afterAll(async () => db.close());

const decide = (id: string, decision: string, body: unknown) =>
  decidePOST(new Request("http://t", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id, decision }) });

describe("API", () => {
  it("lists datasets and reports the LLM provider as unavailable without a key", async () => {
    const body = await (await datasetsGET()).json();
    expect(body.datasets).toHaveLength(6);
    expect(body.providers).toEqual([
      expect.objectContaining({ name: "mock", available: true }),
      expect.objectContaining({ name: "anthropic", available: false, reason: expect.stringMatching(/ANTHROPIC_API_KEY/) }),
    ]);
  });

  it("refuses to start with an unavailable provider or unknown dataset", async () => {
    const svc = investigationService(db);
    await expect(svc.start({ dataset: "ios-contact-flag", task: "Leads dropped", provider: "anthropic" })).rejects.toThrow(/not available/);
    await expect(svc.start({ dataset: "atlantis", task: "Leads dropped", provider: "mock" })).rejects.toThrow(/Unknown dataset/);
  });

  it("runs an investigation exactly once even if execute is called twice", async () => {
    const svc = investigationService(db);
    const { id } = await svc.start({ dataset: "quiet-week", task: "JLT leads feel low", provider: "mock" });
    await Promise.all([svc.execute(id), svc.execute(id)]);
    const steps = await db.query("SELECT kind FROM investigation_steps WHERE investigation_id = $1 AND kind = 'started'", [id]);
    expect(steps).toHaveLength(1);
  });

  it("returns incremental trace steps and 404 for unknown ids", async () => {
    const { id } = await investigate(db, "quiet-week", "Are Palm Jumeirah leads down?", mockProvider);
    const all = await (await detailGET(new Request(`http://t/api/investigations/${id}`), { params: Promise.resolve({ id }) })).json();
    const later = await (await detailGET(new Request(`http://t/api/investigations/${id}?afterSeq=3`), { params: Promise.resolve({ id }) })).json();
    expect(later.steps.length).toBe(all.steps.length - 3);
    expect(later.steps[0].seq).toBe(4);
    expect((await detailGET(new Request("http://t/x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
  });

  it("validates approvals: name required, 404 for unknown, 409 for double approval", async () => {
    const { result } = await investigate(db, "tracking-gap", "Leads crashed yesterday afternoon", mockProvider);
    const id = result.proposals[0]!.id;
    expect((await decide(id, "approve", { reviewer: "" })).status).toBe(400);
    expect((await decide(id, "approve", "{oops")).status).toBe(400);
    expect((await decide("missing-A1", "approve", { reviewer: "Sam" })).status).toBe(404);
    expect((await decide(id, "explode", { reviewer: "Sam" })).status).toBe(404);
    expect((await decide(id, "approve", { reviewer: "Sam" })).status).toBe(200);
    const again = await decide(id, "approve", { reviewer: "Sam" });
    expect(again.status).toBe(409);
    expect((await again.json()).error.message).toMatch(/already executed/);
  });

  it("marks investigations stuck by a restart as failed", async () => {
    await db.query("INSERT INTO investigations (id, dataset, task, provider, status, updated_at) VALUES ('stale1', 'quiet-week', 'x', 'mock', 'running', now() - interval '1 hour')");
    await listGET();
    const [row] = await db.query<{ status: string; outcome_note: string }>("SELECT status, outcome_note FROM investigations WHERE id = 'stale1'");
    expect(row).toMatchObject({ status: "failed", outcome_note: expect.stringMatching(/Interrupted/) });
  });
});
