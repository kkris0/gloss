import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pullRows, pushRows, type Collection } from "../lib/db";
import { COLLECTIONS, createSyncCore, stable, type Baseline, type Conflict, type Incoming, type Snapshot } from "../lib/sync-core";
import { closeDb } from "../lib/server/sqlite";
import { tempDb } from "./helpers";

const U = "owner";
let tmp: ReturnType<typeof tempDb>;
beforeEach(() => (tmp = tempDb()));
afterEach(() => tmp.cleanup());

type Local = Partial<Record<Collection, Record<string, { articleId: string; data: unknown }>>>;

function device(local: Local = {}, saved?: Baseline, savedConflicts: Conflict[] = []) {
  let baseline: Baseline | undefined = saved;
  let conflicts = savedConflicts;
  const snapshot = (): Snapshot => ({
    entities: Object.fromEntries(
      COLLECTIONS.map((c) => [
        c,
        new Map(Object.entries(local[c] ?? {}).map(([id, e]) => [id, { ...e, key: stable(e.data) }])),
      ])
    ) as Snapshot["entities"],
    busy: new Set(),
  });
  const core = createSyncCore(
    {
      snapshot,
      apply(changes) {
        for (const c of COLLECTIONS) for (const r of changes[c] ?? []) apply(local, c, r);
      },
      loadDoc: async () => null,
      pull: async (since) => pullRows(U, since ?? "1970-01-01T00:00:00Z"),
      push: async (changes) => {
        const wire = Object.fromEntries(
          Object.entries(changes).map(([c, rows]) => [
            c,
            rows?.map((r) => ({ id: r.id, article_id: r.articleId, data: r.data, deleted: Boolean(r.deleted), baseVersion: r.baseVersion })),
          ])
        );
        return pushRows(U, wire);
      },
      saveBaseline(b) {
        baseline = structuredClone(b);
      },
      saveConflicts(c) {
        conflicts = structuredClone(c);
      },
    },
    { baseline, conflicts }
  );
  return { core, local, baseline: () => baseline!, conflicts: () => conflicts };
}

function apply(local: Local, c: Collection, r: Incoming) {
  const rows = (local[c] ??= {});
  if (r.deleted) delete rows[r.id];
  else rows[r.id] = { articleId: r.articleId, data: r.data };
}

const progress = (pct: number) => ({ articleId: "a1", data: { pct } });

describe("conflict-aware sync", () => {
  it("initially pushes local rows and initially pulls server rows", async () => {
    const first = device({ progress: { a1: progress(0.2) } });
    await first.core.pull();
    await first.core.push();
    const second = device();
    await second.core.pull();
    assert.deepEqual(second.local.progress?.a1.data, { pct: 0.2 });
  });

  it("refuses a stale-client overwrite and leaves a recoverable conflict", async () => {
    const a = device({ progress: { a1: progress(0.1) } });
    await a.core.pull();
    await a.core.push();
    const b = device();
    await b.core.pull();
    a.local.progress!.a1.data = { pct: 0.4 };
    await a.core.push();
    b.local.progress!.a1.data = { pct: 0.9 };
    await b.core.push();
    assert.deepEqual(b.local.progress!.a1.data, { pct: 0.9 }, "the unsent local edit stays visible");
    assert.deepEqual(b.conflicts()[0]?.mine, { pct: 0.9 });
    assert.deepEqual(b.conflicts()[0]?.theirs, { pct: 0.4 });
    assert.deepEqual(pullRows(U, "1970-01-01T00:00:00Z").changes.progress[0].data, { pct: 0.4 });
    await b.core.push();
    await b.core.pull();
    await b.core.push();
    assert.equal(b.conflicts().length, 1, "the unresolved choice remains visible");
    assert.deepEqual(pullRows(U, "1970-01-01T00:00:00Z").changes.progress[0].data, { pct: 0.4 }, "automatic sync cannot resolve a conflict for the reader");
    assert.ok(b.core.take(b.conflicts()[0].id));
    await b.core.push();
    assert.deepEqual(pullRows(U, "1970-01-01T00:00:00Z").changes.progress[0].data, { pct: 0.9 }, "keeping mine retries against the learned version");
  });

  it("does not overwrite an offline edit during pull", async () => {
    const a = device({ progress: { a1: progress(0.1) } });
    await a.core.pull();
    await a.core.push();
    const b = device();
    await b.core.pull();
    b.local.progress!.a1.data = { pct: 0.8 };
    a.local.progress!.a1.data = { pct: 0.3 };
    await a.core.push();
    await b.core.pull();
    assert.deepEqual(b.local.progress!.a1.data, { pct: 0.8 });
    assert.equal(b.conflicts().length, 1);
  });

  it("syncs deletions as versioned tombstones", async () => {
    const a = device({ progress: { a1: progress(0.1) } });
    await a.core.pull();
    await a.core.push();
    const b = device();
    await b.core.pull();
    delete a.local.progress!.a1;
    await a.core.push();
    const row = pullRows(U, "1970-01-01T00:00:00Z").changes.progress[0];
    assert.equal(row.deleted, true);
    await b.core.pull();
    assert.equal(b.local.progress?.a1, undefined);
  });

  it("treats an acknowledged write retried after a lost response as idempotent", async () => {
    const d = device({ progress: { a1: progress(0.5) } });
    await d.core.pull();
    const original = pushRows(U, { progress: [{ id: "a1", article_id: "a1", data: { pct: 0.5 }, deleted: false }] });
    assert.equal(original.applied.length, 1);
    await d.core.push();
    assert.equal(d.conflicts().length, 0);
    assert.equal(pullRows(U, "1970-01-01T00:00:00Z").changes.progress[0].version, 1);
  });

  it("migrates a legacy baseline with a full pull and preserves later local edits", async () => {
    pushRows(U, { progress: [{ id: "a1", article_id: "a1", data: { pct: 0.1 }, deleted: false }] });
    const legacy = { since: "2020-01-01T00:00:00Z", seen: { progress: { a1: [stable({ pct: 0.1 }), "a1"] } } };
    const d = device({ progress: { a1: progress(0.7) } }, legacy as never);
    await d.core.pull();
    assert.deepEqual(d.local.progress!.a1.data, { pct: 0.7 });
    await d.core.push();
    assert.deepEqual(pullRows(U, "1970-01-01T00:00:00Z").changes.progress[0].data, { pct: 0.7 });
  });

  it("retains baseline versions and tombstones across a restart", async () => {
    const a = device({ progress: { a1: progress(0.2) } });
    await a.core.pull();
    await a.core.push();
    const saved = structuredClone(a.baseline());
    closeDb();
    const restarted = device({ progress: { a1: progress(0.2) } }, saved);
    delete restarted.local.progress!.a1;
    await restarted.core.push();
    assert.equal(pullRows(U, "1970-01-01T00:00:00Z").changes.progress[0].deleted, true);
  });
});
