import { NextResponse, type NextRequest } from "next/server";
import { cookieName, readCookie, sessionFor } from "@/lib/server/auth";
import { isOpenPath } from "@/lib/server/gate";

/**
 * The first gate, and it fails closed: every path needs the owner's session
 * unless lib/server/gate.ts lists it. Route handlers check again
 * (lib/server/guard.ts), so a mistake in this file does not open the API.
 */

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (isOpenPath(path)) return NextResponse.next();

  if (sessionFor(readCookie(req.headers.get("cookie"), cookieName()))) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  }

  if (path.startsWith("/api/")) return Response.json({ error: "Sign in first.", code: "signed_out" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  // The login page is served in place of the page asked for, at the same address. A redirect would need an
  // absolute Location, and behind a TLS-terminating proxy this request's own origin is not to be trusted.
  // After signing in, the form goes on to the address it was served at.
  const res = NextResponse.rewrite(new URL("/login", req.url), { status: 401 });
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

// No exclusions beyond the framework's own static files: public/ images are the app's art, but they sit behind the login too.
export const config = { matcher: ["/((?!_next/static).*)"] };
