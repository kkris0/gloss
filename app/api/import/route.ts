import { fetchArticle } from "@/lib/fetch-article";
import { owner } from "@/lib/server/guard";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  // `pdf`: the caller can read a PDF in the browser, so a PDF link comes back as the file.
  let body: { url?: string; pdf?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const r = await fetchArticle(body.url ?? "", { pdf: Boolean(body.pdf) });
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  if ("pdf" in r) return new Response(r.pdf, { headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(r.name) } });
  return Response.json({ article: r.article });
}
