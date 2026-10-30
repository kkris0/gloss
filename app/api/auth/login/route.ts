import { login, sameSite, sessionCookie } from "@/lib/server/auth";

export const runtime = "nodejs";

const headers = { "Cache-Control": "private, no-store" };

/**
 * The owner's password in, a session cookie out. JSON only (a cross-site form
 * cannot send it), same-site only, and throttled across the instance.
 */
export async function POST(req: Request) {
  if (!sameSite(req)) return Response.json({ error: "Cross-site request refused." }, { status: 403, headers });
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "Send JSON." }, { status: 415, headers });
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const r = await login(body?.password);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status, headers: { ...headers, ...(r.retryAfter ? { "Retry-After": String(r.retryAfter) } : {}) } });
  return Response.json({ ok: true, csrf: r.session.csrf }, { headers: { ...headers, "Set-Cookie": sessionCookie(r.token) } });
}
