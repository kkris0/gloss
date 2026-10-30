import { owner } from "@/lib/server/guard";

export const runtime = "nodejs";

/** Who is signed in and the CSRF token their writes must carry. 401 when nobody is. */
export async function GET(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  return Response.json({ userId: g.userId, csrf: g.session.csrf, expiresAt: g.session.expiresAt }, { headers: { "Cache-Control": "private, no-store" } });
}
