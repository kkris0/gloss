import { clearedCookie, revokeSession } from "@/lib/server/auth";
import { owner, tokenOf } from "@/lib/server/guard";

export const runtime = "nodejs";

/** End this session: revoked in the database, not just forgotten by the browser. */
export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  revokeSession(tokenOf(req));
  return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store", "Set-Cookie": clearedCookie() } });
}
