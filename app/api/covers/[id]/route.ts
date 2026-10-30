import { owner } from "@/lib/server/guard";
import { loadCover } from "@/lib/db";

export const runtime = "nodejs";

/** A cover painted on another device, from the reader's account. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const jpeg = loadCover(g.userId, (await params).id);
  if (!jpeg) return Response.json({ error: "Not found." }, { status: 404 });
  return new Response(new Blob([jpeg as Uint8Array<ArrayBuffer>]), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" } });
}
