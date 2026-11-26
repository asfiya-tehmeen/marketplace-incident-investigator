import { availableProviders } from "@/server/agent/providers";
import { services } from "@/server/container";
import { newRequestId, run } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return run(newRequestId(), async () => {
    const { investigations } = await services();
    return { datasets: await investigations.datasets(), providers: availableProviders() };
  });
}
