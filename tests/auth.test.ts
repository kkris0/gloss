import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cookieName, createSession, hashPassword, login, loginLockedFor, readCookie, revokeAllSessions, revokeSession, sessionCookie, sessionFor, SESSION_IDLE_MS, SESSION_MAX_MS, verifyPassword } from "../lib/server/auth";
import { isOpenPath } from "../lib/server/gate";
import { owner } from "../lib/server/guard";
import { sqlite } from "../lib/server/sqlite";
import { FAST, tempDb } from "./helpers";

const PASSWORD = "correct horse battery staple";
let db: ReturnType<typeof tempDb>;
let hash: string;

beforeEach(async () => {
  db = tempDb();
  hash = await hashPassword(PASSWORD, FAST);
  process.env.GLOSS_OWNER_PASSWORD_HASH = hash;
  process.env.GLOSS_COOKIE_SECURE = "false";
});
afterEach(() => {
  delete process.env.GLOSS_OWNER_PASSWORD_HASH;
  delete process.env.GLOSS_COOKIE_SECURE;
  db.cleanup();
});

const req = (method: string, token: string | null, headers: Record<string, string> = {}) =>
  new Request("http://gloss.test/api/sync", { method, headers: { host: "gloss.test", ...(token ? { cookie: `${cookieName()}=${token}` } : {}), ...headers } });

describe("password hashing", () => {
  it("verifies the right password and refuses others", async () => {
    assert.ok(await verifyPassword(PASSWORD, hash));
    assert.ok(!(await verifyPassword("wrong", hash)));
    assert.ok(!(await verifyPassword(PASSWORD, "plaintext")));
    assert.ok(!(await verifyPassword(PASSWORD, "scrypt$1$1$1$AAAA$BBBB")));
  });
  it("salts: the same password hashes differently", async () => {
    assert.notEqual(await hashPassword(PASSWORD, FAST), hash);
  });
  it("refuses a hash whose cost would exhaust memory", async () => {
    const [, , r, p, salt, key] = hash.split("$");
    assert.ok(!(await verifyPassword(PASSWORD, ["scrypt", 2 ** 24, r, p, salt, key].join("$"))));
  });
});

describe("login", () => {
  it("is closed when no hash is configured", async () => {
    delete process.env.GLOSS_OWNER_PASSWORD_HASH;
    const r = await login(PASSWORD);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 503);
    // and an existing session row means nothing without a configured login
    process.env.GLOSS_OWNER_PASSWORD_HASH = hash;
    const { token } = createSession();
    delete process.env.GLOSS_OWNER_PASSWORD_HASH;
    assert.equal(sessionFor(token), null);
  });
  it("rejects a wrong password, a missing one, and an oversized one", async () => {
    assert.equal((await login("nope")).ok, false);
    const none = await login(undefined);
    assert.equal(!none.ok && none.status, 400);
    const big = await login("x".repeat(600));
    assert.equal(!big.ok && big.status, 400);
  });
  it("throttles after five failures across the instance, and a success clears it", async () => {
    for (let i = 0; i < 5; i++) await login("nope");
    const locked = await login(PASSWORD);
    assert.equal(!locked.ok && locked.status, 429);
    assert.ok(loginLockedFor() > 0);
    // the window passes
    assert.equal(loginLockedFor(Date.now() + 16 * 60_000), 0);
    const later = await login(PASSWORD, Date.now() + 16 * 60_000);
    assert.ok(later.ok);
    assert.equal(loginLockedFor(), 0);
  });
  it("stores only a hash of the cookie value", async () => {
    const r = await login(PASSWORD);
    assert.ok(r.ok);
    const rows = sqlite().prepare("select id, csrf from sessions").all() as { id: string; csrf: string }[];
    assert.equal(rows.length, 1);
    assert.ok(r.ok && rows[0].id !== r.token && !JSON.stringify(rows).includes(r.token));
  });
});

