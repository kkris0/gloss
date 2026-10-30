/**
 * The library's data, in the one SQLite file (see lib/server/sqlite.ts).
 * Same functions and semantics the Postgres version had: transactional
 * pull and push, tombstones instead of deletes, painted covers, agent tokens.
 * Server-side only. Every row is owned by a user id; there is one owner.
 */

import { nowIso, stmt, tx, sqlite } from "./server/sqlite";

/** The single owner's id. Rows are keyed by it so the sync code is unchanged. */
export const OWNER_ID = "owner";

/** The tables the sync route reads and writes. Names are only ever taken from this list. */
export const COLLECTIONS = ["articles", "highlights", "glosses", "briefs", "progress"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export const isCollection = (v: unknown): v is Collection => typeof v === "string" && (COLLECTIONS as readonly string[]).includes(v);

/** `baseVersion` is the row version the device last saw; omit it only for a row the device believes is new. */
export type PushRow = { id: string; article_id: string; data: unknown; deleted: boolean; doc?: unknown; baseVersion?: number };
export type PullRow = { id: string; articleId: string; data: unknown; deleted: boolean; version: number };
/** What a push did: rows written (with their new version) and rows refused because the server's copy had moved on. */
export type PushResult = {
  applied: { collection: Collection; id: string; version: number }[];
  conflicts: { collection: Collection; current: PullRow }[];
};

type Row = Record<string, unknown>;

const pullRow = (r: Row): PullRow => ({
  id: String(r.id),
  articleId: String(r.article_id),
  data: r.deleted ? null : JSON.parse(String(r.data)),
  deleted: Boolean(r.deleted),
  version: Number(r.version),
});

/** Rows changed at or after `since` in every collection, tombstones included, plus the server clock to pull from next time. */
export function pullRows(userId: string, since: string): { now: string; changes: Record<Collection, PullRow[]> } {
  const db = sqlite();
  // Take the clock before reading. Include the cursor boundary because timestamps have
  // millisecond precision: a write in the same millisecond must be seen on the next pull.
  // A boundary row may be returned twice; clients already tolerate overlapping pulls.
  const now = nowIso();
  db.exec("begin");
  try {
    const changes = Object.fromEntries(
      COLLECTIONS.map((t) => [
        t,
        (stmt(db, `select id, article_id, data, deleted, version from ${t} where user_id = ? and updated_at >= ? order by updated_at, id`).all(userId, since) as Row[]).map(pullRow),
      ])
    ) as Record<Collection, PullRow[]>;
    return { now, changes };
  } finally {
    db.exec("commit");
  }
}

/**
 * Write every collection's rows in one transaction, each only if the stored row is still at the
 * version the device based its edit on (or does not exist yet). A row that has moved on is not
 * touched and comes back as a conflict carrying the server's current copy, for the device to
 * reconcile. Nothing is overwritten by a stale write, and the rest of the push still lands.
 */
export function pushRows(userId: string, changes: Partial<Record<Collection, PushRow[]>>): PushResult {
  const at = nowIso();
  return tx((db) => {
    const result: PushResult = { applied: [], conflicts: [] };
    const tombstoned: string[] = [];
    for (const [t, rows] of Object.entries(changes)) {
      if (!isCollection(t) || !rows?.length) continue;
      const isArticles = t === "articles";
      const read = stmt(db, `select id, article_id, data, deleted, version from ${t} where user_id = ? and id = ?`);
      const up = stmt(
        db,
        `insert into ${t} (user_id, id, article_id, data, deleted, updated_at, version${isArticles ? ", doc" : ""}) values (?, ?, ?, ?, ?, ?, ?${isArticles ? ", ?" : ""})
         on conflict (user_id, id) do update set
           article_id = excluded.article_id, data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, version = excluded.version${
             // An article pushed without its text keeps the stored one; a tombstone drops it.
             isArticles ? ", doc = case when excluded.deleted then null else coalesce(excluded.doc, articles.doc) end" : ""
           }`
      );
      for (const r of rows) {
        const cur = read.get(userId, r.id) as Row | undefined;
        if (cur && Number(cur.version) !== r.baseVersion) {
          result.conflicts.push({ collection: t, current: pullRow(cur) });
          continue;
        }
        const version = cur ? Number(cur.version) + 1 : 1;
        const args: (string | number | null)[] = [userId, r.id, r.article_id, JSON.stringify(r.data ?? {}), r.deleted ? 1 : 0, at, version];
        if (isArticles) args.push(r.doc == null ? null : JSON.stringify(r.doc));
        up.run(...args);
        result.applied.push({ collection: t, id: r.id, version });
        if (isArticles && r.deleted) tombstoned.push(r.id);
      }
    }
    // A text taken off the shelf takes its painted cover with it.
    const del = stmt(db, "delete from covers where user_id = ? and id = ?");
    for (const id of tombstoned) del.run(userId, id);
    return result;
  });
}

/** One article's full text. */
export function articleDoc(userId: string, id: string): unknown | null {
  const r = stmt(sqlite(), "select doc from articles where user_id = ? and id = ? and not deleted and doc is not null").get(userId, id) as Row | undefined;
  return r ? JSON.parse(String(r.doc)) : null;
}

/* ---------- painted covers ---------- */

export function saveCover(userId: string, id: string, jpeg: Uint8Array): void {
  stmt(
    sqlite(),
    `insert into covers (user_id, id, jpeg, created_at) values (?, ?, ?, ?)
     on conflict (user_id, id) do update set jpeg = excluded.jpeg, created_at = excluded.created_at`
  ).run(userId, id, jpeg, nowIso());
}

export function loadCover(userId: string, id: string): Uint8Array | null {
  const r = stmt(sqlite(), "select jpeg from covers where user_id = ? and id = ?").get(userId, id) as Row | undefined;
  return r ? new Uint8Array(r.jpeg as Uint8Array) : null;
}

/* ---------- agent tokens ---------- */

export type AgentToken = { id: string; label: string; createdAt: string; lastUsedAt: string | null };

export function createToken(userId: string, id: string, hash: string, label: string): void {
  stmt(sqlite(), "insert into agent_tokens (id, user_id, hash, label, created_at) values (?, ?, ?, ?, ?)").run(id, userId, hash, label, nowIso());
}

export function listTokens(userId: string): AgentToken[] {
  const rows = stmt(sqlite(), "select id, label, created_at, last_used_at from agent_tokens where user_id = ? and not revoked order by created_at desc, id").all(userId) as Row[];
  return rows.map((r) => ({ id: String(r.id), label: String(r.label), createdAt: String(r.created_at), lastUsedAt: r.last_used_at ? String(r.last_used_at) : null }));
}

export function revokeToken(userId: string, id: string): boolean {
  return Number(stmt(sqlite(), "update agent_tokens set revoked = 1 where user_id = ? and id = ? and not revoked").run(userId, id).changes) > 0;
}

/** The reader a token belongs to, noting that it was used. Null for an unknown or revoked token. */
export function tokenUser(hash: string): { userId: string; label: string } | null {
  const r = stmt(sqlite(), "update agent_tokens set last_used_at = ? where hash = ? and not revoked returning user_id, label").get(nowIso(), hash) as Row | undefined;
  return r ? { userId: String(r.user_id), label: String(r.label ?? "") } : null;
}

/* ---------- the library, for an agent ---------- */

export type ShelfRow = { id: string; data: Record<string, unknown>; pct: number };

/** Every text on a reader's shelf, with how far they've read. */
export function shelfOf(userId: string): ShelfRow[] {
  const rows = stmt(
    sqlite(),
    `select a.id, a.data, p.data as progress from articles a
     left join progress p on p.user_id = a.user_id and p.id = a.id and not p.deleted
     where a.user_id = ? and not a.deleted order by a.updated_at desc, a.id`
  ).all(userId) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    data: (JSON.parse(String(r.data)) ?? {}) as Record<string, unknown>,
    pct: Number((r.progress ? (JSON.parse(String(r.progress)) as { pct?: number }) : null)?.pct ?? 0),
  }));
}

/** Put one imported text on a reader's shelf, as their browser would: the next sync brings it down. */
export function shelveForUser(userId: string, item: { id: string }, doc: unknown): void {
  stmt(
    sqlite(),
    `insert into articles (user_id, id, article_id, data, doc, deleted, updated_at) values (?, ?, ?, ?, ?, 0, ?)
     on conflict (user_id, id) do update set data = excluded.data, doc = excluded.doc, deleted = 0, updated_at = excluded.updated_at, version = articles.version + 1`
  ).run(userId, item.id, item.id, JSON.stringify(item), JSON.stringify(doc), nowIso());
}
