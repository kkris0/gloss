import { owner } from "@/lib/server/guard";
import { isCollection, pullRows, pushRows, type Collection, type PushRow } from "@/lib/db";

export const runtime = "nodejs";

/** The client batches below this. */
const MAX_BODY = 4_400_000;
const MAX_ROWS = 2000;
const MAX_DATA = 256_000;

type InRow = { id: string; articleId: string; data: unknown; deleted?: boolean; doc?: unknown; baseVersion?: unknown };

/**
 * Pull: every row of the signed-in reader's that changed since `since`,
 * tombstones included. Article texts are left out; they are fetched one at a
 * time from /api/articles/[id], so a big shelf never makes a huge response.
 */
export async function GET(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const { userId } = g;
  const raw = new URL(req.url).searchParams.get("since");
  const since = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : "1970-01-01T00:00:00Z";
  return Response.json(pullRows(userId, since), { headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Push: write the rows a device changed, each against the version the device last saw. A row the
 * server has since changed is left alone and comes back under `conflicts` with the server's copy
 * (status 409, though every other row in the push is still written and listed under `applied`).
 */
export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const { userId } = g;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "Too large." }, { status: 413 });

  let body: { changes?: Record<string, InRow[]> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const changes: Partial<Record<Collection, PushRow[]>> = {};
  let count = 0;
  for (const [table, rows] of Object.entries(body.changes ?? {})) {
    if (!isCollection(table) || !Array.isArray(rows)) continue;
    changes[table] = rows.filter(valid).map((r) => ({
      id: r.id,
      article_id: r.articleId,
      data: r.deleted ? {} : r.data,
      deleted: Boolean(r.deleted),
      // Anything but a whole number counts as "never saw it", which only a row the server lacks accepts.
      baseVersion: Number.isInteger(r.baseVersion) ? (r.baseVersion as number) : undefined,
      ...(table === "articles" ? { doc: r.deleted ? null : r.doc ?? null } : {}),
    }));
    count += changes[table].length;
  }
  if (count > MAX_ROWS) return Response.json({ error: "Too many rows in one push." }, { status: 413 });
  const { applied, conflicts } = pushRows(userId, changes);
  if (conflicts.length) return Response.json({ ok: false, count, applied, conflicts }, { status: 409 });
  return Response.json({ ok: true, count, applied, conflicts });
}

function valid(r: InRow): boolean {
  if (!r || typeof r.id !== "string" || typeof r.articleId !== "string") return false;
  if (!r.id || r.id.length > 120 || !r.articleId || r.articleId.length > 120) return false;
  if (r.deleted) return true;
  return typeof r.data === "object" && r.data !== null && JSON.stringify(r.data).length <= MAX_DATA;
}
