/**
 * Every private route calls this first, whatever the proxy did: the proxy is
 * a first gate, not the only one. Returns the owner, or the response to send.
 * Server-side only.
 */

import { OWNER_ID, cookieName, csrfOk, CSRF_HEADER, readCookie, sameSite, sessionFor, type Session } from "./auth";

export type Guard = { ok: true; userId: string; session: Session } | { ok: false; res: Response };

const noStore = { "Cache-Control": "private, no-store" };
const deny = (status: number, error: string, code: string) => Response.json({ error, code }, { status, headers: noStore });

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** The cookie value on a request, under whichever name this server issues. */
export const tokenOf = (req: Request) => readCookie(req.headers.get("cookie"), cookieName());

export function owner(req: Request): Guard {
  const session = sessionFor(tokenOf(req));
  if (!session) return { ok: false, res: deny(401, "Sign in first.", "signed_out") };
  if (!SAFE.has(req.method)) {
    if (!sameSite(req)) return { ok: false, res: deny(403, "Cross-site request refused.", "cross_site") };
    if (!csrfOk(req.headers.get(CSRF_HEADER), session)) return { ok: false, res: deny(403, "Missing or wrong CSRF token. Reload the page.", "csrf") };
  }
  return { ok: true, userId: OWNER_ID, session };
}
