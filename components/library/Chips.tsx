"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Filters on one line, however many topics there are: the row scrolls, fades
 * at an edge with more beyond it, and offers an arrow there to page along.
 */
export function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ l: false, r: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () =>
      setEdges((e) => {
        const l = el.scrollLeft > 2;
        const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
        return e.l === l && e.r === r ? e : { l, r };
      });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    const mo = new MutationObserver(read);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("scroll", read, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", read);
    };
  }, []);
  const page = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * Math.max(200, ref.current.clientWidth * 0.6), behavior: "smooth" });
  return (
    <div className="lib-chip-row" data-l={edges.l || undefined} data-r={edges.r || undefined}>
      <div ref={ref} className="lib-chips no-scrollbar" role="group" aria-label={label}>
        {children}
      </div>
      <button type="button" className="lib-chip-page is-l" aria-label="Scroll filters left" tabIndex={-1} onClick={() => page(-1)}>
        <ChevronLeft size={15} />
      </button>
      <button type="button" className="lib-chip-page is-r" aria-label="Scroll filters right" tabIndex={-1} onClick={() => page(1)}>
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

export function Chip({ on, color, onClick, children }: { on: boolean; color?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className="lib-chip" style={color ? { ["--c" as string]: color } : undefined}>
      {children}
    </button>
  );
}
