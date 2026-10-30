import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { aiConfig, aiEnabled, aiGate, aiUrl, completeJSON, streamChat } from "../lib/server/ai";
import type { StreamEvent } from "../lib/models";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-not-real";
const real = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

const on = () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  process.env.GLOSS_AI_MODEL = "@cf/test/model";
};
const mock = (responder: (n: number) => Response) => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder(calls.length);
  }) as typeof fetch;
};
const sse = (...frames: unknown[]) => new Response(frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const collect = async (g: AsyncGenerator<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
};

beforeEach(() => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.GLOSS_AI_MODEL;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = real;
});

describe("disabled mode", () => {
  it("is off with nothing set, and the gate answers 503 ai_disabled", async () => {
    assert.equal(aiEnabled(), false);
    const r = aiGate();
    assert.equal(r?.status, 503);
    assert.equal(((await r?.json()) as { code: string }).code, "ai_disabled");
  });
  it("is off when any one value is missing or malformed", () => {
    on();
    assert.ok(aiEnabled());
    for (const [k, v] of [["CLOUDFLARE_ACCOUNT_ID", ""], ["CLOUDFLARE_ACCOUNT_ID", "../evil"], ["CLOUDFLARE_ACCOUNT_ID", ACCOUNT + "/x"], ["CLOUDFLARE_API_TOKEN", ""], ["CLOUDFLARE_API_TOKEN", "a b"], ["GLOSS_AI_MODEL", ""]] as const) {
      on();
      process.env[k] = v;
      assert.equal(aiConfig(), null, `${k}=${v}`);
    }
  });
  it("streams an error and makes no request when unconfigured", async () => {
    mock(() => sse("[DONE]"));
    const ev = await collect(streamChat({ messages: [{ role: "user", content: "hi" }], model: "flash" }));
    assert.deepEqual(ev.map((e) => e.type), ["error"]);
    const j = await completeJSON({ messages: [{ role: "user", content: "hi" }], model: "flash" });
    assert.equal(j.ok, false);
    assert.equal(calls.length, 0);
  });
  it("ignores a Together key in the environment", async () => {
    process.env.TOGETHER_API_KEY = "tg-should-never-be-used";
    mock(() => sse("[DONE]"));
    await collect(streamChat({ messages: [{ role: "user", content: "hi" }], model: "flash" }));
    delete process.env.TOGETHER_API_KEY;
    assert.equal(calls.length, 0);
  });
});

describe("streaming answers", () => {
  it("posts to the account's OpenAI-compatible endpoint with the server token, and relays content and usage", async () => {
    on();
    mock(() => sse({ choices: [{ delta: { content: "The " } }] }, { choices: [{ delta: { content: "answer [3]." } }] }, { choices: [], usage: { prompt_tokens: 120, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 100 } } }, "[DONE]"));
    const ev = await collect(streamChat({ messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }], model: "flash", maxTokens: 500 }));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`);
    assert.equal(calls[0].url, aiUrl(ACCOUNT));
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, "@cf/test/model");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 500);
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system", "user"]);

    assert.deepEqual(ev.map((e) => e.type), ["meta", "content", "content", "usage", "done"]);
    assert.equal(ev.filter((e) => e.type === "content").map((e) => (e as { text: string }).text).join(""), "The answer [3].");
    const usage = ev.find((e) => e.type === "usage") as Extract<StreamEvent, { type: "usage" }>;
    assert.deepEqual(usage.usage, { promptTokens: 120, cachedTokens: 100, completionTokens: 9, costUsd: 0 });
  });
  it("reassembles frames split across network chunks", async () => {
    on();
    const text = [`data: ${JSON.stringify({ choices: [{ delta: { content: "ab" } }] })}\n\n`, `data: ${JSON.stringify({ choices: [{ delta: { content: "cd" } }] })}\n\ndata: [DONE]\n\n`].join("");
    const cut = 17;
    mock(() => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); c.enqueue(e.encode(text.slice(0, cut))); c.enqueue(e.encode(text.slice(cut))); c.close(); } })));
    const ev = await collect(streamChat({ messages: [{ role: "user", content: "q" }], model: "flash" }));
    assert.equal(ev.filter((e) => e.type === "content").map((e) => (e as { text: string }).text).join(""), "abcd");
  });
  it("ends with a tool event when the model calls a tool", async () => {
    on();
    mock(() => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"que' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] } }] }, "[DONE]"));
    const ev = await collect(streamChat({ messages: [{ role: "user", content: "q" }], model: "flash", tools: [{ type: "function" }] }));
    const last = ev[ev.length - 1];
    assert.deepEqual(last, { type: "tool", id: "c1", name: "web_search", args: '{"query":"x"}' });
  });
  it("reports a rejected token without echoing it, and a rate limit plainly", async () => {
    on();
    mock(() => new Response(JSON.stringify({ errors: [{ message: `bad token ${TOKEN}` }] }), { status: 403 }));
    let ev = await collect(streamChat({ messages: [{ role: "user", content: "q" }], model: "flash" }));
    const err = ev.find((e) => e.type === "error") as { text: string };
    assert.ok(err && !err.text.includes(TOKEN));
    mock(() => new Response("slow down", { status: 429 }));
    ev = await collect(streamChat({ messages: [{ role: "user", content: "q" }], model: "flash" }));
    assert.match((ev.find((e) => e.type === "error") as { text: string }).text, /rate limiting/);
  });
  it("reports an unreachable endpoint without leaking the token", async () => {
    on();
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const ev = await collect(streamChat({ messages: [{ role: "user", content: "q" }], model: "flash" }));
    const err = ev.find((e) => e.type === "error") as { text: string };
    assert.match(err.text, /Could not reach Workers AI/);
    assert.ok(!err.text.includes(TOKEN));
  });
  it("flags an answer that arrived only as reasoning", async () => {
    on();
    mock(() => sse({ choices: [{ delta: { reasoning_content: "hmm" } }] }, "[DONE]"));
    const ev = await collect(streamChat({ messages: [{ role: "user", content: "q" }], model: "flash" }));
    assert.equal(ev[ev.length - 1].type, "error");
  });
});

describe("the brief (JSON completion)", () => {
  const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
  it("parses JSON out of the reply, even when wrapped in prose or fences", async () => {
    on();
    mock(() => ok('Here you go:\n```json\n{"gist":"g","claims":[{"text":"c","cite":2}]}\n```'));
    const r = await completeJSON<{ gist: string }>({ messages: [{ role: "user", content: "brief" }], model: "flash", maxTokens: 800 });
    assert.ok(r.ok && r.data.gist === "g");
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.stream, undefined);
    assert.equal(body.model, "@cf/test/model");
  });
  it("retries once without JSON mode when the model rejects it", async () => {
    on();
    mock((n) => (n === 1 ? new Response(JSON.stringify({ error: { message: "response_format unsupported" } }), { status: 400 }) : ok('{"a":1}')));
    const r = await completeJSON<{ a: number }>({ messages: [{ role: "user", content: "q" }], model: "flash" });
    assert.ok(r.ok && r.data.a === 1);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(String(calls[1].init.body)).response_format, undefined);
  });
  it("says so when the reply is not JSON", async () => {
    on();
    mock(() => ok("I cannot do that."));
    const r = await completeJSON({ messages: [{ role: "user", content: "q" }], model: "flash" });
    assert.ok(!r.ok && /valid JSON/.test(r.error));
  });
});
