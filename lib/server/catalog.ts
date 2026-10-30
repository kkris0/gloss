/**
 * The Goodreads catalogue: a CSV export read into book metadata, nothing more.
 * It is not book text and not a live reading position; "Latest Progress" is
 * what the export said on the day it was made.
 *
 * Import is bounded (bytes, rows, columns, cell length), idempotent (a book's
 * key is its Goodreads Book ID, so importing the same file again changes
 * nothing), and inert: cells are only ever stored and returned as plain text.
 * Nothing is evaluated, no spreadsheet "=" is honoured, no HTML is built, and
 * no URL from the file is fetched. The row as exported is kept whole in `raw`
 * and never leaves the server; reviews, notes and comments are in it.
 *
 * Server-side only.
 */

import { createHash } from "node:crypto";
import { nowIso, stmt, tx, sqlite } from "./sqlite";

/** The 31 columns of the export this importer was written against. */
export const GOODREADS_HEADERS = [
  "Status", "Title", "Series", "Author", "My Rating", "Avg Rating", "Ratings Count", "Pages", "Tags / Shelves", "Date Added", "Date Started", "Date Finished", "Times Read",
  "Latest Progress", "Reading Progress Timeline", "Format", "Owned", "ISBN", "ISBN13", "ASIN", "Published", "Edition Published", "My Review", "Notes", "Comments", "Votes",
  "Cover URL", "Book URL", "Author URL", "Book ID", "Review ID",
] as const;

export const LIMITS = { bytes: 8 * 1024 * 1024, rows: 20_000, columns: 64, cell: 20_000 } as const;

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 422 = 400
  ) {
    super(message);
  }
}

/* ---------- CSV ---------- */

/** RFC 4180: quoted fields, "" for a quote, newlines inside quotes, CRLF or LF. A BOM is dropped. */
export function parseCsv(text: string, limits: { rows?: number; columns?: number; cell?: number } = {}): string[][] {
  const maxRows = limits.rows ?? LIMITS.rows;
  const maxCols = limits.columns ?? LIMITS.columns;
  const maxCell = limits.cell ?? LIMITS.cell;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  const endCell = () => {
    if (cell.length > maxCell) throw new CatalogError("A cell in the file is too long.", 413);
    if (row.length >= maxCols) throw new CatalogError("The file has too many columns.", 413);
    row.push(cell);
    cell = "";
    started = false;
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === "")) {
      if (rows.length > maxRows) throw new CatalogError(`The file has more than ${maxRows} rows.`, 413);
      rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        cell += c;
        if (cell.length > maxCell + 1) throw new CatalogError("A cell in the file is too long.", 413);
      }
    } else if (c === '"' && !started) {
      quoted = true;
      started = true;
    } else if (c === ",") endCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += c;
      started = true;
      if (cell.length > maxCell + 1) throw new CatalogError("A cell in the file is too long.", 413);
    }
  }
  if (quoted) throw new CatalogError("The file ends inside a quoted cell. It looks cut off.", 422);
  if (cell !== "" || row.length) endRow();
  return rows;
}

/* ---------- mapping ---------- */

export type Book = {
  key: string;
  status: string;
  title: string;
  author: string;
  series: string;
  myRating: number | null;
  avgRating: number | null;
  ratingsCount: number | null;
  pages: number | null;
  shelves: string[];
  dateAdded: string | null;
  dateStarted: string | null;
  dateFinished: string | null;
  timesRead: number | null;
  format: string;
  latestProgress: string;
};

/** What a row maps to, plus the verbatim row (server only). */
type Mapped = { book: Book; raw: Record<string, string> };

/** Control characters out (a cell is one line of plain text), whitespace tidied. */
const plain = (v: string | undefined, max = 500) => (v ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Spreadsheet-safe exports write identifiers as ="0123456789"; take the digits back out. Nothing is evaluated. */
const unwrap = (v: string | undefined) => {
  const m = /^\s*="?([^"]*)"?\s*$/.exec(v ?? "");
  return plain(m ? m[1] : v, 64);
};

const int = (v: string | undefined) => {
  const n = /^\s*-?\d[\d,]*\s*$/.test(v ?? "") ? Number((v ?? "").replace(/,/g, "")) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const float = (v: string | undefined) => {
  const n = /^\s*\d+(\.\d+)?\s*$/.test(v ?? "") ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** YYYY-MM-DD from "2024/03/09", "2024-03-09", "2024-03-09 14:00:00", or "Mar 9, 2024"; null when it is not a date. */
export function isoDate(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(s);
    const mi = m ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].slice(0, 3).toLowerCase()) : -1;
    if (!m || mi < 0) return null;
    [y, mo, d] = [Number(m[3]), mi + 1, Number(m[2])];
  }
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1000 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

