import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CatalogError, GOODREADS_HEADERS, importCatalog, isoDate, listCatalog, parseCsv, statusOf } from "../lib/server/catalog";
import { closeDb, sqlite } from "../lib/server/sqlite";
import { tempDb } from "./helpers";

const U = "owner";
// A synthetic file: invented titles and text only. No real export is ever read by the tests.
const FIXTURE = readFileSync(join(process.cwd(), "tests/fixtures/goodreads-synthetic.csv"), "utf8");
let db: ReturnType<typeof tempDb>;
beforeEach(() => (db = tempDb()));
afterEach(() => db.cleanup());

describe("fixture", () => {
  it("has the 31 known header names, in order", () => {
    const header = parseCsv(FIXTURE)[0];
    assert.deepEqual(header, [...GOODREADS_HEADERS]);
    assert.equal(header.length, 31);
  });
});

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded commas and newlines, CRLF, and a BOM", () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n'), [["a", "b"], ["x, y", 'say "hi"\nthere']]);
    assert.deepEqual(parseCsv("a,b\n\n1,2"), [["a", "b"], ["1", "2"]]);
    assert.deepEqual(parseCsv("a,,\n"), [["a", "", ""]]);
  });
  it("refuses a file cut off inside a quote", () => {
    assert.throws(() => parseCsv('a,b\n"unterminated,1'), (e) => e instanceof CatalogError && e.status === 422);
  });
  it("is bounded in rows, columns and cell length", () => {
    assert.throws(() => parseCsv("a\n1\n2\n3\n4", { rows: 3 }), CatalogError);
    assert.throws(() => parseCsv("a,b,c,d", { columns: 3 }), CatalogError);
    assert.throws(() => parseCsv(`a\n${"x".repeat(50)}`, { cell: 40 }), CatalogError);
    assert.throws(() => parseCsv(`a\n"${"x".repeat(50)}"`, { cell: 40 }), CatalogError);
  });
});

describe("mapping helpers", () => {
  it("reads dates in the formats exports use, and rejects the impossible", () => {
    assert.equal(isoDate("2023/01/05"), "2023-01-05");
    assert.equal(isoDate("2024-02-10 08:00:00"), "2024-02-10");
    assert.equal(isoDate("Mar 9, 2024"), "2024-03-09");
    assert.equal(isoDate("2024-13-45"), null);
    assert.equal(isoDate("2023/02/30"), null);
    assert.equal(isoDate("soon"), null);
    assert.equal(isoDate(""), null);
  });
  it("slugs the export's status words", () => {
    assert.equal(statusOf("Currently Reading"), "currently-reading");
    assert.equal(statusOf("currently-reading"), "currently-reading");
    assert.equal(statusOf("To Read"), "to-read");
    assert.equal(statusOf(""), "unknown");
  });
});

