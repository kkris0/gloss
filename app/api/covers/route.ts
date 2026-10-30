import { owner } from "@/lib/server/guard";
import { unsupported } from "@/lib/server/ai";

export const runtime = "nodejs";

/**
 * Painting a cover needed a hosted image model this deployment does not use.
 * Stored covers are still served from /api/covers/[id]; texts keep the
 * drawn covers the shelves have always had.
 */
export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  return unsupported("Painting covers");
}
