import { buildMessages, isLengthKey, webBlock, type DocPayload, type ThreadPayload } from "@/lib/prompts";
import { DEFAULT_MODEL, isModelKey, type ChatMessage, type StreamEvent, type Usage } from "@/lib/models";
import { aiGate, streamChat } from "@/lib/server/ai";
import { owner } from "@/lib/server/guard";
import { ACTIONS } from "@/lib/actions";
import { allow } from "@/lib/ratelimit";
import { searchEnabled, searchQuery, WEB_TOOL, webSearch } from "@/lib/search";

export const runtime = "nodejs";
export const maxDuration = 300;

/** About 150k tokens of text. Larger documents are windowed by the client. */
const MAX_DOC_CHARS = 600_000;

type Body = {
  model?: string;
  length?: string;
  doc?: DocPayload;
  thread?: ThreadPayload;
  history?: { role: "user" | "assistant"; content: string }[];
  /** Let the model search the web (on unless the reader turned it off). Fact-check always searches. */
  search?: boolean;
};

export async function POST(req: Request) {
  const g = owner(req);
  if (!g.ok) return g.res;
  const off = aiGate();
  if (off) return off;
  // One owner, so one cap: a runaway script cannot spend the Workers AI quota.
  if (!allow("ask", 120, 60_000)) return Response.json({ error: "That's a lot at once. Wait a moment, then try again." }, { status: 429 });
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const { doc, thread } = body;
  if (!doc?.title || !Array.isArray(doc.paras) || !thread || !(thread.action in ACTIONS)) {
    return Response.json({ error: "doc and thread are required." }, { status: 400 });
  }
  const docChars = doc.paras.reduce((a, p) => a + (p.text?.length ?? 0), 0);
  if (docChars > MAX_DOC_CHARS) return Response.json({ error: "This text is too long to send in one piece." }, { status: 413 });
  if ((thread.quote?.length ?? 0) > 12_000 || (thread.question?.length ?? 0) > 4_000) {
    return Response.json({ error: "That selection or question is too long." }, { status: 413 });
  }
  const history = (body.history ?? []).slice(-12).filter((m) => m && (m.role === "user" || m.role === "assistant"));

  const model = isModelKey(body.model) ? body.model : DEFAULT_MODEL;
  // Web search is off in this deployment (searchEnabled is false), so a fact-check answers from the text alone.
  const canSearch = () => searchEnabled();
  const forced = thread.action === "check" && canSearch();
  const offerTool = !forced && searchEnabled() && body.search !== false;
  const latest = [...history].reverse().find((m) => m.role === "user")?.content;
  const length = isLengthKey(body.length) ? body.length : "normal";
  const maxTokens = body.length === "long" ? 1400 : 900;

  const encoder = new TextEncoder();
  const send = (e: StreamEvent) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      let web: string | undefined;
      // A search and two model calls make one answer, so their usage is added up into one receipt.
      let usage: Usage | null = null;
      const add = (u: Usage) =>
        (usage = usage
          ? { promptTokens: usage.promptTokens + u.promptTokens, cachedTokens: usage.cachedTokens + u.cachedTokens, completionTokens: usage.completionTokens + u.completionTokens, costUsd: usage.costUsd + u.costUsd }
          : u);
      const search = async (query: string) => {
        controller.enqueue(send({ type: "searching" }));
        const found = await webSearch(query, req.signal);
        if (found) {
          controller.enqueue(send({ type: "sources", sources: found.sources }));
        }
        return found;
      };
      /** Streams one model call to the browser, keeping usage and done for the end; returns a tool call if it made one. */
      const relay = async (messages: ChatMessage[], tools: "offer" | "answer" | "none") => {
        let call: Extract<StreamEvent, { type: "tool" }> | null = null;
        for await (const ev of streamChat({ messages, model, maxTokens, signal: req.signal, ...(tools !== "none" ? { tools: [WEB_TOOL], toolChoice: tools === "offer" ? "auto" : "none" } : {}) })) {
          if (ev.type === "tool") call = ev;
          else if (ev.type === "usage") add(ev.usage);
          else if (ev.type !== "done") controller.enqueue(send(ev));
        }
        return call;
      };

      try {
        if (forced) {
          const found = await search(searchQuery(thread, latest));
          if (found) web = webBlock(found.sources, found.excerpts);
        }
        const messages = buildMessages(doc, thread, history, length, web, offerTool);
        const call = await relay(messages, offerTool ? "offer" : "none");
        if (call) {
          // Anything written before the call ("Let me look that up") gives way to the real answer.
          controller.enqueue(send({ type: "reset" }));
          let query = "";
          try {
            query = String((JSON.parse(call.args) as { query?: string }).query ?? "");
          } catch {}
          const found = query && canSearch() ? await search(query) : null;
          await relay(
            [
              ...messages,
              { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.args } }] },
              { role: "tool", tool_call_id: call.id, content: found ? webBlock(found.sources, found.excerpts) : "The search found nothing useful. Answer from the text and what you know, and say what you could not check." },
            ],
            "answer"
          );
        }
        if (usage) controller.enqueue(send({ type: "usage", usage }));
        controller.enqueue(send({ type: "done" }));
      } catch (e) {
        if (!req.signal.aborted) controller.enqueue(send({ type: "error", text: `Stream failed: ${String(e)}` }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
