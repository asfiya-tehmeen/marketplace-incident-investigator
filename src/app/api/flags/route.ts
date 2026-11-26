import { services } from "@/server/container";
import { newRequestId, run } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return run(newRequestId(), async () => {
    const { actions } = await services();
    const [flags, audit, tickets] = await Promise.all([actions.flags(), actions.auditLog(), actions.tickets()]);
    return { flags, audit, tickets };
  });
}
