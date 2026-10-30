import { owner } from "@/lib/server/guard";
import { unsupported } from "@/lib/server/ai";

export const runtime = "nodejs";

/** "Read it more carefully" needed a hosted PDF parser this deployment does not use. */
export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  return unsupported("Careful PDF reading");
}
