export const runtime = "nodejs";

/** For the platform's health check. Says nothing about the data. */
export function GET() {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
