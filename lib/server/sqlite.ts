/**
 * The one SQLite file: Node's built-in `node:sqlite`, opened once per process.
 * GLOSS_DB_PATH points at it (the Fly volume is /data/gloss.sqlite; the default
 * is ./data/gloss.sqlite, git-ignored). Server-side only.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { migrate } from "./migrations";

const g = globalThis as unknown as { __glossDb?: { path: string; db: DatabaseSync } };

export const dbPath = () => resolve(process.env.GLOSS_DB_PATH || "data/gloss.sqlite");

export function sqlite(): DatabaseSync {
  const path = dbPath();
  if (g.__glossDb && g.__glossDb.path === path) return g.__glossDb.db;
  closeDb();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL so a read never blocks the write; FULL so an acknowledged write survives a power cut.
  db.exec("pragma journal_mode = wal; pragma synchronous = full; pragma busy_timeout = 5000; pragma foreign_keys = on;");
  migrate(db);
  g.__glossDb = { path, db };
  return db;
}

/** Close the handle (tests reopen the same file to prove it persisted). */
export function closeDb() {
  if (g.__glossDb) {
    try {
      g.__glossDb.db.close();
    } catch {}
    g.__glossDb = undefined;
  }
}

/** Run `fn` in one write transaction: all of it lands or none of it does. */
export function tx<T>(fn: (db: DatabaseSync) => T): T {
  const db = sqlite();
  db.exec("begin immediate");
  try {
    const out = fn(db);
    db.exec("commit");
    return out;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}

const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
/** A prepared statement, kept for the life of the handle. */
export function stmt(db: DatabaseSync, sql: string): StatementSync {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

export const nowIso = () => new Date().toISOString();
