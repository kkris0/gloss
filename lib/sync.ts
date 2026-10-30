"use client";

/**
 * Account sync for signed-in readers. The browser stays the source of truth
 * while you read; this mirrors it to the account and back.
 *
 * - Push: what changed since the last push, found by comparing each entity's
 *   stable JSON with a baseline of what the server already has. Deletions are
 *   entities in the baseline that are gone locally, sent as tombstones.
 * - Pull: rows changed since the last pull, merged in with applyRemote. The
 *   baseline then records them, so they are not pushed straight back.
 * - Texts travel separately: pushed once with the shelf entry, fetched on
 *   another device only when it is opened there.
 *
 * The baseline lives in localStorage per user, so a second account on the
 * same browser starts fresh and receives what is on this device.
 *
 * While a page watches the shelf (the library), it also pulls every few
 * seconds, so what an agent saves arrives while you look.
 */

import { forgetDoc, loadDoc, saveDoc, useStore, type RemoteChanges } from "./store";
import type { Article } from "./article";
import { forgetCover } from "./covers";
import { COLLECTIONS, createSyncCore, stable, type Collection, type Conflict, type Entity, type Incoming, type OutRow, type PushBody, type Remote, type Snapshot } from "./sync-core";

function snapshot(): Snapshot {
  const st = useStore.getState();
  const entities = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map<string, Entity>()])) as Snapshot["entities"];
  const busy = new Set<string>();
  const put = (c: Collection, id: string, articleId: string, data: unknown) => entities[c].set(id, { articleId, data, key: stable(data) });

  for (const item of st.library) put("articles", item.id, item.id, item);
  for (const [aid, list] of Object.entries(st.highlights)) for (const h of list) put("highlights", h.id, aid, h);
  for (const [aid, list] of Object.entries(st.glosses))
    for (const g of list) {
      // An answer still being written is left alone until it settles.
      if (g.turns.some((t) => t.streaming)) busy.add(`glosses:${g.id}`);
      else put("glosses", g.id, aid, g);
    }
  for (const [aid, b] of Object.entries(st.briefs)) {
    if (b.status === "ready") put("briefs", aid, aid, b);
    else busy.add(`briefs:${aid}`);
  }
  for (const [aid, p] of Object.entries(st.progress)) put("progress", aid, aid, p);
  return { entities, busy };
}

/** Pages that want arrivals as they happen, and how to tell the running sync. */
let watchers = 0;
let poke: (() => void) | null = null;
const WATCH_MS = 5000;

/** Pull now and every few seconds while the returned stop hasn't been called. */
export function watchShelf(): () => void {
  watchers++;
  poke?.();
  return () => {
    watchers--;
  };
}

export function startSync(userId: string) {
  const storeKey = `gloss:sync:${userId}`;
  const conflictKey = `${storeKey}:conflicts`;
  let baseline: unknown;
  let storedConflicts: Conflict[] = [];
  try {
    const raw = localStorage.getItem(storeKey);
    if (raw) baseline = JSON.parse(raw);
    const rawConflicts = localStorage.getItem(conflictKey);
    if (rawConflicts) storedConflicts = JSON.parse(rawConflicts) as Conflict[];
  } catch {}

  let stopped = false;
  // One operation at a time: a pull never lands in the middle of a push.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (fn: () => Promise<void>) => (chain = chain.then(() => (stopped ? undefined : fn())).catch(() => {}));

  const apply = (changes: Partial<Record<(typeof COLLECTIONS)[number], Incoming[]>>) => {
    for (const r of changes.articles ?? []) {
      if (!r.deleted && r.data && r.before !== undefined && (r.data as { rev?: number }).rev !== undefined && stable(r.data) !== r.before) void forgetDoc(r.id);
      if (r.deleted) void forgetCover(r.id);
    }
    useStore.getState().applyRemote(changes as RemoteChanges);
  };

  const listeners = new Set<(conflicts: Conflict[]) => void>();
  const announce = () => {
    const list = core.conflicts();
    for (const fn of listeners) fn(list);
  };
  const core = createSyncCore(
    {
      snapshot,
      apply,
      loadDoc,
      async pull(since) {
        const q = since ? `?since=${encodeURIComponent(since)}` : "";
        const res = await fetch(`/api/sync${q}`);
        if (!res.ok) throw new Error(`pull ${res.status}`);
        return (await res.json()) as { now: string; changes: Partial<Record<(typeof COLLECTIONS)[number], Remote[]>> };
      },
      async push(changes: Partial<Record<(typeof COLLECTIONS)[number], OutRow[]>>): Promise<PushBody> {
        const res = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
        if (res.status !== 409 && !res.ok) throw new Error(`push ${res.status}`);
        return (await res.json()) as PushBody;
      },
      saveBaseline(next) {
        localStorage.setItem(storeKey, JSON.stringify(next));
      },
      saveConflicts(next) {
        localStorage.setItem(conflictKey, JSON.stringify(next));
        queueMicrotask(announce);
      },
    },
    { baseline, conflicts: storedConflicts }
  );

  const push = core.push;
  const pull = core.pull;

  const sync = () => serial(async () => {
    await pull();
    await push();
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = useStore.subscribe((st, prev) => {
    if (!st.hydrated) return;
    if (st.library === prev.library && st.highlights === prev.highlights && st.glosses === prev.glosses && st.briefs === prev.briefs && st.progress === prev.progress) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => serial(push), 2000);
  });

  let lastPull = 0;
  const pullIfStale = (ms: number) => {
    if (document.visibilityState === "hidden" || Date.now() - lastPull < ms) return;
    lastPull = Date.now();
    sync();
  };
  const onVisible = () => {
    if (document.visibilityState === "hidden") serial(push);
    else pullIfStale(watchers ? WATCH_MS : 20_000);
  };
  document.addEventListener("visibilitychange", onVisible);
  const ticker = setInterval(() => watchers && pullIfStale(WATCH_MS - 1000), WATCH_MS);
  poke = () => pullIfStale(3000);

  lastPull = Date.now();
  sync();

  return {
    conflicts: core.conflicts,
    onConflicts(fn: (conflicts: Conflict[]) => void) {
      listeners.add(fn);
      fn(core.conflicts());
      return () => listeners.delete(fn);
    },
    resolve(id: string, keepMine: boolean) {
      const conflict = core.take(id);
      if (!conflict) return;
      if (!keepMine) {
        const row: Incoming = {
          id: conflict.rowId,
          articleId: conflict.articleId,
          data: conflict.theirs,
          deleted: conflict.theirs === null,
          version: 0,
          before: conflict.mine === null ? null : stable(conflict.mine),
          conflict: false,
        };
        apply({ [conflict.collection]: [row] });
      } else {
        serial(push);
      }
      announce();
    },
    stop() {
      stopped = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      clearInterval(ticker);
      poke = null;
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

/** Fetch one text from the account and keep it on this device. Null when signed out or not there. */
export async function fetchText(id: string): Promise<Article | null> {
  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const { doc } = (await res.json()) as { doc: Article };
    await saveDoc(doc);
    return doc;
  } catch {
    return null;
  }
}
