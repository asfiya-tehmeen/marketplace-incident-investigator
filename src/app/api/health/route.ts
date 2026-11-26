import { availableProviders } from "@/server/agent/providers";
import { services } from "@/server/container";
import { newRequestId, run } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return run(newRequestId(), async () => {
    const { db } = await services();
    const [row] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM datasets");
    return { ok: true, database: db.kind, datasets: row?.n ?? 0, providers: availableProviders() };
  });
}
