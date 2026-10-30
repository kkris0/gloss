/**
 * The model, over Cloudflare Workers AI's OpenAI-compatible Chat Completions
 * endpoint. Server-side only; the token never reaches the browser.
 *
 * Configured by three runtime values, none of them in the repo:
 *   CLOUDFLARE_ACCOUNT_ID   32 hex characters
 *   CLOUDFLARE_API_TOKEN    a token allowed to run Workers AI
 *   GLOSS_AI_MODEL          a Workers AI model id, e.g. "@cf/..." (nonsecret)
 * With any of them missing the AI features are off, and every AI route says
 * so (aiGate) instead of calling anything. Nothing here reads a key from a
 * request: a browser cannot supply its own.
 */

import { MODELS, type ChatMessage, type ModelKey, type StreamEvent, type Usage } from "../models";

export const APP_UA = "Gloss/0.1";

const ACCOUNT_RE = /^[0-9a-f]{32}$/i;

export type AiConfig = { accountId: string; token: string; model: string };

export function aiConfig(): AiConfig | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  const model = process.env.GLOSS_AI_MODEL?.trim() ?? "";
  if (!ACCOUNT_RE.test(accountId) || !token || /\s/.test(token) || !model || /\s/.test(model)) return null;
  return { accountId, token, model };
}

export const aiEnabled = () => aiConfig() !== null;

export const aiUrl = (accountId: string) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

export const NO_AI = "AI is not set up on this server. Reading, highlights and your shelves work without it.";

/** The response an AI route sends when the model is not configured, or null when it is. */
export function aiGate(): Response | null {
  return aiEnabled() ? null : Response.json({ error: NO_AI, code: "ai_disabled" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
}

/** The response for a feature that needs a service this deployment does not use (images, voice, scanned PDFs, web search). */
export const unsupported = (what: string) =>
  Response.json({ error: `${what} is not available on this server.`, code: "unsupported" }, { status: 501, headers: { "Cache-Control": "private, no-store" } });

type Chunk = {
  choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

function errorMessage(status: number, body: string): string {
  let msg = body.slice(0, 280);
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string; errors?: { message?: string }[] };
    if (typeof j.error === "string") msg = j.error;
    else if (j.error?.message) msg = j.error.message;
    else if (j.errors?.[0]?.message) msg = j.errors[0].message;
    else if (j.message) msg = j.message;
  } catch {
    /* not JSON */
  }
  if (status === 401 || status === 403) return "Cloudflare did not accept the server's AI token.";
  if (status === 429) return "Workers AI is rate limiting this server. Wait a moment.";
  return `Workers AI ${status}: ${msg}`;
}

const usageOf = (u: NonNullable<Chunk["usage"]>): Usage => ({
  promptTokens: u.prompt_tokens ?? 0,
  cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  completionTokens: u.completion_tokens ?? 0,
  costUsd: 0,
});

export async function* streamChat(req: {
  messages: ChatMessage[];
  model: ModelKey;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Tools the model may call; a call ends the stream with a "tool" event instead of an answer. */
  tools?: readonly unknown[];
  /** "none" sends the tools (a conversation that already used one needs them) but asks for an answer. */
  toolChoice?: "auto" | "none";
}): AsyncGenerator<StreamEvent> {
  const cfg = aiConfig();
  if (!cfg) {
    yield { type: "error", text: NO_AI };
    return;
  }
  yield { type: "meta", model: MODELS[req.model].label };

  let res: Response;
  try {
    res = await fetch(aiUrl(cfg.accountId), {
      method: "POST",
      signal: req.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}`, "User-Agent": APP_UA },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        stream_options: { include_usage: true },
        temperature: req.temperature ?? 0.4,
        max_tokens: req.maxTokens ?? 900,
        messages: req.messages,
        ...(req.tools ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" } : {}),
      }),
    });
  } catch (e) {
    if (req.signal?.aborted) return;
    yield { type: "error", text: `Could not reach Workers AI: ${e instanceof Error ? e.message : "network error"}` };
    return;
  }

  if (!res.ok || !res.body) {
    yield { type: "error", text: errorMessage(res.status, await res.text().catch(() => "")) };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawContent = false;
  let sawReasoning = false;
  // A tool call arrives in pieces, by index: its id and name once, its arguments in fragments.
  const calls: { id: string; name: string; args: string }[] = [];

  const finish = (): StreamEvent => {
    if (calls[0]?.name) return { type: "tool", id: calls[0].id || "call_0", name: calls[0].name, args: calls[0].args };
    return !sawContent && sawReasoning ? { type: "error", text: "The model answered only in its reasoning. Try again." } : { type: "done" };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        yield finish();
        return;
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) sawReasoning = true;
      for (const tc of delta?.tool_calls ?? []) {
        const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (delta?.content) {
        sawContent = true;
        yield { type: "content", text: delta.content };
      }
      if (chunk.usage && typeof chunk.usage.completion_tokens === "number") yield { type: "usage", usage: usageOf(chunk.usage) };
    }
  }
  yield finish();
}

/** Non-streaming JSON completion, for structured output like the brief. */
export async function completeJSON<T>(req: {
  messages: ChatMessage[];
  model: ModelKey;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Kept for the callers that ask for a reasoned answer; this endpoint takes no such switch, so it only widens nothing. */
  thinking?: boolean;
}): Promise<{ ok: true; data: T; usage: Usage } | { ok: false; error: string }> {
  const cfg = aiConfig();
  if (!cfg) return { ok: false, error: NO_AI };

  const call = (json: boolean) =>
    fetch(aiUrl(cfg.accountId), {
      method: "POST",
      signal: req.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}`, "User-Agent": APP_UA },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.3,
        max_tokens: req.maxTokens ?? 1400,
        ...(json ? { response_format: { type: "json_object" } } : {}),
        messages: req.messages,
      }),
    });

  let res: Response;
  try {
    res = await call(true);
    // Some models take no JSON mode and say so with a 400; the prompt already asks for JSON, so ask once more without it.
    if (res.status === 400) res = await call(false);
  } catch (e) {
    return { ok: false, error: `Could not reach Workers AI: ${e instanceof Error ? e.message : "network error"}` };
  }
  const body = await res.text();
  if (!res.ok) return { ok: false, error: errorMessage(res.status, body) };

  try {
    const j = JSON.parse(body) as { choices?: { message?: { content?: string } }[]; usage?: Chunk["usage"] };
    const raw = j.choices?.[0]?.message?.content ?? "";
    const data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as T;
    return { ok: true, data, usage: usageOf(j.usage ?? {}) };
  } catch {
    return { ok: false, error: "The model returned something that was not valid JSON. Try again." };
  }
}
