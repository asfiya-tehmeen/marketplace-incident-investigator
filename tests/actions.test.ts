import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockProvider } from "@/server/agent/providers/mock";
import type { Db } from "@/server/db/client";
import { actionService, ActionConflictError } from "@/server/services/actionService";
import { freshDb, investigate } from "./helpers";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => db.close());

const flag = async (key: string) => (await db.query<{ enabled: boolean }>("SELECT enabled FROM feature_flags WHERE dataset = 'ios-contact-flag' AND flag_key = $1", [key]))[0]!.enabled;

describe("human approval workflow", () => {
  it("executes a rollback only on approval, once, with an audit trail, and can undo it", async () => {
    const { result } = await investigate(db, "ios-contact-flag", "Leads dropped since Tuesday", mockProvider);
    const id = result.proposals[0]!.id;
    const actions = actionService(db);

    expect(await flag("contact_sheet_v2")).toBe(true);
    const approved = await actions.approve(id, { reviewer: "On-call lead", note: "Matches the evidence" });
    expect(approved).toMatchObject({ status: "executed", result: { flagKey: "contact_sheet_v2", enabled: false } });
    expect(await flag("contact_sheet_v2")).toBe(false);

    // Double-click / second reviewer: no second execution.
    await expect(actions.approve(id, { reviewer: "Someone else" })).rejects.toBeInstanceOf(ActionConflictError);
    const changes = await db.query("SELECT * FROM flag_changes WHERE dataset = 'ios-contact-flag' AND flag_key = 'contact_sheet_v2' AND actor = 'On-call lead'");
    expect(changes).toHaveLength(1);

    await actions.undo(id, { reviewer: "On-call lead" });
    expect(await flag("contact_sheet_v2")).toBe(true);

    const audit = await actions.auditLog();
    expect(audit.filter((a) => a.target === id).map((a) => a.action).sort()).toEqual(["approve_and_execute", "undo"]);
  });

  it("refuses to undo over someone else's later change", async () => {
    const { result } = await investigate(db, "ios-contact-flag", "Enquiries on iPhone are way down this week", mockProvider);
    const id = result.proposals[0]!.id;
    const actions = actionService(db);
    await actions.approve(id, { reviewer: "Reviewer A" });
    // Someone re-enables the flag by hand afterwards.
    await db.query("UPDATE feature_flags SET enabled = true WHERE dataset = 'ios-contact-flag' AND flag_key = 'contact_sheet_v2'");
    await expect(actions.undo(id, { reviewer: "Reviewer A" })).rejects.toThrow(/changed after the rollback/);
  });

  it("rejection changes nothing but is recorded", async () => {
    const { result } = await investigate(db, "marina-delisting", "Dubai Marina leads are down since Thursday", mockProvider);
    const id = result.proposals[0]!.id;
    const actions = actionService(db);
    await actions.reject(id, { reviewer: "Supply lead", note: "Already known" });
    expect(await db.query("SELECT * FROM tickets WHERE action_id = $1", [id])).toHaveLength(0);
    await expect(actions.approve(id, { reviewer: "Supply lead" })).rejects.toThrow(/already rejected/);
  });

  it("opens a ticket on approval and does not allow undo for irreversible actions", async () => {
    const { result } = await investigate(db, "tracking-gap", "Leads crashed yesterday afternoon", mockProvider);
    const id = result.proposals[0]!.id;
    const actions = actionService(db);
    const r = await actions.approve(id, { reviewer: "Data on-call" });
    expect(r.result).toMatchObject({ team: "data-platform" });
    await expect(actions.undo(id, { reviewer: "Data on-call" })).rejects.toThrow(/not reversible/);
  });
});
