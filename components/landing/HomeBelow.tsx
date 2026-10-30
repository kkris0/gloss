"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { tidyTitle } from "@/lib/article";
import { SAMPLES } from "@/lib/samples";
import { useStore } from "@/lib/store";
import { todaysReview } from "@/lib/review";
import { DailyHighlight } from "./DailyHighlight";
import { Desk, DeskLink } from "./Desk";

const RECENT = 3;

const STEPS = [
  { title: "Paste a link", body: "An article, a chapter or a PDF." },
  { title: "Select any line", body: "A word, a sentence, a passage." },
  { title: "Ask it anything", body: "The answer lands in the margin, citing the text." },
];

/**
 * What lies on the desk. With highlights, they are yours: today's review while
 * one is due, otherwise the lines you marked last. Before that, how it works.
 */
export function HomeBelow() {
  const hydrated = useStore((s) => s.hydrated);
  const highlights = useStore((s) => s.highlights);
  const library = useStore((s) => s.library);
  const setUI = useStore((s) => s.setUI);

  const titleOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of SAMPLES) m.set(a.id, a.title);
    for (const x of library) m.set(x.id, x.title);
    return m;
  }, [library]);

  const all = useMemo(
    () =>
      Object.values(highlights)
        .flat()
        .filter((h) => titleOf.has(h.articleId))
        .sort((a, b) => b.createdAt - a.createdAt),
    [highlights, titleOf]
  );

  // Held open at its full size until the shelf is read, so nothing shifts when it fills.
  if (!hydrated) return <div className="desk is-holding" aria-hidden />;

  // Before any highlights: Hassan's three steps, for first-timers.
  if (!all.length)
    return (
      <Desk label="How it works">
        <ol className="desk-tiles">
          {STEPS.map((s, i) => (
            <li key={s.title} className="desk-tile is-step" style={{ ["--i" as string]: i }}>
              <span className="desk-step-n">{i + 1}</span>
              <p className="mt-3 text-[14.5px] font-medium text-ink">{s.title}</p>
              <p className="mt-1 text-[13.5px] leading-[1.42] text-ink-3">{s.body}</p>
            </li>
          ))}
        </ol>
      </Desk>
    );

  if (todaysReview(all).deck.length > 0) return <DailyHighlight />;

  return (
    <Desk label="Your latest highlights" aside={<DeskLink onClick={() => setUI({ shelf: "highlights" })}>{`All ${all.length}`}</DeskLink>}>
      <ol className="desk-tiles">
        {all.slice(0, RECENT).map((h, i) => (
          <li key={h.id} style={{ ["--i" as string]: i }}>
            <Link href={`/read/${h.articleId}?hl=${h.id}`} className="desk-tile is-quote">
              <p className="line-clamp-3 font-serif text-[15.5px] leading-[1.5] text-ink [font-variation-settings:'opsz'_20]">
                <span className="m-hl" data-c={h.color && h.color !== "yellow" ? h.color : undefined}>
                  {h.anchor.quote.trim()}
                </span>
              </p>
              <p className="desk-source">
                <span className="truncate">{tidyTitle(titleOf.get(h.articleId)!)}</span>
                <ArrowRight size={13} className="desk-source-go" aria-hidden />
              </p>
            </Link>
          </li>
        ))}
        {/* Fewer than three: the room left keeps the row's shape. */}
        {all.length < RECENT && (
          <li className="desk-tile is-room" style={{ ["--i" as string]: all.length, gridColumn: `span ${RECENT - all.length}` }}>
            Select a line in anything you read, and it waits for you here.
          </li>
        )}
      </ol>
    </Desk>
  );
}
