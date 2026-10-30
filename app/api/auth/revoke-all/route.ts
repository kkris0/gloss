import { clearedCookie, revokeAllSessions } from "@/lib/server/auth";
import { owner } from "@/lib/server/guard";

export const runtime = "nodejs";

/** Sign out everywhere: every session on every device, this one included. */
export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const revoked = revokeAllSessions();
  return Response.json({ ok: true, revoked }, { headers: { "Cache-Control": "private, no-store", "Set-Cookie": clearedCookie() } });
}
