import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { articleDoc, createToken, listTokens, loadCover, pullRows, pushRows, revokeToken, saveCover, shelfOf, shelveForUser, tokenUser } from "../lib/db";
import { MIGRATIONS } from "../lib/server/migrations";
import { closeDb, sqlite } from "../lib/server/sqlite";
import { tempDb } from "./helpers";

const U = "owner";
const EPOCH = "1970-01-01T00:00:00Z";
let db: ReturnType<typeof tempDb>;
beforeEach(() => (db = tempDb()));
afterEach(() => db.cleanup());

const article = (id: string, title = id) => ({ id, article_id: id, data: { id, title }, deleted: false, doc: { id, blocks: [{ id: "b1", type: "p", runs: [{ text: `text of ${title}` }] }] } });
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("migrations", () => {
  it("apply once, track user_version, and are safe to run again", () => {
    const d = sqlite();
    assert.equal((d.prepare("pragma user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    closeDb();
    const d2 = sqlite();
    assert.equal((d2.prepare("pragma user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    const tables = (d2.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["articles", "highlights", "glosses", "briefs", "progress", "covers", "agent_tokens", "sessions", "login_failures", "catalog_books", "catalog_imports"]) assert.ok(tables.includes(t), t);
    assert.ok(!tables.includes("free_usage"), "no shared-key allowance table");
  });
  it("uses WAL with full synchronous writes", () => {
    const d = sqlite();
    assert.equal((d.prepare("pragma journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    assert.equal((d.prepare("pragma synchronous").get() as { synchronous: number }).synchronous, 2);
  });
  it("adds version 1 to rows created before optimistic concurrency", () => {
    closeDb();
    const old = new DatabaseSync(db.path);
    for (let i = 0; i < 3; i++) old.exec(MIGRATIONS[i]);
    old.prepare("insert into highlights (user_id, id, article_id, data, deleted, updated_at) values (?, ?, ?, ?, 0, ?)").run(U, "old", "a1", "{}", EPOCH);
    old.exec("pragma user_version = 3");
    old.close();
    assert.equal(pullRows(U, EPOCH).changes.highlights[0].version, 1);
  });
});

describe("sync: two browsers", () => {
  it("a second browser pulls what the first pushed, in every collection", () => {
    pushRows(U, {
      articles: [article("a1", "First")],
      highlights: [{ id: "h1", article_id: "a1", data: { quote: "hello" }, deleted: false }],
      glosses: [{ id: "g1", article_id: "a1", data: { question: "why?" }, deleted: false }],
      briefs: [{ id: "a1", article_id: "a1", data: { gist: "g" }, deleted: false }],
      progress: [{ id: "a1", article_id: "a1", data: { pct: 0.4 }, deleted: false }],
    });
    const pulled = pullRows(U, EPOCH);
    assert.equal(pulled.changes.articles.length, 1);
    assert.deepEqual(pulled.changes.articles[0].data, { id: "a1", title: "First" });
    assert.equal(pulled.changes.articles[0].articleId, "a1");
    assert.deepEqual(pulled.changes.highlights[0].data, { quote: "hello" });
    assert.deepEqual(pulled.changes.glosses[0].data, { question: "why?" });
    assert.deepEqual(pulled.changes.briefs[0].data, { gist: "g" });
    assert.deepEqual(pulled.changes.progress[0].data, { pct: 0.4 });
    // article text is not in the pull; it is fetched one at a time
    assert.ok(!("doc" in pulled.changes.articles[0]));
  });
  it("pulling since the last clock returns newer changes, allowing a boundary duplicate", async () => {
    pushRows(U, { highlights: [{ id: "h1", article_id: "a1", data: { n: 1 }, deleted: false }] });
    const first = pullRows(U, EPOCH);
    await wait();
    pushRows(U, { highlights: [{ id: "h2", article_id: "a1", data: { n: 2 }, deleted: false }] });
    const second = pullRows(U, first.now);
    assert.deepEqual(second.changes.highlights.map((r) => r.id), ["h2"]);
    assert.equal(pullRows(U, new Date(Date.parse(second.now) + 1).toISOString()).changes.highlights.length, 0);
  });
  it("does not miss a write at the exact cursor millisecond", () => {
    const cursor = pullRows(U, EPOCH).now;
    pushRows(U, { highlights: [{ id: "boundary", article_id: "a1", data: { n: 1 }, deleted: false }] });
    // Make the collision deterministic rather than relying on scheduling within a millisecond.
    sqlite().prepare("update highlights set updated_at = ? where user_id = ? and id = ?").run(cursor, U, "boundary");
    assert.deepEqual(pullRows(U, cursor).changes.highlights.map((r) => r.id), ["boundary"]);
  });
  it("accepts a write based on the current version", async () => {
    const first = pushRows(U, { progress: [{ id: "a1", article_id: "a1", data: { pct: 0.1 }, deleted: false }] });
    await wait();
    const second = pushRows(U, { progress: [{ id: "a1", article_id: "a1", data: { pct: 0.9 }, deleted: false, baseVersion: first.applied[0].version }] });
    assert.equal(second.conflicts.length, 0);
    const rows = pullRows(U, EPOCH).changes.progress;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].data, { pct: 0.9 });
  });
  it("refuses a stale write without overwriting the newer row", () => {
    const first = pushRows(U, { progress: [{ id: "a1", article_id: "a1", data: { pct: 0.1 }, deleted: false }] });
    pushRows(U, { progress: [{ id: "a1", article_id: "a1", data: { pct: 0.5 }, deleted: false, baseVersion: first.applied[0].version }] });
    const stale = pushRows(U, { progress: [{ id: "a1", article_id: "a1", data: { pct: 0.2 }, deleted: false, baseVersion: first.applied[0].version }] });
    assert.equal(stale.applied.length, 0);
    assert.deepEqual(stale.conflicts[0].current.data, { pct: 0.5 });
    assert.deepEqual(pullRows(U, EPOCH).changes.progress[0].data, { pct: 0.5 });
  });
  it("a deletion is a tombstone that reaches the other browser, with no data", async () => {
    const created = pushRows(U, { highlights: [{ id: "h1", article_id: "a1", data: { quote: "secret" }, deleted: false }] });
    const seen = pullRows(U, EPOCH);
    await wait();
    pushRows(U, { highlights: [{ id: "h1", article_id: "a1", data: {}, deleted: true, baseVersion: created.applied[0].version }] });
    const after = pullRows(U, seen.now).changes.highlights;
    assert.deepEqual(after, [{ id: "h1", articleId: "a1", data: null, deleted: true, version: 2 }]);
    // and a fresh browser sees the tombstone too, never the old text
    assert.ok(!JSON.stringify(pullRows(U, EPOCH)).includes("secret"));
  });
  it("keeps an article's text when a later push carries only the shelf entry, and drops it on a tombstone", () => {
    const created = pushRows(U, { articles: [article("a1", "Kept")] });
    const renamed = pushRows(U, { articles: [{ id: "a1", article_id: "a1", data: { id: "a1", title: "Renamed" }, deleted: false, baseVersion: created.applied[0].version }] });
    assert.ok(articleDoc(U, "a1"));
    assert.deepEqual(pullRows(U, EPOCH).changes.articles[0].data, { id: "a1", title: "Renamed" });
    pushRows(U, { articles: [{ id: "a1", article_id: "a1", data: {}, deleted: true, baseVersion: renamed.applied[0].version }] });
    assert.equal(articleDoc(U, "a1"), null);
  });
  it("ignores collection names it does not know (they are never put into SQL)", () => {
    pushRows(U, { ["articles; drop table articles; --"]: [article("x")] } as never);
    assert.equal(pullRows(U, EPOCH).changes.articles.length, 0);
    assert.equal(pullRows(U, EPOCH).changes.articles.length, 0);
  });
  it("rows are scoped to their owner", () => {
    pushRows("someone-else", { highlights: [{ id: "h1", article_id: "a1", data: { n: 1 }, deleted: false }] });
    assert.equal(pullRows(U, EPOCH).changes.highlights.length, 0);
  });
  it("a push is all or nothing", () => {
    const bad = { id: "h2", article_id: "a1", data: { n: BigInt(1) }, deleted: false };
    assert.throws(() => pushRows(U, { highlights: [{ id: "h1", article_id: "a1", data: { n: 1 }, deleted: false }, bad] }));
    assert.equal(pullRows(U, EPOCH).changes.highlights.length, 0);
    // and the handle still works afterwards
    pushRows(U, { highlights: [{ id: "h3", article_id: "a1", data: { n: 3 }, deleted: false }] });
    assert.equal(pullRows(U, EPOCH).changes.highlights.length, 1);
  });
});

describe("persistence across a restart", () => {
  it("everything is still there after the handle is closed and the file reopened", () => {
    pushRows(U, { articles: [article("a1", "Durable")], highlights: [{ id: "h1", article_id: "a1", data: { quote: "q" }, deleted: false }] });
    saveCover(U, "a1", new Uint8Array([1, 2, 3, 255]));
    createToken(U, "t1", "hash-1", "Agent");
    closeDb();
    assert.deepEqual(pullRows(U, EPOCH).changes.highlights.map((r) => r.id), ["h1"]);
    assert.ok(articleDoc(U, "a1"));
    assert.deepEqual([...(loadCover(U, "a1") ?? [])], [1, 2, 3, 255]);
    assert.equal(tokenUser("hash-1")?.userId, U);
  });
});

describe("covers", () => {
  it("round-trips bytes, and a text taken off the shelf takes its cover with it", () => {
    const created = pushRows(U, { articles: [article("a1")] });
    saveCover(U, "a1", new Uint8Array([9, 8, 7]));
    assert.deepEqual([...(loadCover(U, "a1") ?? [])], [9, 8, 7]);
    assert.equal(loadCover(U, "nope"), null);
    pushRows(U, { articles: [{ id: "a1", article_id: "a1", data: {}, deleted: true, baseVersion: created.applied[0].version }] });
    assert.equal(loadCover(U, "a1"), null);
  });
});

describe("agent tokens", () => {
  it("lists, authenticates by hash, notes use, and revokes", () => {
    createToken(U, "t1", "hash-1", "Grok Bot");
    createToken(U, "t2", "hash-2", "Claude");
    assert.equal(listTokens(U).length, 2);
    assert.ok(!JSON.stringify(listTokens(U)).includes("hash-1"));
    assert.equal(tokenUser("hash-1")?.label, "Grok Bot");
    assert.ok(listTokens(U).find((t) => t.id === "t1")?.lastUsedAt);
    assert.equal(tokenUser("unknown"), null);
    assert.ok(revokeToken(U, "t1"));
    assert.equal(tokenUser("hash-1"), null);
    assert.ok(!revokeToken(U, "t1"));
    assert.deepEqual(listTokens(U).map((t) => t.id), ["t2"]);
  });
});

describe("the shelf, for an agent", () => {
  it("lists texts with how far the reader has got, and a saved text arrives on the next pull", () => {
    shelveForUser(U, { id: "a1" }, { id: "a1", blocks: [] });
    pushRows(U, { progress: [{ id: "a1", article_id: "a1", data: { pct: 0.5 }, deleted: false }] });
    const shelf = shelfOf(U);
    assert.equal(shelf.length, 1);
    assert.equal(shelf[0].pct, 0.5);
    assert.equal(pullRows(U, EPOCH).changes.articles[0].id, "a1");
    assert.ok(articleDoc(U, "a1"));
  });
});
