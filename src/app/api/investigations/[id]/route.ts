import { services } from "@/server/container";
import { NotFoundError, newRequestId, run } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const afterSeq = Math.max(0, Number(new URL(req.url).searchParams.get("afterSeq") ?? 0) || 0);
  return run(newRequestId(), async () => {
    const { investigations } = await services();
    const detail = await investigations.detail(id, afterSeq);
    if (!detail) throw new NotFoundError(`Investigation ${id} not found.`);
    return detail;
  });
}
