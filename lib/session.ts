"use client";

/**
 * The owner's session, from the browser's side. The cookie is HttpOnly, so
 * script never sees it; what script holds is the CSRF token the server hands
 * back from /api/auth/session. Importing this module wraps `fetch` once, so
 * every same-origin write to /api/ carries that token without each caller
 * remembering, and a 401 from the API sends the browser to the login page.
 */

export const CSRF_HEADER = "x-gloss-csrf";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

let csrf: string | null = null;
let loading: Promise<string | null> | null = null;
let native: typeof fetch | null = null;

/** Loads (once) the CSRF token of the live session; null when signed out. */
export function csrfToken(): Promise<string | null> {
  if (csrf) return Promise.resolve(csrf);
  loading ??= (native ?? fetch)("/api/auth/session", { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<{ csrf?: string }>) : null))
    .then((j) => (csrf = j?.csrf ?? null))
    .catch(() => null)
    .finally(() => {
      loading = null;
    });
  return loading;
}

export const forgetSession = () => {
  csrf = null;
};

const toLogin = () => {
  if (location.pathname === "/login") return;
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
};

function install() {
  if (typeof window === "undefined" || native) return;
  native = window.fetch.bind(window);
  const real = native;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const mine = url.origin === location.origin && url.pathname.startsWith("/api/") && url.pathname !== "/api/auth/login";
    if (!mine) return real(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let next = init;
    if (!SAFE.has(method)) {
      const token = await csrfToken();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (token) headers.set(CSRF_HEADER, token);
      next = { ...init, headers };
    }
    const res = await real(input, next);
    if (res.status === 401 && !url.pathname.startsWith("/api/auth/")) {
      const j = (await res
        .clone()
        .json()
        .catch(() => null)) as { code?: string } | null;
      if (j?.code === "signed_out") {
        forgetSession();
        toLogin();
      }
    }
    return res;
  };
}

install();