export const slug = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** The export's word for a row's status, as a stable slug: "Currently Reading" and "currently-reading" are one. */
export const statusOf = (v: string | undefined) => slug(plain(v, 80)) || "unknown";

const shelvesOf = (v: string | undefined) => {
  const seen = new Set<string>();
  for (const part of (v ?? "").split(/[,;|]/)) {
    const s = plain(part, 80);
    if (s) seen.add(s);
    if (seen.size >= 50) break;
  }
  return [...seen];
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function mapRow(header: string[], cells: string[]): Mapped | { skip: string } {
  const raw: Record<string, string> = {};
  header.forEach((h, i) => (raw[h] = cells[i] ?? ""));
  const title = plain(raw["Title"], 300);
  if (!title) return { skip: "no title" };
  const author = plain(raw["Author"], 200);
  const id = unwrap(raw["Book ID"]);
  const key = /^\d{1,20}$/.test(id) ? `gr:${id}` : `h:${sha(`${title.toLowerCase()}|${author.toLowerCase()}|${unwrap(raw["ISBN13"])}`).slice(0, 24)}`;
  const rating = int(raw["My Rating"]);
  return {
    raw,
    book: {
      key,
      status: statusOf(raw["Status"]),
      title,
      author,
      series: plain(raw["Series"], 200),
      myRating: rating && rating >= 1 && rating <= 5 ? rating : null,
      avgRating: float(raw["Avg Rating"]),
      ratingsCount: int(raw["Ratings Count"]),
      pages: int(raw["Pages"]),
      shelves: shelvesOf(raw["Tags / Shelves"]),
      dateAdded: isoDate(raw["Date Added"]),
      dateStarted: isoDate(raw["Date Started"]),
      dateFinished: isoDate(raw["Date Finished"]),
      timesRead: int(raw["Times Read"]),
      format: plain(raw["Format"], 60),
      latestProgress: plain(raw["Latest Progress"], 60),
    },
  };
}

/* ---------- import ---------- */

export type ImportSummary = {
  rows: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** Which rows were skipped and why. Never the row's content. */
  issues: { row: number; reason: string }[];
  /** Known columns the file did not have. */
  missingColumns: string[];
};

const MAX_ISSUES = 50;

export function importCatalog(userId: string, text: string): ImportSummary {
  if (Buffer.byteLength(text, "utf8") > LIMITS.bytes) throw new CatalogError("That file is too large.", 413);
  const table = parseCsv(text);
  if (!table.length) throw new CatalogError("The file is empty.", 422);
  const header = table[0].map((h) => h.trim());
  if (!header.includes("Title")) throw new CatalogError("This does not look like a Goodreads export: there is no Title column.", 422);
  const dupHeader = header.find((h, i) => header.indexOf(h) !== i);
  if (dupHeader) throw new CatalogError("The file repeats a column name.", 422);

  const out: ImportSummary = { rows: table.length - 1, added: 0, updated: 0, unchanged: 0, skipped: 0, issues: [], missingColumns: GOODREADS_HEADERS.filter((h) => !header.includes(h)) };
  const skip = (row: number, reason: string) => {
    out.skipped++;
    if (out.issues.length < MAX_ISSUES) out.issues.push({ row, reason });
  };
  const at = nowIso();

  tx((db) => {
    const find = stmt(db, "select raw_hash from catalog_books where user_id = ? and key = ?");
    const put = stmt(
      db,
      `insert into catalog_books (user_id, key, status, title, author, series, my_rating, avg_rating, ratings_count, pages, shelves, date_added, date_started, date_finished, times_read, format, latest_progress, raw, raw_hash, imported_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (user_id, key) do update set
         status = excluded.status, title = excluded.title, author = excluded.author, series = excluded.series, my_rating = excluded.my_rating, avg_rating = excluded.avg_rating,
         ratings_count = excluded.ratings_count, pages = excluded.pages, shelves = excluded.shelves, date_added = excluded.date_added, date_started = excluded.date_started,
         date_finished = excluded.date_finished, times_read = excluded.times_read, format = excluded.format, latest_progress = excluded.latest_progress,
         raw = excluded.raw, raw_hash = excluded.raw_hash, updated_at = excluded.updated_at`
    );
    const seen = new Set<string>();
    for (let i = 1; i < table.length; i++) {
      const cells = table[i];
      const row = i + 1; // the file's line, counting the header as 1
      // A row with the wrong number of cells is a broken row, not a book with blanks: do not guess.
      if (cells.length !== header.length) {
        skip(row, `expected ${header.length} columns, found ${cells.length}`);
        continue;
      }
      const m = mapRow(header, cells);
      if ("skip" in m) {
        skip(row, m.skip);
        continue;
      }
      if (seen.has(m.book.key)) {
        skip(row, "duplicate of an earlier row");
        continue;
      }
      seen.add(m.book.key);
      const rawJson = JSON.stringify(m.raw);
      const hash = sha(rawJson);
      const prior = find.get(userId, m.book.key) as { raw_hash: string } | undefined;
      if (prior?.raw_hash === hash) {
        out.unchanged++;
        continue;
      }
      const b = m.book;
      put.run(userId, b.key, b.status, b.title, b.author, b.series, b.myRating, b.avgRating, b.ratingsCount, b.pages, JSON.stringify(b.shelves), b.dateAdded, b.dateStarted, b.dateFinished, b.timesRead, b.format, b.latestProgress, rawJson, hash, at, at);
      if (prior) out.updated++;
      else out.added++;
    }
    stmt(db, "insert into catalog_imports (user_id, at, rows_seen, added, updated, unchanged, skipped) values (?, ?, ?, ?, ?, ?, ?)").run(userId, at, out.rows, out.added, out.updated, out.unchanged, out.skipped);
  });
  return out;
}

/* ---------- reading the catalogue ---------- */

export type CatalogQuery = { q?: string; status?: string; shelf?: string; sort?: "added" | "title" | "author" | "rating"; limit?: number; offset?: number };
export type CatalogPage = { total: number; books: Book[]; statuses: { status: string; count: number }[]; shelves: { shelf: string; count: number }[] };

const like = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

type Row = Record<string, unknown>;
const toBook = (r: Row): Book => ({
  key: String(r.key),
  status: String(r.status),
  title: String(r.title),
  author: String(r.author),
  series: String(r.series),
  myRating: r.my_rating == null ? null : Number(r.my_rating),
  avgRating: r.avg_rating == null ? null : Number(r.avg_rating),
  ratingsCount: r.ratings_count == null ? null : Number(r.ratings_count),
  pages: r.pages == null ? null : Number(r.pages),
  shelves: JSON.parse(String(r.shelves)) as string[],
  dateAdded: r.date_added ? String(r.date_added) : null,
  dateStarted: r.date_started ? String(r.date_started) : null,
  dateFinished: r.date_finished ? String(r.date_finished) : null,
  timesRead: r.times_read == null ? null : Number(r.times_read),
  format: String(r.format),
  latestProgress: String(r.latest_progress),
});

/** Columns a search matches: the public face of a book. Reviews, notes and comments are not among them. */
const SEARCHED = ["title", "author", "series", "shelves", "status"] as const;
const ORDER = {
  added: "coalesce(date_added, '') desc, title collate nocase",
  title: "title collate nocase, key",
  author: "author collate nocase, title collate nocase",
  rating: "coalesce(my_rating, 0) desc, title collate nocase",
} as const;

export function listCatalog(userId: string, q: CatalogQuery = {}): CatalogPage {
  const db = sqlite();
  const where = ["user_id = ?"];
  const args: (string | number)[] = [userId];
  for (const word of (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
    where.push(`(${SEARCHED.map((c) => `${c} like ? escape '\\'`).join(" or ")})`);
    for (let i = 0; i < SEARCHED.length; i++) args.push(like(word));
  }
  if (q.status) {
    where.push("status = ?");
    args.push(statusOf(q.status));
  }
  if (q.shelf) {
    where.push("exists (select 1 from json_each(catalog_books.shelves) where value = ?)");
    args.push(q.shelf);
  }
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 200), 1), 500);
  const offset = Math.max(Math.trunc(q.offset ?? 0), 0);
  const clause = where.join(" and ");
  const total = Number((stmt(db, `select count(*) as n from catalog_books where ${clause}`).get(...args) as { n: number }).n);
  const rows = stmt(
    db,
    `select key, status, title, author, series, my_rating, avg_rating, ratings_count, pages, shelves, date_added, date_started, date_finished, times_read, format, latest_progress
     from catalog_books where ${clause} order by ${q.sort && Object.hasOwn(ORDER, q.sort) ? ORDER[q.sort] : ORDER.added} limit ? offset ?`
  ).all(...args, limit, offset) as Row[];
  const books = rows.map(toBook);
  const statuses = (stmt(db, "select status, count(*) as n from catalog_books where user_id = ? group by status order by n desc, status").all(userId) as Row[]).map((r) => ({ status: String(r.status), count: Number(r.n) }));
  const tally = new Map<string, number>();
  for (const r of stmt(db, "select shelves from catalog_books where user_id = ?").all(userId) as Row[]) for (const s of JSON.parse(String(r.shelves)) as string[]) tally.set(s, (tally.get(s) ?? 0) + 1);
  const shelves = [...tally].map(([shelf, count]) => ({ shelf, count })).sort((a, b) => b.count - a.count || a.shelf.localeCompare(b.shelf)).slice(0, 100);
  return { total, books, statuses, shelves };
}