describe("importing the synthetic export", () => {
  it("adds good rows, skips broken ones with a reason, and reports without echoing content", () => {
    const r = importCatalog(U, FIXTURE);
    assert.equal(r.rows, 8);
    assert.equal(r.added, 5);
    assert.equal(r.skipped, 3);
    assert.deepEqual(r.missingColumns, []);
    assert.deepEqual(r.issues.map((i) => i.reason).sort(), ["duplicate of an earlier row", "expected 31 columns, found 4", "no title"]);
    assert.ok(!JSON.stringify(r).includes("Broken Row"));
    assert.ok(r.issues.every((i) => i.row >= 2));
  });

  it("is idempotent: the same file again changes nothing", () => {
    importCatalog(U, FIXTURE);
    const before = sqlite().prepare("select key, raw_hash, imported_at, updated_at from catalog_books order by key").all();
    const again = importCatalog(U, FIXTURE);
    assert.deepEqual({ added: again.added, updated: again.updated, unchanged: again.unchanged }, { added: 0, updated: 0, unchanged: 5 });
    assert.deepEqual(sqlite().prepare("select key, raw_hash, imported_at, updated_at from catalog_books order by key").all(), before);
    assert.equal(listCatalog(U).total, 5);
  });

  it("updates a changed row in place, keeps its identity, and removes nothing", () => {
    importCatalog(U, FIXTURE);
    const edited = FIXTURE.replace("Currently Reading,Field Notes on Nothing,,Bo Fixture,0,", "Read,Field Notes on Nothing,,Bo Fixture,4,");
    assert.notEqual(edited, FIXTURE);
    const r = importCatalog(U, edited);
    assert.deepEqual({ added: r.added, updated: r.updated, unchanged: r.unchanged }, { added: 0, updated: 1, unchanged: 4 });
    const book = listCatalog(U, { q: "field notes" }).books[0];
    assert.equal(book.status, "read");
    assert.equal(book.myRating, 4);
    // a file with fewer books does not delete the others
    const one = FIXTURE.split("\r\n").slice(0, 2).join("\r\n") + "\r\n";
    importCatalog(U, one);
    assert.equal(listCatalog(U).total, 5);
  });

  it("keeps the original ids, shelves, ratings, status and dates", () => {
    importCatalog(U, FIXTURE);
    const all = listCatalog(U, { sort: "title", limit: 50 }).books;
    const by = (t: string) => all.find((b) => b.title.startsWith(t))!;

    const a = by("The Synthetic Lighthouse");
    assert.equal(a.key, "gr:1001");
    assert.equal(a.status, "read");
    assert.equal(a.author, "Ada Placeholder");
    assert.equal(a.series, "Harbour Cycle #1");
    assert.equal(a.myRating, 5);
    assert.equal(a.avgRating, 4.21);
    assert.equal(a.ratingsCount, 12345);
    assert.equal(a.pages, 320);
    assert.deepEqual(a.shelves, ["favourites", "fiction", "to-reread"]);
    assert.equal(a.dateAdded, "2023-01-05");
    assert.equal(a.dateStarted, "2023-01-06");
    assert.equal(a.dateFinished, "2023-01-20");
    assert.equal(a.timesRead, 2);
    assert.equal(a.format, "Paperback");
    assert.equal(a.latestProgress, "100%");

    const b = by("Field Notes");
    assert.equal(b.key, "gr:1002");
    assert.equal(b.status, "currently-reading");
    assert.equal(b.myRating, null, "Goodreads writes 0 for unrated");
    assert.deepEqual(b.shelves, ["nonfiction", "essays"]);
    assert.equal(b.latestProgress, "45%");
    assert.equal(b.dateFinished, null);

    const c = by("Tëst");
    assert.equal(c.title, "Tëst Ünïcode — Ça va?");
    assert.equal(c.pages, null);
    assert.equal(c.dateAdded, null);
    assert.equal(c.dateFinished, null);
    assert.equal(c.myRating, 3);

    const d = by("No Book Id");
    assert.match(d.key, /^h:[0-9a-f]{24}$/);
    assert.equal(d.status, "did-not-finish");
    // the same row gets the same key next time
    importCatalog(U, FIXTURE);
    assert.equal(listCatalog(U, { q: "no book id" }).books[0].key, d.key);
  });

  it("keeps the whole exported row on the server, verbatim, including the spreadsheet-style ISBN", () => {
    importCatalog(U, FIXTURE);
    const row = sqlite().prepare("select raw from catalog_books where key = 'gr:1001'").get() as { raw: string };
    const raw = JSON.parse(row.raw) as Record<string, string>;
    assert.equal(Object.keys(raw).length, 31);
    assert.equal(raw["ISBN13"], '="9780123456786"');
    assert.match(raw["My Review"], /^SYNTHETIC-REVIEW-TEXT: line one,\nline two with "quotes"$/);
    assert.equal(raw["Review ID"], "9001");
  });
});

describe("private fields and inert cells", () => {
  it("never returns reviews, notes, comments, urls or ids other than the key, and cannot search them", () => {
    importCatalog(U, FIXTURE);
    const page = JSON.stringify(listCatalog(U, { limit: 500 }));
    for (const secret of ["SYNTHETIC-REVIEW", "SYNTHETIC-NOTE", "SYNTHETIC-COMMENT", "images.example.invalid", "example.invalid/book", "9001", "9780123456786"]) assert.ok(!page.includes(secret), secret);
    for (const q of ["SYNTHETIC-REVIEW", "SYNTHETIC-NOTE", "9780123456786", "images.example.invalid"]) assert.equal(listCatalog(U, { q }).total, 0, q);
  });
  it("stores formula-looking and HTML-looking cells as plain text, unchanged and unevaluated", () => {
    importCatalog(U, FIXTURE);
    const b = listCatalog(U, { q: "HYPERLINK" }).books[0];
    assert.equal(b.title, '=HYPERLINK("https://evil.example.invalid","click")');
    assert.equal(b.author, "+cmd|' /C calc'!A0");
    assert.deepEqual(b.shelves, ["@SUM(1+1)", "<script>alert(1)</script>"]);
    assert.equal(b.dateAdded, "2024-03-09");
  });
  it("strips control characters from displayed cells", () => {
    const csv = `Title,Author\r\n"Bell\u0007 and\u0000 line\nbreak",Someone\r\n`;
    importCatalog(U, csv);
    assert.equal(listCatalog(U).books[0].title, "Bell and line break");
  });
});

