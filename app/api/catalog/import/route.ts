import { CatalogError, LIMITS, importCatalog } from "@/lib/server/catalog";
import { owner } from "@/lib/server/guard";

export const runtime = "nodejs";

/**
 * Import a Goodreads CSV export: the file itself as the request body
 * (text/csv). Idempotent: sending it again changes nothing. Bounded in size,
 * rows and cell length; nothing in the file is evaluated or fetched.
 */
export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const headers = { "Cache-Control": "private, no-store" };
  if (Number(req.headers.get("content-length") ?? 0) > LIMITS.bytes) return Response.json({ error: "That file is too large." }, { status: 413, headers });
  const type = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("text/csv") && !type.startsWith("text/plain")) return Response.json({ error: "Send the CSV as text/csv." }, { status: 415, headers });
  try {
    // Read at most one byte past the limit, so an unbounded body (no Content-Length) cannot fill memory.
    const reader = req.body?.getReader();
    if (!reader) return Response.json({ error: "The file is empty." }, { status: 422, headers });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.bytes) {
        await reader.cancel();
        return Response.json({ error: "That file is too large." }, { status: 413, headers });
      }
      chunks.push(value);
    }
    const summary = importCatalog(g.userId, Buffer.concat(chunks).toString("utf8"));
    return Response.json(summary, { headers });
  } catch (e) {
    if (e instanceof CatalogError) return Response.json({ error: e.message }, { status: e.status, headers });
    console.error("catalog import failed:", e instanceof Error ? e.message : "unknown error");
    return Response.json({ error: "The import failed. Nothing was changed." }, { status: 500, headers });
  }
}
