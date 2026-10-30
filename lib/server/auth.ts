/**
 * The single owner's login. No third party, no account service.
 *
 * - The password is checked against a scrypt hash from the environment
 *   (GLOSS_OWNER_PASSWORD_HASH, made with `npm run auth:hash`). No hash, no
 *   login: every gated route stays closed. There is no default password and
 *   no first-visitor setup.
 * - A login makes a random session token. The cookie holds the token; the
 *   database holds only its sha256, an expiry, and a per-session CSRF token.
 * - A session ends by expiry (idle or absolute), by logout, by "sign out
 *   everywhere", or by changing the password hash (sessions remember a
 *   fingerprint of the hash they were made under).
 * - Failed logins are throttled across the whole instance, not per address:
 *   the address headers behind a proxy can be forged, so they are not trusted.
 *
 * Server-side only.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { OWNER_ID } from "../db";
import { nowIso, sqlite, stmt } from "./sqlite";

export { OWNER_ID };
export const SESSION_IDLE_MS = 7 * 86_400_000;
export const SESSION_MAX_MS = 30 * 86_400_000;
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILURES = 5;
export const MIN_PASSWORD_CHARS = 12;

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 32 } as const;

/* ---------- password hashing ---------- */

type Params = { N: number; r: number; p: number };

