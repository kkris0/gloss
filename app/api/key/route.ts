import { aiEnabled } from "@/lib/server/ai";
import { owner } from "@/lib/server/guard";

export const runtime = "nodejs";

/** Whether the server's model is set up. The browser holds no key; there is nothing to validate or store here. */
export async function GET(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  return Response.json({ ai: aiEnabled() }, { headers: { "Cache-Control": "private, no-store" } });
}
