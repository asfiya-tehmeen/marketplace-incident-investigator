import { getDb } from "./db/client";
import { actionService } from "./services/actionService";
import { investigationService } from "./services/investigationService";

/** Composition root for route handlers. */
export async function services() {
  const db = await getDb();
  return { db, investigations: investigationService(db), actions: actionService(db) };
}