const scryptAsync = (pw: string, salt: Buffer, keylen: number, o: Params) =>
  new Promise<Buffer>((res, rej) => scrypt(pw.normalize("NFKC"), salt, keylen, { N: o.N, r: o.r, p: o.p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

/** `scrypt$N$r$p$salt$hash`, base64url parts. */
export async function hashPassword(password: string, params: Partial<Params> = {}): Promise<string> {
  const o = { N: params.N ?? SCRYPT.N, r: params.r ?? SCRYPT.r, p: params.p ?? SCRYPT.p };
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, o);
  return ["scrypt", o.N, o.r, o.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const o = { N: Number(N), r: Number(r), p: Number(p) };
  // Refuse parameters that would be a way to burn the server's memory.
  if (!Number.isInteger(o.N) || o.N < 2 ** 10 || o.N > 2 ** 18 || (o.N & (o.N - 1)) !== 0 || !(o.r >= 1 && o.r <= 16) || !(o.p >= 1 && o.p <= 4)) return false;
  const want = Buffer.from(key, "base64url");
  if (want.length < 16 || want.length > 64) return false;
  try {
    const got = await scryptAsync(password, Buffer.from(salt, "base64url"), want.length, o);
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

const configuredHash = () => process.env.GLOSS_OWNER_PASSWORD_HASH?.trim() || "";
export const loginConfigured = () => configuredHash().startsWith("scrypt$");
const fingerprint = (hash: string) => createHash("sha256").update(`gloss-pw:${hash}`).digest("hex").slice(0, 32);

/* ---------- login throttle ---------- */

/** Seconds until another attempt is allowed, or 0. Spends nothing. */
export function loginLockedFor(now = Date.now()): number {
  const db = sqlite();
  stmt(db, "delete from login_failures where at < ?").run(now - LOGIN_WINDOW_MS);
  const rows = stmt(db, "select at from login_failures order by at desc limit ?").all(LOGIN_MAX_FAILURES) as { at: number }[];
  if (rows.length < LOGIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((rows[LOGIN_MAX_FAILURES - 1].at + LOGIN_WINDOW_MS - now) / 1000));
}

const recordFailure = (now = Date.now()) => void stmt(sqlite(), "insert into login_failures (at) values (?)").run(now);
const clearFailures = () => void sqlite().exec("delete from login_failures");

/* ---------- sessions ---------- */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type Session = { id: string; csrf: string; expiresAt: string };

export function createSession(now = Date.now()): { token: string; session: Session } {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const expiresAt = new Date(now + SESSION_IDLE_MS).toISOString();
  stmt(sqlite(), "insert into sessions (id, csrf, pw_fp, created_at, expires_at, last_seen_at) values (?, ?, ?, ?, ?, ?)").run(
    sha(token),
    csrf,
    fingerprint(configuredHash()),
    new Date(now).toISOString(),
    expiresAt,
    new Date(now).toISOString()
  );
  return { token, session: { id: sha(token), csrf, expiresAt } };
}

/** The live session behind a cookie value, sliding its idle expiry. Null when absent, expired, revoked, or the password changed. */
export function sessionFor(token: string | null | undefined, now = Date.now()): Session | null {
  if (!token || token.length < 20 || token.length > 100 || !loginConfigured()) return null;
  const db = sqlite();
  const r = stmt(db, "select id, csrf, pw_fp, created_at, expires_at, revoked_at from sessions where id = ?").get(sha(token)) as
    | { id: string; csrf: string; pw_fp: string; created_at: string; expires_at: string; revoked_at: string | null }
    | undefined;
  if (!r || r.revoked_at) return null;
  if (r.pw_fp !== fingerprint(configuredHash())) return null;
  if (Date.parse(r.expires_at) <= now || Date.parse(r.created_at) + SESSION_MAX_MS <= now) return null;
  // Slide the idle window at most once a minute, never past the absolute cap.
  const expiresAt = new Date(Math.min(now + SESSION_IDLE_MS, Date.parse(r.created_at) + SESSION_MAX_MS)).toISOString();
  if (Date.parse(expiresAt) - Date.parse(r.expires_at) > 60_000) stmt(db, "update sessions set expires_at = ?, last_seen_at = ? where id = ?").run(expiresAt, new Date(now).toISOString(), r.id);
  return { id: r.id, csrf: r.csrf, expiresAt };
}

export function revokeSession(token: string | null | undefined): void {
  if (token) stmt(sqlite(), "update sessions set revoked_at = ? where id = ? and revoked_at is null").run(nowIso(), sha(token));
}

/** Sign out everywhere. Returns how many sessions were live. */
export function revokeAllSessions(): number {
  return Number(stmt(sqlite(), "update sessions set revoked_at = ? where revoked_at is null").run(nowIso()).changes);
}

/** Drop sessions that have been dead for a day, so the table stays small. */
export function pruneSessions(now = Date.now()): void {
  stmt(sqlite(), "delete from sessions where expires_at < ? or revoked_at < ?").run(new Date(now - 86_400_000).toISOString(), new Date(now - 86_400_000).toISOString());
}

export type LoginResult =
  | { ok: true; token: string; session: Session }
  | { ok: false; status: 400 | 401 | 429 | 503; error: string; retryAfter?: number };

export async function login(password: unknown, now = Date.now()): Promise<LoginResult> {
  if (!loginConfigured()) return { ok: false, status: 503, error: "Login is not set up on this server." };
  const wait = loginLockedFor(now);
  if (wait) return { ok: false, status: 429, error: "Too many attempts. Try again later.", retryAfter: wait };
  if (typeof password !== "string" || !password || password.length > 512) return { ok: false, status: 400, error: "Enter the password." };
  if (!(await verifyPassword(password, configuredHash()))) {
    recordFailure(now);
    return { ok: false, status: 401, error: "That is not the password." };
  }
  clearFailures();
  pruneSessions(now);
  return { ok: true, ...createSession(now) };
}

/* ---------- cookies and CSRF ---------- */

/** `__Host-` ties the cookie to this exact origin and needs Secure; plain http (local smoke) uses the bare name. */
export const cookieSecure = () => process.env.GLOSS_COOKIE_SECURE !== "false";
export const cookieName = () => (cookieSecure() ? "__Host-gloss_session" : "gloss_session");
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSec = SESSION_IDLE_MS / 1000): string {
  return `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSec)}${cookieSecure() ? "; Secure" : ""}`;
}
export const clearedCookie = () => `${cookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure() ? "; Secure" : ""}`;

export const CSRF_HEADER = "x-gloss-csrf";

export function csrfOk(given: string | null | undefined, session: Session): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(session.csrf);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The origin browsers see, from GLOSS_PUBLIC_URL. `undefined` when unset;
 * `null` when set but not a usable http(s) URL, which refuses every request.
 */
function publicOrigin(): string | null | undefined {
  const raw = process.env.GLOSS_PUBLIC_URL?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * A browser request that comes from another site is refused. `Origin`, when
 * present, must be this site; `Sec-Fetch-Site: cross-site` is refused.
 * Requests from tools (no Origin, no Sec-Fetch-Site) pass this check and
 * still need the session and CSRF token.
 *
 * "This site" is the exact origin (scheme, host, port) of GLOSS_PUBLIC_URL
 * when it is set: behind Tailscale Serve the Host header is `localhost`, and
 * forwarded headers are client-controlled, so neither is trusted. A set but
 * invalid GLOSS_PUBLIC_URL refuses everything. When unset, `Origin` must match
 * the request's Host (local and dev runs).
 */
export function sameSite(req: Request): boolean {
  const pub = publicOrigin();
  if (pub === null) return false;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    try {
      const u = new URL(origin);
      if (pub !== undefined) return u.origin === pub && u.href === `${u.origin}/`;
      const host = req.headers.get("host");
      if (!host || u.host !== host) return false;
    } catch {
      return false;
    }
  } else if (origin === "null") return false;
  return true;
}
