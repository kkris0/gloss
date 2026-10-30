"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { csrfToken } from "@/lib/session";
import { useStore } from "@/lib/store";
import { startSync } from "@/lib/sync";
import type { Conflict } from "@/lib/sync-core";

/** The one owner's id in the sync baseline; the server keys every row by its own owner, whatever this says. */
const OWNER = "owner";

/** Runs sync while the owner's session is live and surfaces edits that need the reader's choice. */
export function SyncAgent() {
  const path = usePathname();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [sync, setSync] = useState<ReturnType<typeof startSync> | null>(null);
  useEffect(() => {
    if (path === "/login") return;
    let running: ReturnType<typeof startSync> | null = null;
    let unsubscribe: (() => void) | null = null;
    let live = true;
    void csrfToken().then((token) => {
      // No session: the first guarded request sends the browser to the login page.
      if (!live || !token) return;
      useStore.getState().hydrate();
      running = startSync(OWNER);
      setSync(running);
      unsubscribe = running.onConflicts(setConflicts);
    });
    return () => {
      live = false;
      unsubscribe?.();
      running?.stop();
      setSync(null);
      setConflicts([]);
    };
  }, [path]);
  const conflict = conflicts[0];
  if (!conflict || !sync) return null;
  const what = conflict.collection === "articles" ? "shelf entry" : conflict.collection.replace(/s$/, "");
  return (
    <aside role="alert" className="fixed bottom-4 left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 rounded-xl border border-ink/15 bg-bg p-4 shadow-xl">
      <p className="text-[14px] font-semibold text-ink">Sync found two edits</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        This device and the server changed the same {what}. Your edit is still here. Choose which copy to keep{conflicts.length > 1 ? ` (${conflicts.length} to review)` : ""}.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="h-8 rounded-lg px-3 text-[12.5px] font-medium text-ink-2 hover:bg-sunk" onClick={() => sync.resolve(conflict.id, false)}>
          Use server copy
        </button>
        <button type="button" className="h-8 rounded-lg bg-ink px-3 text-[12.5px] font-medium text-bg" onClick={() => sync.resolve(conflict.id, true)}>
          Keep this edit
        </button>
      </div>
    </aside>
  );
}
