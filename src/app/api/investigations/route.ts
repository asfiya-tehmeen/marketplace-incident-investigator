import { after } from "next/server";
import { config } from "@/server/config";
import { services } from "@/server/container";
import { checkRateLimit, clientKey, handleJson, newRequestId, run } from "@/server/http";
import { StartRequest } from "@/server/services/investigationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return run(newRequestId(), async () => {
    const { investigations } = await services();
    await investigations.sweepStale();
    return { investigations: await investigations.list() };
  });
}

export async function POST(req: Request) {
  return handleJson(
    req,
    StartRequest,
    async (body) => {
      checkRateLimit(`start:${clientKey(req)}`, config().START_RATE_LIMIT);
      const { investigations } = await services();
      const { id } = await investigations.start(body);
      // Respond immediately; the run continues after the response and the UI polls the trace.
      after(() => investigations.execute(id));
      return { id };
    },
    202,
  );
}
