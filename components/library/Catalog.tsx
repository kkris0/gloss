"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { sortBooks, type Book, type Sort } from "@/lib/library";
import { BookOpen, type Origin } from "./BookOpen";
import { Chip, ChipRow } from "./Chips";
import { Shelf } from "./Shelf";

/** What /api/catalog sends: a book's public face. Reviews, notes and links stay on the server. */
type Entry = {
  key: string;
  status: string;
  title: string;
  author: string;
  series: string;
  myRating: number | null;
  avgRating: number | null;
  pages: number | null;
  shelves: string[];
  dateAdded: string | null;
  dateStarted: string | null;
  dateFinished: string | null;
  timesRead: number | null;
  format: string;
  latestProgress: string;
};
type Page = { total: number; books: Entry[]; statuses: { status: string; count: number }[] };
type Summary = { rows: number; added: number; updated: number; unchanged: number; skipped: number; issues: { row: number; reason: string }[]; missingColumns: string[] };

const LIMIT = 500;
/** About 250 words a page at reading pace: a book's width on the shelf follows its length. */
const minutesOf = (pages: number | null) => Math.max(5, Math.round((pages ?? 250) * 1.1));
const ms = (d: string | null) => (d ? Date.parse(`${d}T00:00:00Z`) || 0 : 0);
const label = (status: string) => (status === "unknown" ? "No status" : status.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()));
const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

/** The percentage the export recorded, if it recorded one. Not a live reading position. */
const exportedPct = (e: Entry) => {
  const m = /^(\d{1,3}(?:\.\d+)?)\s*%$/.exec(e.latestProgress);
  return m ? Math.min(1, Number(m[1]) / 100) : null;
};

/** A catalogue entry as the shelves see a book. It has no text, so no cover art but the topic's plate. */
function asBook(e: Entry): Book {
  const pct = e.status === "read" ? 1 : e.status === "currently-reading" ? (exportedPct(e) ?? 0) : 0;
  return {
    id: e.key,
    title: e.title,
    author: e.author || "Unknown author",
    topic: "unsorted",
    minutes: minutesOf(e.pages),
    dek: e.series || undefined,
    tags: [...e.shelves.slice(0, 6), ...(e.format ? [e.format] : [])],
    favorite: e.myRating === 5,
    pct,
    highlights: 0,
    added: ms(e.dateAdded) || ms(e.dateFinished),
    finished: e.dateFinished ? ms(e.dateFinished) : undefined,
    agent: false,
    sample: false,
  };
}

const progressLine = (e: Entry) => {
  const bits = [label(e.status)];
  if (e.myRating) bits.push(stars(e.myRating));
  if (e.status === "currently-reading" && e.latestProgress) bits.push(`${e.latestProgress} in the export`);
  if (e.dateFinished) bits.push(`finished ${e.dateFinished}`);
  return bits.join(" · ");
};

/**
 * The Goodreads catalogue as a shelf: your export's books by status, with the
 * library's own spines and covers. Metadata only; nothing here can be opened to
 * read, and "currently reading" is what the export said, not where you are.
 */
