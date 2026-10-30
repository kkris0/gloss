/**
 * The sync protocol, with no browser in it: the reconcile rules, the baseline,
 * and the pull and push loops, over a few functions the caller supplies
 * (lib/sync.ts wires them to the store, localStorage and fetch; the tests wire
 * them to a plain object and the real server functions).
 *
 * Every server row has a version that goes up by one on each write. A device
 * remembers, per row, the content and version it last saw (the baseline).
 * Anything that differs from the baseline is an unsent local edit.
 *
 * - Push sends each edit with the version it was based on. The server refuses a
 *   row that has moved on, and answers with its current copy.
 * - Pull and refused pushes meet the same rule, row by row:
 *     not edited here          -> take the server's copy
 *     same as the server's     -> nothing to do (also what a retried push looks like)
 *     edited here, server only re-stamped it -> keep the edit, push it on the new version
 *     edited here, and the server moved too  -> CONFLICT: keep this device's copy in place
 *                              and save the server's copy beside it. The reader can
 *                              keep theirs or accept the server's. Nothing is dropped.
 * - A deletion is a row with deleted set, and is versioned like any other write.
 */

export const COLLECTIONS = ["articles", "highlights", "glosses", "briefs", "progress"] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** A row as the server sends it. `data` is null on a tombstone. */
export type Remote = { id: string; articleId: string; data: unknown; deleted: boolean; version: number };
/** A row on its way into the local store; `before` is the content this device last had synced, `conflict` that local edits were set aside. */
export type Incoming = Remote & { before: string | null | undefined; conflict: boolean };
export type OutRow = { id: string; articleId: string; data: unknown; deleted?: boolean; doc?: unknown; baseVersion?: number };
export type PushBody = {
  applied: { collection: Collection; id: string; version: number }[];
  conflicts: { collection: Collection; current: Remote }[];
};

export type Entity = { articleId: string; data: unknown; key: string };
export type Snapshot = { entities: Record<Collection, Map<string, Entity>>; busy: Set<string> };

/** Last synced content (null for a tombstone), article, and server version. */
export type Seen = [key: string | null, articleId: string, version: number];
export type Baseline = { v: 2; since: string | null; seen: Record<Collection, Record<string, Seen>> };

/** An edit this device made that the account had also changed. `mine` is null when the edit was a deletion; `theirs` null when theirs was. */
export type Conflict = { id: string; collection: Collection; rowId: string; articleId: string; at: number; mine: unknown | null; theirs: unknown | null };

/** Pushes are split to stay well under the request cap. */
const BATCH_BYTES = 1_500_000;
const MAX_BODY = 4_300_000;
/** Pulls overlap a little, so a write that landed while the last pull ran is not missed. Re-seeing a version is a no-op. */
export const OVERLAP_MS = 30_000;

/** JSON with sorted keys, so the same object always compares equal, whatever order the server hands keys back in. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const emptySeen = () => Object.fromEntries(COLLECTIONS.map((c) => [c, {}])) as Baseline["seen"];
export const emptyBaseline = (): Baseline => ({ v: 2, since: null, seen: emptySeen() });

/**
 * Read a stored baseline. One from before versions existed keeps what it knew of each row's content
 * (so edits made since stay edits) but has no versions, and is pulled in full to learn them.
 */
export function readBaseline(raw: unknown): Baseline {
  const r = raw as Partial<Baseline> | null;
  if (!r || typeof r !== "object" || typeof r.seen !== "object" || !r.seen) return emptyBaseline();
  if (r.v === 2) {
    const seen = emptySeen();
    for (const c of COLLECTIONS) {
      const rows = r.seen[c];
      if (!rows || typeof rows !== "object") continue;
      for (const [id, e] of Object.entries(rows))
        if (Array.isArray(e) && (typeof e[0] === "string" || e[0] === null) && typeof e[1] === "string" && Number.isInteger(e[2])) seen[c][id] = [e[0], e[1], e[2]];
    }
    return { v: 2, since: typeof r.since === "string" ? r.since : null, seen };
  }
  const seen = emptySeen();
  for (const c of COLLECTIONS)
    for (const [id, e] of Object.entries(r.seen[c] ?? {})) if (Array.isArray(e)) seen[c][id] = [e[0] as string, e[1] as string, -1];
  return { v: 2, since: null, seen };
}

type Decision = { seen?: Seen; apply?: Incoming; conflict?: Conflict };

/** What to do with one row the server has: see the protocol above. Pure. */
export function decide(c: Collection, r: Remote, seen: Seen | undefined, local: Entity | undefined, busy: boolean): Decision {
  // An answer still being written settles first; if it was edited meanwhile, the next push finds out.
  if (busy) return {};
  if (seen && seen[2] === r.version) return {};
  const localKey = local ? local.key : null;
  const remoteKey = r.deleted ? null : stable(r.data);
  const baseKey = seen ? seen[0] : null;
  const theirs: Seen = [remoteKey, r.articleId, r.version];
  if (localKey === remoteKey) return { seen: theirs };
  if (localKey === baseKey) return { seen: theirs, apply: { ...r, before: seen?.[0], conflict: false } };
  if (remoteKey === baseKey) return { seen: [baseKey, seen?.[1] ?? r.articleId, r.version] };
  return {
    seen: theirs,
    conflict: { id: `${c}:${r.id}:${r.version}`, collection: c, rowId: r.id, articleId: local?.articleId ?? r.articleId, at: Date.now(), mine: local ? local.data : null, theirs: r.deleted ? null : r.data },
  };
}

