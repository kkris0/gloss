# Self-hosting Gloss (single owner)

Gloss is a single-owner app with one SQLite file. There is no account service, no hosted database and no analytics. One owner signs in with a password; everything except the login page and a health check is closed.

## Settings

All are runtime environment variables. None belong in Git.

| Variable | Needed | What it is |
| --- | --- | --- |
| `GLOSS_OWNER_PASSWORD_HASH` | yes | scrypt hash from `npm run auth:hash`. With none set, nobody can sign in. Single-quote it in a shell: it contains `$`. Changing it signs every session out. |
| `GLOSS_DB_PATH` | no | SQLite file. Default `./data/gloss.sqlite`; on Fly `/data/gloss.sqlite`. |
| `GLOSS_COOKIE_SECURE` | no | Set `false` only for plain-http local runs. Otherwise the cookie is `__Host-` prefixed and `Secure`, which needs HTTPS (Tailscale Serve provides it). |
| `GLOSS_PUBLIC_URL` | no | This instance's address, used in the links an agent is told. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `GLOSS_AI_MODEL` | no | Cloudflare Workers AI, over its OpenAI-compatible endpoint. All three or AI is off. The token is read on the server only. |

## Run locally

```sh
npm ci
HASH=$(npm run --silent auth:hash)          # prompts; prints the hash
GLOSS_OWNER_PASSWORD_HASH="$HASH" GLOSS_COOKIE_SECURE=false npm run dev
```

## Goodreads catalogue

Library → **Goodreads** → *Import a Goodreads CSV*. The importer reads the 31-column export, keeps each row whole on the server, and shows titles, authors, shelves, ratings, status and dates on the library's shelves. It is idempotent (a book is keyed by its Goodreads Book ID), bounded (8 MB, 20,000 rows), and inert: cells are stored and shown as plain text; no formula, link or image in the file is followed. Reviews, notes and comments stay in the database and are never sent to the browser. It brings in no book text, and "currently reading" is what the export said that day, not a live position.

## What AI covers

Questions in the margin and the gloss summary, through Workers AI. Not part of this deployment, and shown as unavailable: reading aloud, painted covers, scanned-PDF page reading, "read it more carefully", and web search.

## Fly + Tailscale architecture (private pilot deployed)

`deploy/` describes one always-on Fly Machine in `fra`, with 1 GB RAM and one Fly Volume mounted at `/data`. SQLite is `/data/gloss.sqlite`, and Tailscale keeps its node identity under `/data/tailscale`.

There is no TCP origin. A custom Next server listens only on `/run/gloss/origin.sock`; `tailscale serve --https=443` proxies that Unix socket to tailnet HTTPS. This matters because a TCP listener on loopback is not an origin-isolation boundary when tailscaled uses userspace networking. The runtime reads `tailscale serve status --json` after applying Serve and exits unless that structured state is readable and every `AllowFunnel` value is false, including configs nested under `Foreground`.

The Node supervisor is PID 1 and owns both tailscaled and Next. TERM is forwarded for a graceful stop, and either child exiting makes the container exit so Fly can restart it. The owner-password login remains an independent application gate in front of the catalogue even for authenticated tailnet peers.

The Fly config deliberately contains no `[http_service]`, `[[services]]`, public ports or public-IP allocation. Do not add a public Fly service, allocate a Fly IPv4/IPv6 address, or enable Tailscale Funnel. HTTPS exists only through Tailscale Serve on the tailnet.

## Provisioned infrastructure and human secret gate

After explicit approval on 2026-10-30, `gloss-yorha` was created in the Fly `personal` org without any public IP. One encrypted 2 GB volume, `gloss_data` (`vol_r68608dq65xnw7d4`), was created in `fra` with 14-day scheduled snapshots and attached to one running `shared-cpu-1x`/1 GB Machine. The one-machine pilot is about $8.03 per 30 days before Cloudflare AI usage, outbound traffic and any additional snapshot charges. The human owner staged the required two bootstrap secrets before deployment:

