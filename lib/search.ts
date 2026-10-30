/**
 * Web search for answers that need the world beyond the text (off here, see searchEnabled).
 * Server-side only.
 */

import type { Source } from "./models";

/** The tool the model is offered. Its description is what decides when it searches. */
export const WEB_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for facts the text does not give: who a named person, organisation or place is, what a named work, event or term refers to, or what has happened since the text was written. Do not search for what the text itself says.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to look up, in a few words, e.g. \"Alan G. Chynoweth Bellcore physicist\"" } },
      required: ["query"],
    },
  },
} as const;

/**
 * Web search is off in this deployment: it called a third-party search API
 * (Exa) with a key, and a private instance reaches no such service. The tool
 * definition and the query helper stay for the prompts and for a later
 * provider; nothing here makes a request.
 */
export const searchEnabled = () => false;

export type WebResults = { sources: Source[]; excerpts: string[]; usd: number };

export async function webSearch(_query: string, _signal?: AbortSignal): Promise<WebResults | null> {
  return null;
}

/** What to search for: the reader's question, with the passage it is about for context. */
export function searchQuery(t: { action: string; quote?: string; question?: string }, latest?: string): string {
  const quote = t.quote?.replace(/\s+/g, " ").trim().slice(0, 300);
  const question = (latest ?? t.question)?.trim();
  if (t.action === "check" && !latest) return quote ?? question ?? "";
  if (question && quote) return `${question} (about: "${quote}")`;
  return question ?? quote ?? "";
}
