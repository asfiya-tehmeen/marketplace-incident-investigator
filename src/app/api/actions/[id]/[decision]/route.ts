import { services } from "@/server/container";
import { handleJson, NotFoundError } from "@/server/http";
import { Decision } from "@/server/services/actionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/actions/:id/approve | reject | undo, with { reviewer, note? } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; decision: string }> }) {
  const { id, decision } = await params;
  return handleJson(req, Decision, async (body) => {
    const { actions } = await services();
    if (decision === "approve") return actions.approve(id, body);
    if (decision === "reject") return actions.reject(id, body);
    if (decision === "undo") return actions.undo(id, body);
    throw new NotFoundError(`Unknown decision "${decision}".`);
  });
}
