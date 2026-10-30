import { owner } from "@/lib/server/guard";
import { unsupported } from "@/lib/server/ai";

export const runtime = "nodejs";

/** Reading a scanned PDF page needed a hosted vision model this deployment does not use. Text PDFs are read in the browser. */
export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  return unsupported("Reading scanned PDF pages");
}
