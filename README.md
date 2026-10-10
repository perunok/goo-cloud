# goo cloud

Sync and sharing for [goo](https://github.com/perunok/goo), the local-first Markdown editor: keep a folder of notes
in sync between your devices and share it with others (owner, admin, editor, viewer). Self-hosted, MIT licensed.
Modelled on [Slinger Cloud](https://github.com/perunok/slinger-admin).

| Part | |
| --- | --- |
| [`server/`](server/README.md) | Fastify 5 + Prisma + PostgreSQL 16 API: accounts, device sign-in, workspaces, members, notes sync. [`openapi.yaml`](server/openapi.yaml) is the API contract. |
| [`dashboard/`](dashboard/README.md) | Svelte 5 web UI served by the server at `/`: sign-in, workspaces, read-only notes, members and invites, devices, desktop sign-in approval; users, all workspaces and audit log for admins |
| [`e2e/`](e2e/) | Playwright tests driving the dashboard against the real server and a throwaway PostgreSQL |
| [`deploy/`](deploy/), [`docker-compose.yml`](docker-compose.yml) | One image (`goo-cloud`: API + dashboard), PostgreSQL, Caddy for TLS. Guide: [`deploy-manual.md`](deploy-manual.md) |
| [`docs/DESIGN.md`](docs/DESIGN.md) | How it works: data model, auth, the file-based sync protocol, lessons from Slinger Cloud |

The desktop side (sync engine and the Settings > goo cloud tab) lives in the goo app.

## Quick start (Docker Compose)

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, GOO_SIGNING_SECRET and GOO_ADMIN_BOOTSTRAP (the first admin)
docker compose up -d --build
```

Open <http://localhost> and sign in with the bootstrap account. HTTPS, backups and upgrades: [`deploy-manual.md`](deploy-manual.md).
Release tags publish a multi-arch image to `ghcr.io/perunok/goo-cloud` (and Docker Hub when configured); set
`GOO_IMAGE` in `.env` and use `docker compose up -d --no-build` to run it instead of building.

## Development

Node 22+ and Docker (for throwaway PostgreSQL containers). npm everywhere.

```bash
npm run setup          # npm ci in server/, dashboard/, e2e/ + Playwright's Chromium
npm run typecheck      # all three packages
npm test               # server tests (need a database, see below) + dashboard tests
npm run test:dashboard # dashboard unit/component tests only (no database)
npm run e2e            # throwaway postgres + real server serving the built dashboard + Playwright
```

- **Server** (`cd server`): `npm run dev` with a database and env vars from [`server/README.md`](server/README.md); `npm test`
  needs `TEST_DATABASE_URL` (default `postgresql://postgres:test@127.0.0.1:55433/goo_test`):

  ```bash
  docker run -d --rm --name goo-cloud-test-pg -p 127.0.0.1:55433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=goo_test \
    --tmpfs /var/lib/postgresql/data postgres:16-alpine
  ```

  (If Docker's port publishing does not work on your machine, use `--network host` and append
  `-c port=55433 -c listen_addresses=127.0.0.1` instead of `-p`.) `npm run openapi` regenerates `openapi.yaml` after route
  changes (a test fails when it is stale).
- **Dashboard** (`cd dashboard`): `npm run dev` (Vite on :5173, proxies `/api` to the server on :8080) or `npm run dev:mock`
  (in-memory fake API, no server needed; demo accounts in [`dashboard/README.md`](dashboard/README.md)).
- **e2e**: `npm run e2e` starts PostgreSQL in Docker (host network on Linux; `E2E_PG_PUBLISH=1` publishes a port instead) or
  uses `E2E_DATABASE_URL`; extra arguments go to Playwright (`npm run e2e -- -g notes`).
- **Docker image**: `docker build -f server/Dockerfile -t goo-cloud .` from the repository root.

CI (`.github/workflows/ci.yml`) runs the typecheck, server tests against a PostgreSQL service container, dashboard tests and
build, the e2e suite and a build plus smoke test of the Docker image on every push. `publish.yml` pushes the image on `v*` tags.
