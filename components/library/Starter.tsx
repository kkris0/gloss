"use client";

import { useState } from "react";
import { ArrowRight, Link2, Loader2 } from "lucide-react";
import { normalizeUrl } from "@/lib/links";
import { CLASSICS, classicCover } from "@/lib/classics";
import { importFromUrl, keep } from "@/lib/import";
import { useStore } from "@/lib/store";
import type { AddTab } from "./AddPanel";
import { MarkStack } from "./AgentMarks";

/**
 * Under a shelf that is still nearly empty: three ways to fill it. A dozen
 * classics in one click, links of your own, or an agent that shelves for you.
 */
export function Starter({ count, onAdd }: { count: number; onAdd: (tab: AddTab) => void }) {
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState(0);

  const shelveClassics = async () => {
    const have = new Set(useStore.getState().library.map((x) => (x.sourceUrl ? normalizeUrl(x.sourceUrl) : "")));
    const todo = CLASSICS.filter((c) => !have.has(normalizeUrl(c.url)));
    if (!todo.length) return;
    setBusy({ done: 0, total: todo.length });
    setFailed(0);
    const next = async () => {
      for (let c = todo.shift(); c; c = todo.shift()) {
        const r = await importFromUrl(c.url);
        const err = r.ok ? await keep({ ...r.article, title: c.title, author: c.author, published: String(c.year) }, undefined, { topic: c.topic, cover: classicCover(c) }) : r.error;
        if (err) setFailed((n) => n + 1);
        setBusy((b) => b && { ...b, done: b.done + 1 });
      }
    };
    await Promise.all([next(), next(), next()]);
    setBusy(null);
  };

  return (
    <section className="starter" aria-label="Fill your library">
      <div className="starter-card is-classics">
        <div className="starter-fan" aria-hidden>
          {CLASSICS.slice(0, 5).map((c, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={c.key} src={classicCover(c)} alt="" style={{ ["--i" as string]: i }} />
          ))}
        </div>
        <div className="min-w-0">
          <p className="starter-title">{count ? "Add a few classics" : "Start with a few classics"}</p>
          <p className="starter-body">A dozen essays people keep coming back to: Hamming, Feynman, Orwell, Graham, Wallace and more.</p>
          <button type="button" onClick={shelveClassics} disabled={Boolean(busy)} className="starter-btn">
            {busy ? (
              <>
                <Loader2 size={15} className="animate-spin" /> Shelving {busy.done} of {busy.total}
              </>
            ) : (
              <>
                Shelve them <ArrowRight size={15} />
              </>
            )}
          </button>
          {failed > 0 && !busy && <p className="mt-2 text-[12.5px] text-ink-3">{failed} couldn&apos;t be read in just now. Try again later.</p>}
        </div>
      </div>
      <button type="button" className="starter-card" onClick={() => onAdd("links")}>
        <span className="starter-icon">
          <Link2 size={20} />
        </span>
        <span className="starter-title">Save your own links</span>
        <span className="starter-body">Paste one or many. Gloss reads each one in and sorts it onto a topic.</span>
      </button>
      <button type="button" className="starter-card" onClick={() => onAdd("agent")}>
        <span className="starter-icon is-agent">
          <MarkStack size={24} />
        </span>
        <span className="starter-title">Let your agent shelve for you</span>
        <span className="starter-body">
          Give Grok Bot, Claude or ChatGPT your library, and ask it to save the good articles from your bookmarks.
        </span>
      </button>
    </section>
  );
}