describe("search and filters", () => {
  beforeEach(() => void importCatalog(U, FIXTURE));
  const titles = (q: Parameters<typeof listCatalog>[1]) => listCatalog(U, { ...q, sort: "title" }).books.map((b) => b.title);

  it("finds by title, author, series and shelf, every word required, any case", () => {
    assert.deepEqual(titles({ q: "LIGHTHOUSE" }), ["The Synthetic Lighthouse"]);
    assert.deepEqual(titles({ q: "bo fixture" }), ["Field Notes on Nothing"]);
    assert.deepEqual(titles({ q: "harbour" }), ["The Synthetic Lighthouse"]);
    assert.deepEqual(titles({ q: "essays" }), ["Field Notes on Nothing"]);
    assert.deepEqual(titles({ q: "ada nothing" }), []);
    assert.equal(listCatalog(U, { q: "  " }).total, 5);
  });
  it("treats wildcards and SQL as plain text", () => {
    for (const q of ["%", "_", "\\", "'; drop table catalog_books; --", '" or 1=1']) assert.equal(listCatalog(U, { q }).total, 0, q);
    assert.equal(listCatalog(U).total, 5);
  });
  it("filters by status and by exact shelf, and reports the counts for the filter bar", () => {
    assert.deepEqual(titles({ status: "currently-reading" }), ["Field Notes on Nothing"]);
    assert.deepEqual(titles({ status: "Currently Reading" }), ["Field Notes on Nothing"]);
    assert.equal(listCatalog(U, { status: "read" }).total, 2);
    assert.deepEqual(titles({ shelf: "fiction" }), ["The Synthetic Lighthouse"]);
    assert.deepEqual(titles({ shelf: "fic" }), []);
    const page = listCatalog(U, { status: "read" });
    assert.deepEqual(Object.fromEntries(page.statuses.map((s) => [s.status, s.count])), { read: 2, "currently-reading": 1, "did-not-finish": 1, "to-read": 1 });
    assert.ok(page.shelves.some((s) => s.shelf === "fiction" && s.count === 1));
  });
  it("sorts, pages, and refuses an unknown sort key without breaking", () => {
    assert.deepEqual(listCatalog(U, { sort: "rating" }).books.map((b) => b.myRating).slice(0, 3), [5, 3, 2]);
    const p1 = listCatalog(U, { sort: "title", limit: 2, offset: 0 });
    const p2 = listCatalog(U, { sort: "title", limit: 2, offset: 2 });
    assert.equal(p1.total, 5);
    assert.equal(p1.books.length + p2.books.length, 4);
    assert.notEqual(p1.books[0].key, p2.books[0].key);
    assert.equal(listCatalog(U, { sort: "__proto__" as never }).total, 5);
    assert.equal(listCatalog(U, { limit: 1e9 }).books.length, 5);
  });
  it("is scoped to the owner", () => {
    assert.equal(listCatalog("someone-else").total, 0);
  });
});

describe("bounds and bad files", () => {
  it("refuses an empty file, a file with no Title column, a repeated column, and an oversize file", () => {
    assert.throws(() => importCatalog(U, ""), (e) => e instanceof CatalogError && e.status === 422);
    assert.throws(() => importCatalog(U, "Author,Pages\nA,1"), /no Title column/);
    assert.throws(() => importCatalog(U, "Title,Title\nA,B"), /repeats a column/);
    assert.throws(() => importCatalog(U, "Title\n" + "x".repeat(9 * 1024 * 1024)), (e) => e instanceof CatalogError && e.status === 413);
    assert.equal(listCatalog(U).total, 0);
  });
  it("an import that fails halfway leaves nothing behind", () => {
    const rows = Array.from({ length: 3 }, (_, i) => `Book ${i},A${i}`).join("\n");
    assert.throws(() => importCatalog(U, `Title,Author\n${rows}\n"cut off`));
    assert.equal(listCatalog(U).total, 0);
  });
  it("copes with a thousand rows quickly and stays idempotent", () => {
    const header = [...GOODREADS_HEADERS].join(",");
    const lines = Array.from({ length: 1000 }, (_, i) => {
      const cells = GOODREADS_HEADERS.map((h) => (h === "Title" ? `Book ${i}` : h === "Book ID" ? String(2000 + i) : h === "Status" ? (i % 2 ? "read" : "to-read") : ""));
      return cells.join(",");
    });
    const csv = [header, ...lines].join("\n");
    const t0 = Date.now();
    assert.equal(importCatalog(U, csv).added, 1000);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(importCatalog(U, csv).unchanged, 1000);
  });
});

describe("restart", () => {
  it("the catalogue is still there after the database is closed and reopened", () => {
    importCatalog(U, FIXTURE);
    closeDb();
    assert.equal(listCatalog(U).total, 5);
    assert.equal(Number((sqlite().prepare("select count(*) as n from catalog_imports").get() as { n: number }).n), 1);
  });
});
