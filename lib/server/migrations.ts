/**
 * SQLite schema, applied in order and tracked with `pragma user_version`.
 * Safe to run on every start. Imports nothing but types so scripts can load it.
 *
 * Synced tables keep the shape the Postgres version had (user_id, id,
 * article_id, data, deleted, updated_at) so the sync semantics are unchanged:
 * rows carry the client's object as JSON, and a deletion is a tombstone.
 * user_id is always the single owner; it stays in the key so a second reader
 * would not need a migration.
 */

type Db = { exec(sql: string): void; prepare(sql: string): { get(...a: unknown[]): unknown } };

const synced = (name: string, extra = "") => `
create table ${name} (
  user_id text not null,
  id text not null,
  article_id text not null,
  data text not null,
  deleted integer not null default 0,
  updated_at text not null,
  ${extra}
  primary key (user_id, id)
) without rowid;
create index ${name}_user_updated on ${name} (user_id, updated_at);`;

export const MIGRATIONS: string[] = [
  // 1: the synced shelf, painted covers, agent tokens
  `${synced("articles", "doc text,")}
${synced("highlights")}
${synced("glosses")}
${synced("briefs")}
${synced("progress")}
create table covers (
  user_id text not null,
  id text not null,
  jpeg blob not null,
  created_at text not null,
  primary key (user_id, id)
) without rowid;
create table agent_tokens (
  id text primary key,
  user_id text not null,
  hash text not null unique,
  label text not null default '',
  created_at text not null,
  last_used_at text,
  revoked integer not null default 0
);
create index agent_tokens_user on agent_tokens (user_id);`,

  // 2: the owner's login sessions and the login throttle
  `create table sessions (
  id text primary key,            -- sha256 of the cookie value; the cookie itself is never stored
  csrf text not null,
  pw_fp text not null,            -- fingerprint of the password hash the session was made under
  created_at text not null,
  expires_at text not null,
  last_seen_at text not null,
  revoked_at text
);
create index sessions_expires on sessions (expires_at);
create table login_failures (at integer not null);`,

  // 3: the Goodreads catalogue: metadata only, never book text
  `create table catalog_books (
  user_id text not null,
  key text not null,              -- "gr:<Book ID>", or a hash of title+author+isbn when the row has no id
  status text not null,           -- read | currently-reading | to-read | the export's own word, slugged
  title text not null,
  author text not null,
  series text not null default '',
  my_rating integer,              -- 1-5, null when unrated (Goodreads exports 0)
  avg_rating real,
  ratings_count integer,
  pages integer,
  shelves text not null default '[]',
  date_added text,
  date_started text,
  date_finished text,
  times_read integer,
  format text not null default '',
  latest_progress text not null default '',   -- what the export says; not a live reading position
  raw text not null,              -- every column of the CSV row, verbatim, as JSON; never sent to the browser
  raw_hash text not null,
  imported_at text not null,
  updated_at text not null,
  primary key (user_id, key)
) without rowid;
create index catalog_books_status on catalog_books (user_id, status);
create index catalog_books_title on catalog_books (user_id, title collate nocase);
create table catalog_imports (
  id integer primary key autoincrement,
  user_id text not null,
  at text not null,
  rows_seen integer not null,
  added integer not null,
  updated integer not null,
  unchanged integer not null,
  skipped integer not null
);`,

  // 4: a version on every synced row. A write must name the version it was based on and is
  // refused when the row has moved on, so a stale device can never overwrite newer data.
  // Existing rows start at 1; browsers that predate versions rebaseline on their next full pull.
  ["articles", "highlights", "glosses", "briefs", "progress"].map((t) => `alter table ${t} add column version integer not null default 1;`).join("\n"),
];

export function migrate(db: Db): number {
  const current = Number((db.prepare("pragma user_version").get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("begin immediate");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  }
  return MIGRATIONS.length;
}
