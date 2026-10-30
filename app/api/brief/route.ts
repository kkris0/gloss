import { BRIEF_TASK, systemFor, type DocPayload } from "@/lib/prompts";
import { DEFAULT_MODEL, isModelKey } from "@/lib/models";
import { aiGate, completeJSON } from "@/lib/server/ai";
import { owner } from "@/lib/server/guard";
import { undash, type BriefData } from "@/lib/article";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const off = aiGate();
  if (off) return off;
  let body: { model?: string; doc?: DocPayload };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const doc = body.doc;
  if (!doc?.title || !Array.isArray(doc.paras) || doc.paras.length === 0) {
    return Response.json({ error: "doc is required." }, { status: 400 });
  }

  const model = isModelKey(body.model) ? body.model : DEFAULT_MODEL;
  const result = await completeJSON<BriefData>({
    model,
    signal: req.signal,
    // Thinking first: checking a text's headline figures against its own tables is arithmetic, and without it the
    // model repeats the abstract. About 10 s instead of 3 on a 14k-token paper, and half a cent more. The thinking
    // spends from max_tokens (up to 7k on that paper), so the budget is generous.
    thinking: true,
    maxTokens: 16000,
    messages: [
      { role: "system", content: systemFor(doc) },
      { role: "user", content: BRIEF_TASK },
    ],
  });
  if (!result.ok) return Response.json({ error: result.error }, { status: 502 });

  // Keep only well-formed, in-range items so the UI never links to nothing.
  const valid = new Set(doc.paras.map((p) => p.n));
  const d = result.data;
  // The shared system prompt asks glosses to ==mark== their answer; a brief has no use for it.
  const clean = (t: string) => undash(t).replace(/==/g, "");
  const cited = (list: unknown, max: number) =>
    (Array.isArray(list) ? (list as { text?: unknown; cite?: unknown }[]) : [])
      .filter((c): c is { text: string; cite?: unknown } => Boolean(c) && typeof c.text === "string" && c.text.trim().length > 0)
      .map((c) => ({ text: clean(c.text), cite: valid.has(Number(c.cite)) ? Number(c.cite) : 0 }))
      .slice(0, max);
  const brief: BriefData = {
    gist: clean(String(d.gist ?? "")),
    claims: cited(d.claims, 6),
    caveats: cited(d.caveats, 4),
    sections: (Array.isArray(d.sections) ? d.sections : [])
      .filter((s) => s && typeof s.title === "string" && valid.has(Number(s.start)))
      .map((s) => ({ title: clean(s.title), start: Number(s.start) }))
      .sort((a, b) => a.start - b.start)
      .slice(0, 10),
  };
  return Response.json({ brief, usage: result.usage, model }, { headers: { "Cache-Control": "private, no-store" } });
}
