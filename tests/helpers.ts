import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../lib/server/sqlite";

/** A fresh database file in a temp directory, pointed at by GLOSS_DB_PATH. Returns its cleanup. */
export function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gloss-test-"));
  const path = join(dir, "gloss.sqlite");
  closeDb();
  process.env.GLOSS_DB_PATH = path;
  return {
    path,
    cleanup: () => {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Cheap scrypt cost for tests; production hashes use the default. */
export const FAST = { N: 2 ** 10 };
