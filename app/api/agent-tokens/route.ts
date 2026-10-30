import { owner } from "@/lib/server/guard";
import { makeToken } from "@/lib/agent";
import { createToken, listTokens, revokeToken } from "@/lib/db";

export const runtime = "nodejs";

const MAX_TOKENS = 10;

/** The reader's agent connections: list them, make one (its token shown once), or revoke one. */
export async function GET(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  return Response.json({ tokens: listTokens(g.userId) });
}

export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const { userId } = g;
  const body = (await req.json().catch(() => ({}))) as { label?: string };
  if (listTokens(userId).length >= MAX_TOKENS) return Response.json({ error: `You have ${MAX_TOKENS} connections. Revoke one first.` }, { status: 409 });
  const t = makeToken();
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 40) : "Agent";
  createToken(userId, t.id, t.hash, label);
  return Response.json({ id: t.id, label, token: t.token });
}

export async function DELETE(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const { userId } = g;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  return revokeToken(userId, id) ? Response.json({ ok: true }) : Response.json({ error: "Not found." }, { status: 404 });
}
