"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";

/** Only a path on this site is followed after signing in. */
const safeNext = (v: string | null) => (v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/");

/** Where to go once signed in: /login?next=... when sent there, otherwise the address this page was served at in place of the one asked for. */
const destination = () => (location.pathname === "/login" ? safeNext(new URLSearchParams(location.search).get("next")) : safeNext(location.pathname + location.search));

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (res.ok) {
        // A full load, so the first request carries the new cookie.
        location.assign(destination());
        return;
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `Sign-in failed (${res.status}).`);
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="mt-8">
      <label htmlFor="password" className="text-[12.5px] font-medium text-ink-3">
        Password
      </label>
      <div className="relative mt-1.5 flex items-center rounded-[13px] border border-rule bg-raised transition-colors focus-within:border-rule-strong">
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-12 min-w-0 flex-1 bg-transparent px-4 text-[15px] text-ink outline-none"
        />
        <button
          type="submit"
          disabled={!password || busy}
          aria-label="Sign in"
          className="mr-1.5 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-ink px-3.5 text-[14px] font-medium text-bg transition-[opacity,transform] active:scale-[0.97] disabled:opacity-30"
        >
          <span className="hidden sm:inline">Sign in</span> <ArrowRight size={15} />
        </button>
      </div>
      {error && (
        <p className="mt-3 text-[13.5px] leading-snug text-rubric-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
