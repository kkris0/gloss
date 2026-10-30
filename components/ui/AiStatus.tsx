"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Popover, barBtn } from "./Popover";

/**
 * Whether the server's model is set up. There is no key to enter here: the
 * token lives on the server. When it is off, questions and briefs say so,
 * and reading, highlights and shelves go on working.
 */
export function AiStatus() {
  const [ai, setAi] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/key")
      .then((r) => r.json())
      .then((j: { ai?: boolean }) => setAi(Boolean(j.ai)))
      .catch(() => setAi(null));
  }, []);

  if (ai === null) return null;
  return (
    <Popover
      label="AI status"
      tip={ai ? "AI is on" : "AI is off on this server"}
      width={300}
      triggerClass={barBtn}
      trigger={
        <>
          {ai ? <span aria-hidden className="size-1.5 rounded-full bg-good" /> : <Sparkles size={15} aria-hidden />}
          {!ai && <span className="hidden sm:inline">AI off</span>}
        </>
      }
    >
      {() => (
        <div>
          <p className="text-[13.5px] font-medium text-ink">{ai ? "Answers are on" : "Answers are off"}</p>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-3">
            {ai
              ? "Questions and gloss summaries are answered by the model this server is set up with. Nothing is sent from your browser to any other service."
              : "No model is set up on this server, so questions and gloss summaries cannot be answered. Reading, highlights, shelves and the catalogue work as usual."}
          </p>
          <p className="mt-2 text-[11.5px] leading-snug text-ink-4">Reading aloud, painted covers, scanned PDF pages and web search are not part of this deployment.</p>
        </div>
      )}
    </Popover>
  );
}