1. `GLOSS_OWNER_PASSWORD_HASH` was generated privately with `npm run auth:hash`. The container refuses to start without it; the operator has not read the password or hash.
2. `TS_AUTHKEY` was staged privately for Tailscale bootstrap. The Machine restarted successfully and retained its tailnet name and state file. The bootstrap secret remains staged pending explicit approval to remove it.
3. The tailnet access policy has **not** been reviewed; a narrow grant allowing the intended owner to `tag:gloss` on `tcp:443` does **not** override an existing broad/wildcard grant. The owner should inspect the effective policy before relying on owner-only tailnet isolation. The application password remains a second gate.
4. Optionally store all three Cloudflare AI variables listed above; partial AI configuration leaves inference disabled. A live Workers AI call is a separate acceptance step.

Never put a password, password hash, auth key, API token, Goodreads export or other credential in Git, an image layer, a command transcript or this file.

## Local validation (does not prove live isolation)

From the repository root, these checks validate source, the Fly file and the local image without creating or changing any Fly or Tailscale resource:

```sh
npm test
npm run lint
npm run build
flyctl config validate -c deploy/fly.toml
sudo -n docker build -f deploy/Dockerfile -t gloss-selfhost:local .
```

An image smoke test should override the entrypoint so it does not join a tailnet. Start only the custom server with a synthetic test password hash, mount a temporary `/run/gloss`, request `/api/health` and the unauthenticated `/api/catalog` through the Unix socket, and inspect the container network namespace to confirm there is no TCP origin listener. This is a local implementation check; it does not prove tailnet policy, Fly IP allocation, DNS or outside-tailnet reachability.

Local verification on 2026-10-30: 87 tests passed; TypeScript, Next production build, Fly config validation and the ARM64 Docker build passed. A network-disabled container answered health (200) and the home page (200), rejected the unauthenticated catalogue (401), exposed the Unix socket and had no TCP listener. A second container test used only a synthetic password and CSV: login and import succeeded, and five catalogue records remained after container recreation on the same temporary volume. Simulated HTTPS proxy headers produced a Secure `__Host-` cookie; a write without CSRF failed (403) while the CSRF-correct synthetic import succeeded. None of this proves Fly/Tailscale runtime isolation or Cloudflare inference.

## Live acceptance (human, after deployment)

Do not call the deployment accepted until a human verifies all of the following against the real accounts:

Verified from Fly and an authorized tailnet peer on 2026-10-30: exactly one running Machine in `fra` with the attached volume, 1 GB RAM and `restart = always`; zero public Fly IPs; Serve points to the Unix socket without Funnel; valid tailnet HTTPS returns health 200 and rejects the unauthenticated catalogue with 401; former TCP origin ports refuse connections. After a Machine restart, the same tailnet hostname and HTTPS health endpoint remained available, and the Tailscale state file persisted. Not yet verified: the owner's password login through the live browser, SQLite catalogue persistence with an app-level import, outside-tailnet and unauthorized-peer denial, tailnet ACL/grant policy, an off-Fly backup/restore drill, or removal of the one-time bootstrap key.

- Fly reports exactly one running Machine in `fra`, 1 GB RAM, and the expected `gloss_data` volume mounted at `/data`.
- `fly ips list` reports no public IPv4 or IPv6 addresses, and the effective Fly config reports no public service or ports.
- The tailnet URL answers over HTTPS from an authorized tailnet peer, while the raw origin socket has no TCP equivalent (in particular, nothing listens on the former port 3100).
- `tailscale serve status --json` on the Machine targets `unix:/run/gloss/origin.sock` and has no enabled `AllowFunnel`, including any `Foreground` state.
- The same URL has no public route from a device outside the tailnet, and Tailscale Funnel is disabled.
- `/api/health` is reachable as intended, `/api/catalog` is rejected before login, and the owner can sign in with the separately provisioned password.
- Restarting the Machine preserves both the Tailscale identity and SQLite data on `/data`, and killing either tailscaled or Next causes Fly to restart the container.

The approved app, volume and Machine were provisioned separately through Fly CLI; these repository files do not create a secret, public IP, gateway or tailnet setting on their own. Local tests cannot replace the remaining live checks.