export type Deps = {
  snapshot(): Snapshot;
  /** Put the server's copy of these rows into the local store. */
  apply(rows: Partial<Record<Collection, Incoming[]>>): void;
  /** An article's text, to go up with its shelf entry. */
  loadDoc(id: string): Promise<unknown | null>;
  pull(since: string | null): Promise<{ now: string; changes: Partial<Record<Collection, Remote[]>> }>;
  /** Send rows; resolves with the server's answer to a 200 or 409 and throws on anything else. */
  push(changes: Partial<Record<Collection, OutRow[]>>): Promise<PushBody>;
  saveBaseline(b: Baseline): void;
  /** Must throw if the list cannot be kept: the server's copy is not applied over unsent edits that were not saved. */
  saveConflicts(list: Conflict[]): void;
};

export function createSyncCore(deps: Deps, init: { baseline?: unknown; conflicts?: Conflict[] } = {}) {
  const base = readBaseline(init.baseline);
  let conflicts = init.conflicts ?? [];

  /** Reconcile a set of server rows with the device, recording conflicts before anything is overwritten. */
  function settle(rows: { c: Collection; r: Remote }[]) {
    const snap = deps.snapshot();
    const decisions = rows.map(({ c, r }) => ({ c, r, d: decide(c, r, base.seen[c][r.id], snap.entities[c].get(r.id), snap.busy.has(`${c}:${r.id}`)) }));
    const fresh = decisions.flatMap((x) => (x.d.conflict && !conflicts.some((k) => k.id === x.d.conflict!.id) ? [x.d.conflict] : []));
    if (fresh.length) {
      deps.saveConflicts([...conflicts, ...fresh]);
      conflicts = [...conflicts, ...fresh];
    }
    const apply: Partial<Record<Collection, Incoming[]>> = {};
    for (const { c, d } of decisions) if (d.apply) (apply[c] ??= []).push(d.apply);
    if (Object.keys(apply).length) deps.apply(apply);
    for (const { c, r, d } of decisions) if (d.seen) base.seen[c][r.id] = d.seen;
  }

  async function pull() {
    const since = base.since ? new Date(Date.parse(base.since) - OVERLAP_MS).toISOString() : null;
    const { now, changes } = await deps.pull(since);
    settle(COLLECTIONS.flatMap((c) => (changes[c] ?? []).map((r) => ({ c, r }))));
    base.since = now;
    deps.saveBaseline(base);
  }

  async function push() {
    const { entities, busy } = deps.snapshot();
    const rows: { c: Collection; row: OutRow; key: string | null; size: number }[] = [];
    // A conflict has a human decision pending. Learning the server's newer version does not
    // authorize us to retry the local edit against it on the next automatic sync.
    const pending = new Set(conflicts.map((k) => `${k.collection}:${k.rowId}`));
    for (const c of COLLECTIONS) {
      const seen = base.seen[c];
      for (const [id, e] of entities[c]) {
        if (pending.has(`${c}:${id}`)) continue;
        if (seen[id]?.[0] === e.key) continue;
        const row: OutRow = { id, articleId: e.articleId, data: e.data, baseVersion: seen[id]?.[2] };
        // A text goes up with its first shelf entry, and again when it is replaced (its rev changes).
        // Samples ship with the app.
        if (c === "articles" && (e.data as { origin?: string }).origin !== "sample") {
          const doc = await deps.loadDoc(id);
          if (doc) row.doc = doc;
        }
        rows.push({ c, row, key: e.key, size: JSON.stringify(row).length });
      }
      for (const [id, [key, articleId, version]] of Object.entries(seen)) {
        // Already a tombstone, still there, or being written: nothing to delete.
        if (key === null || entities[c].has(id) || busy.has(`${c}:${id}`) || pending.has(`${c}:${id}`)) continue;
        rows.push({ c, row: { id, articleId, data: {}, deleted: true, baseVersion: version }, key: null, size: id.length + articleId.length + 64 });
      }
    }
    if (!rows.length) return;

    // Too big for one request even alone: send the shelf entry without the text.
    for (const r of rows) {
      if (r.size > MAX_BODY && r.row.doc) {
        delete r.row.doc;
        r.size = JSON.stringify(r.row).length;
      }
    }

    let batch: typeof rows = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const changes: Partial<Record<Collection, OutRow[]>> = {};
      for (const r of batch) (changes[r.c] ??= []).push(r.row);
      const sent = batch;
      batch = [];
      bytes = 0;
      const body = await deps.push(changes);
      for (const a of body.applied) {
        const r = sent.find((x) => x.c === a.collection && x.row.id === a.id);
        if (r) base.seen[r.c][r.row.id] = [r.key, r.row.articleId, a.version];
      }
      // Rows the server had moved on: the same rules as a pull. A retry of a push that did land
      // comes back here too, identical to what this device holds, and settles quietly.
      if (body.conflicts.length) settle(body.conflicts.map((x) => ({ c: x.collection, r: x.current })));
      deps.saveBaseline(base);
    };
    for (const r of rows) {
      if (bytes + r.size > BATCH_BYTES) await flush();
      batch.push(r);
      bytes += r.size;
    }
    await flush();
  }

  return {
    pull,
    push,
    conflicts: () => conflicts,
    /** Forget a conflict once the reader has dealt with it; returns it. */
    take(id: string): Conflict | undefined {
      const found = conflicts.find((k) => k.id === id);
      if (!found) return undefined;
      const rest = conflicts.filter((k) => k.id !== id);
      deps.saveConflicts(rest);
      conflicts = rest;
      return found;
    },
  };
}