describe("sessions", () => {
  it("accepts a live session and refuses absent, malformed and unknown tokens", () => {
    const { token } = createSession();
    assert.ok(sessionFor(token));
    assert.equal(sessionFor(null), null);
    assert.equal(sessionFor(""), null);
    assert.equal(sessionFor("short"), null);
    assert.equal(sessionFor("x".repeat(43)), null);
    assert.equal(sessionFor("x".repeat(500)), null);
  });
  it("expires when idle and at the absolute cap, even if it keeps being used", () => {
    const t0 = Date.now();
    const { token } = createSession(t0);
    assert.ok(sessionFor(token, t0 + SESSION_IDLE_MS - 1000));
    const { token: idle } = createSession(t0);
    assert.equal(sessionFor(idle, t0 + SESSION_IDLE_MS + 1000), null);
    // slide it daily until the absolute cap
    const { token: t2 } = createSession(t0);
    for (let day = 1; day < 30; day++) assert.ok(sessionFor(t2, t0 + day * 86_400_000));
    assert.equal(sessionFor(t2, t0 + SESSION_MAX_MS + 1000), null);
  });
  it("is ended by logout (revoked in the database) and by sign-out-everywhere", () => {
    const a = createSession().token;
    const b = createSession().token;
    revokeSession(a);
    assert.equal(sessionFor(a), null);
    assert.ok(sessionFor(b));
    assert.equal(revokeAllSessions(), 1);
    assert.equal(sessionFor(b), null);
  });
  it("dies when the password hash changes", async () => {
    const { token } = createSession();
    assert.ok(sessionFor(token));
    process.env.GLOSS_OWNER_PASSWORD_HASH = await hashPassword("another long password", FAST);
    assert.equal(sessionFor(token), null);
  });
  it("sets an HttpOnly SameSite cookie, Secure with the __Host- prefix by default", () => {
    assert.match(sessionCookie("tok"), /^gloss_session=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    delete process.env.GLOSS_COOKIE_SECURE;
    assert.match(sessionCookie("tok"), /^__Host-gloss_session=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    assert.equal(readCookie("a=1; __Host-gloss_session=abc; b=2", "__Host-gloss_session"), "abc");
    assert.equal(readCookie(null, "x"), null);
  });
});

describe("route guard", () => {
  it("answers 401 with no cookie and with a bad cookie, for reads and writes", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const token of [null, "z".repeat(43)]) {
        const g = owner(req(method, token));
        assert.ok(!g.ok);
        assert.equal(!g.ok && g.res.status, 401);
        assert.equal(!g.ok && g.res.headers.get("cache-control"), "private, no-store");
      }
    }
  });
  it("lets a signed-in read through without CSRF, but demands it on writes", () => {
    const { token, session } = createSession();
    assert.ok(owner(req("GET", token)).ok);
    const missing = owner(req("POST", token));
    assert.equal(!missing.ok && missing.res.status, 403);
    const wrong = owner(req("POST", token, { "x-gloss-csrf": "nope" }));
    assert.equal(!wrong.ok && wrong.res.status, 403);
    assert.ok(owner(req("POST", token, { "x-gloss-csrf": session.csrf })).ok);
    assert.ok(owner(req("DELETE", token, { "x-gloss-csrf": session.csrf })).ok);
  });
  it("refuses a CSRF token from another session", () => {
    const a = createSession();
    const b = createSession();
    const g = owner(req("POST", a.token, { "x-gloss-csrf": b.session.csrf }));
    assert.equal(!g.ok && g.res.status, 403);
  });
  it("refuses cross-site browser requests even with a valid token", () => {
    const { token, session } = createSession();
    const h = { "x-gloss-csrf": session.csrf };
    for (const extra of <Record<string, string>[]>[{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example" }, { origin: "null" }]) {
      const g = owner(req("POST", token, { ...h, ...extra }));
      assert.equal(!g.ok && g.res.status, 403, JSON.stringify(extra));
    }
    assert.ok(owner(req("POST", token, { ...h, "sec-fetch-site": "same-origin", origin: "http://gloss.test" })).ok);
  });
  it("is not fooled by forwarded-for or tailnet identity headers", () => {
    const g = owner(req("GET", null, { "x-forwarded-for": "127.0.0.1", "tailscale-user-login": "owner@example.com", "x-real-ip": "100.64.0.1" }));
    assert.ok(!g.ok);
  });
  it("is rejected after logout", () => {
    const { token } = createSession();
    assert.ok(owner(req("GET", token)).ok);
    revokeSession(token);
    assert.ok(!owner(req("GET", token)).ok);
  });
});

describe("proxy gate", () => {
  it("opens only the login, health, robots, static assets and the token-checked /mcp", () => {
    for (const p of ["/login", "/api/auth/login", "/api/health", "/robots.txt", "/_next/static/chunks/a.js", "/mcp", "/mcp/gls_abc"]) assert.ok(isOpenPath(p), p);
  });
  it("closes everything else, including lookalikes", () => {
    for (const p of ["/", "/library", "/read/x", "/api/sync", "/api/auth/session", "/api/auth/logout", "/api/auth/revoke-all", "/api/agent-tokens", "/login/", "/loginx", "/mcpx", "/api/health/x", "/_next/image", "/_next/data/x.json", "/icon.svg", "/liteparse-2.15.1.wasm", "/library/x.png"])
      assert.ok(!isOpenPath(p), p);
  });
});

describe("no third-party identity", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      if (["node_modules", ".next", ".git", ".test-build", "tests", "data"].includes(f)) return [];
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(f) ? [p] : [];
    });
  it("imports neither Clerk nor Neon anywhere, and drops them from package.json", () => {
    const root = process.cwd();
    for (const f of walk(root)) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/@clerk|@neondatabase|plausible\.io|api\.together\.xyz|usegloss\.io/.test(src), f);
    }
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["@clerk/nextjs"], undefined);
    assert.equal(pkg.dependencies["@neondatabase/serverless"], undefined);
  });
});
