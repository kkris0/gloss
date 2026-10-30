import { owner } from "@/lib/server/guard";
import { articleDoc } from "@/lib/db";

export const runtime = "nodejs";

/** One imported text from the reader's account, for a device that has the shelf entry but not the text. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const doc = articleDoc(g.userId, (await params).id);
  if (!doc) return Response.json({ error: "Not found." }, { status: 404 });
  return Response.json({ doc });
}
