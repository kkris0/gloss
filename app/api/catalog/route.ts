import { listCatalog } from "@/lib/server/catalog";
import { owner } from "@/lib/server/guard";

export const runtime = "nodejs";

const SORTS = ["added", "title", "author", "rating"] as const;

/** The Goodreads catalogue, searched and filtered. Metadata only: no review text, notes or links leave the server. */
export async function GET(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const p = new URL(req.url).searchParams;
  const sort = p.get("sort");
  const num = (k: string) => (p.has(k) && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : undefined);
  const page = listCatalog(g.userId, {
    q: p.get("q")?.slice(0, 200) ?? undefined,
    status: p.get("status")?.slice(0, 80) || undefined,
    shelf: p.get("shelf")?.slice(0, 80) || undefined,
    sort: SORTS.find((s) => s === sort),
    limit: num("limit"),
    offset: num("offset"),
  });
  return Response.json(page, { headers: { "Cache-Control": "private, no-store" } });
}
