"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { Popover, barBtn } from "@/components/ui/Popover";
import { forgetSession } from "@/lib/session";

/** The owner's menu: sign out here, or everywhere. There is no one else to be. */
export function Account() {
  const [busy, setBusy] = useState(false);

  const out = async (path: "logout" | "revoke-all") => {
    setBusy(true);
    await fetch(`/api/auth/${path}`, { method: "POST" }).catch(() => {});
    forgetSession();
    location.assign("/login");
  };

  return (
    <Popover label="Account" tip="Sign out" width={260} triggerClass={`${barBtn} !px-3`} trigger={<LogOut size={15} strokeWidth={1.8} aria-hidden />}>
      {() => (
        <div>
          <p className="text-[13.5px] font-medium text-ink">Signed in</p>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-3">Your shelves and notes stay on this server.</p>
          <div className="mt-3 flex flex-col gap-1.5">
            <button type="button" disabled={busy} onClick={() => out("logout")} className="h-9 rounded-lg bg-ink px-3 text-[13px] font-medium text-bg disabled:opacity-40">
              Sign out
            </button>
            <button type="button" disabled={busy} onClick={() => out("revoke-all")} className="h-9 rounded-lg px-3 text-[12.5px] font-medium text-ink-2 hover:bg-sunk disabled:opacity-40">
              Sign out everywhere
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
