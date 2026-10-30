/**
 * Which paths answer without the owner's session. Everything else is closed.
 * Pure, so a test can walk it; proxy.ts is the only caller.
 *
 * Open: the login page and its endpoint, the health check, robots.txt, the
 * framework's static files, and /mcp, which a reader's agent reaches with its
 * own bearer token, checked in the handler.
 */
const OPEN = new Set(["/login", "/api/auth/login", "/api/health", "/robots.txt"]);

export const isOpenPath = (path: string) => OPEN.has(path) || path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/_next/static/");