export function Catalog({ q, sort }: { q: string; sort: Sort }) {
  const [page, setPage] = useState<Page | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [open, setOpen] = useState<{ key: string; origin: Origin } | null>(null);
  const [reload, setReload] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      const p = new URLSearchParams({ limit: String(LIMIT), sort: "added" });
      if (q.trim()) p.set("q", q.trim());
      if (status) p.set("status", status);
      fetch(`/api/catalog?${p}`, { signal: ctrl.signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${r.status}).`);
          return r.json() as Promise<Page>;
        })
        .then((j) => (setPage(j), setError(null)))
        .catch((e) => !ctrl.signal.aborted && setError(e instanceof Error ? e.message : "Could not load the catalogue."));
    }, 180);
    return () => (clearTimeout(t), ctrl.abort());
  }, [q, status, reload]);

  const entries = useMemo(() => new Map((page?.books ?? []).map((e) => [e.key, e])), [page]);
  const books = useMemo(() => sortBooks((page?.books ?? []).map(asBook), sort), [page, sort]);
  const shown = useMemo(() => new Set(books.map((b) => b.id)), [books]);
  const openEntry = open ? entries.get(open.key) : undefined;
  const openBook = useMemo(() => (openEntry ? asBook(openEntry) : null), [openEntry]);
  const everything = page?.statuses.reduce((n, s) => n + s.count, 0) ?? 0;

  const upload = useCallback(async (f: File) => {
    setBusy(true);
    setSummary(null);
    setError(null);
    try {
      const res = await fetch("/api/catalog/import", { method: "POST", headers: { "Content-Type": "text/csv" }, body: f });
      const j = (await res.json().catch(() => ({}))) as Partial<Summary> & { error?: string };
      if (!res.ok) setError(j.error ?? `The import failed (${res.status}).`);
      else {
        setSummary(j as Summary);
        setReload((n) => n + 1);
      }
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
  }, []);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13.5px] text-ink-3">
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className="inline-flex items-center gap-1.5 font-medium text-ink-2 transition-colors hover:text-ink disabled:opacity-50">
          <FileUp size={15} /> {busy ? "Importing…" : everything ? "Import an export again" : "Import a Goodreads CSV"}
        </button>
        {page && everything > 0 && (
          <span>
            {page.total === everything ? `${everything} books` : `${page.total} of ${everything} books`}
            {page.total > LIMIT ? `, showing the first ${LIMIT}. Search or pick a status to narrow it.` : ""}
          </span>
        )}
      </div>

      {error && (
        <p className="mb-4 text-[13.5px] text-rubric-text" role="alert">
          {error}
        </p>
      )}
      {summary && (
        <p className="mb-4 text-[13.5px] leading-snug text-ink-2" role="status">
          {summary.added} added, {summary.updated} updated, {summary.unchanged} unchanged{summary.skipped ? `, ${summary.skipped} skipped` : ""}.
          {summary.issues.length > 0 && <span className="text-ink-3"> {summary.issues.slice(0, 3).map((i) => `Row ${i.row}: ${i.reason}.`).join(" ")}</span>}
          {summary.missingColumns.length > 0 && <span className="text-ink-3"> This file has no {summary.missingColumns.slice(0, 4).join(", ")}{summary.missingColumns.length > 4 ? " or others" : ""} column.</span>}
        </p>
      )}

      {everything > 0 && (
        <ChipRow label="Status">
          <Chip on={!status} onClick={() => setStatus(null)}>
            All <span className="lib-n">{everything}</span>
          </Chip>
          {page?.statuses.map((s) => (
            <Chip key={s.status} on={status === s.status} onClick={() => setStatus(status === s.status ? null : s.status)}>
              {label(s.status)} <span className="lib-n">{s.count}</span>
            </Chip>
          ))}
        </ChipRow>
      )}

      {page && everything === 0 && !error && (
        <p className="py-10 text-center text-[14px] leading-relaxed text-ink-3">
          Nothing here yet. Import the CSV from your Goodreads export to see its books on the shelves.
          <br />
          It brings in titles, authors, shelves, ratings and dates, and no book text.
        </p>
      )}
      {page && everything > 0 && books.length === 0 && <p className="py-6 text-center text-[14px] text-ink-3">Nothing in the catalogue matches{q ? <> &ldquo;{q}&rdquo;</> : ""}.</p>}

      {books.length > 0 && (
        <Shelf books={books} shown={shown} sort={sort} openId={open?.key ?? null} fresh={new Set()} onOpen={(b, el) => setOpen({ key: b.id, origin: { el, kind: "spine" } })} />
      )}

      {open && openEntry && openBook && (
        <BookOpen
          key={open.key}
          book={openBook}
          origin={open.origin}
          owner="A Gloss reader"
          onRead={() => {}}
          onShelve={() => {}}
          onRemove={() => {}}
          readOnly={{
            label: "Goodreads",
            progress: progressLine(openEntry),
            note: "A catalogue entry from your Goodreads export. It carries no text, so there is nothing to read here yet.",
          }}
          onClose={() => {
            const key = open.key;
            setOpen(null);
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-book="${CSS.escape(key)}"]`)?.focus({ preventScroll: true }));
          }}
        />
      )}
    </div>
  );
}
