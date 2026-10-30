# Gloss, self-hosted

A private, single-owner fork of [Nutlope/gloss](https://github.com/Nutlope/gloss), the open source AI reader for articles and PDFs: select any line, ask a question, and get a cited answer in the margin. This fork runs as one Node process with one SQLite file, with no account service, hosted database or analytics, and it adds a Goodreads catalogue on the bookshelf.

- Sign-in is a single owner password (scrypt hash, HttpOnly cookie, CSRF token, expiry and revoke, login throttle). Every route except the login page and a health check is closed.
- Your shelves, highlights, notes and progress sync between your browsers through the server's SQLite file.
- Questions and gloss summaries use Cloudflare Workers AI when configured, and are off (visibly) when not.
- Goodreads CSV exports import as catalogue entries on the shelves: metadata only, idempotent, no book text.

Setup, settings and what is and isn't included: [docs/SELF_HOST.md](docs/SELF_HOST.md).

```sh
npm ci
npm run test      # unit tests: auth, sync, catalogue importer, AI adapter (mocked HTTP)
npm run lint      # tsc --noEmit
npm run build
```

Built on Next.js (app router, Tailwind), [LiteParse](https://github.com/run-llama/liteparse) for in-browser PDF parsing, and Node's built-in `node:sqlite`.
