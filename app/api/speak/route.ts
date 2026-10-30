import { owner } from "@/lib/server/guard";
import { unsupported } from "@/lib/server/ai";

export const runtime = "nodejs";

/** Reading aloud needed a hosted voice service this deployment does not use. */
export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  return unsupported("Reading aloud");
}
