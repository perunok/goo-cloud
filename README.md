# goo cloud

Sync and sharing for [goo](https://github.com/perunok/goo), the local-first Markdown editor: keep a folder of notes
in sync between your devices and share it with others (owner, admin, editor, viewer). Self-hosted, MIT licensed.
Modelled on [Slinger Cloud](https://github.com/perunok/slinger-admin).

![goo cloud dashboard: the Notes tab of a workspace, listing the synced notes with size, last change and who made it](docs/screenshots/02-notes.png)

## Features

- **Sync between devices.** Link a folder in goo (Settings > goo cloud) and its notes stay in sync on every computer.
  Notes keep their identity across renames; edits made on two devices are merged line by line; when both changed the
  same lines, both versions are kept as two notes instead of one being lost. Deletes reach every device.
- **Sharing.** Workspaces with **owner**, **admin**, **editor** and **viewer** roles (viewers only download). Add people
  by email; an email without an account becomes a pending invite that turns into a membership when the account exists.
- **Desktop sign-in without passwords in the app.** goo shows a short code, you approve it in the browser; the app
  keeps rotating tokens in the OS keychain. See and sign out your devices on the Account page.
- **Dashboard.** Workspaces, a read-only view of the synced notes (rendered safely), members and invites, audit log;
  for admins: users (temporary passwords, roles, disable), all workspaces, platform audit.
- **Self-hosted and small.** One Docker image (API + dashboard, amd64 and arm64), PostgreSQL, Caddy for HTTPS. No
  telemetry; your notes stay on your server.

| | |
|---|---|
| ![Workspaces](docs/screenshots/01-workspaces.png)<br>**Workspaces** you own or were added to | ![Members](docs/screenshots/03-members.png)<br>**Members** with roles, and pending invites |
| ![Desktop sign-in](docs/screenshots/04-approve-desktop-sign-in.png)<br>**Approve** the code goo shows to sign it in | ![Admin overview](docs/screenshots/05-admin-overview.png)<br>**Admin** overview: users, workspaces, notes, devices |

Screenshots come from the dashboard's mock mode: `(cd dashboard && npm run dev:mock -- --port 5299)` and
`node e2e/screenshots.mjs`.

## Run it

Use the published image ([releases](https://github.com/perunok/goo-cloud/releases)):

```bash
git clone https://github.com/perunok/goo-cloud && cd goo-cloud
cp .env.example .env    # set GOO_BASE_URL, POSTGRES_PASSWORD, GOO_SIGNING_SECRET, GOO_ADMIN_BOOTSTRAP (first admin)
                        # and GOO_IMAGE=ghcr.io/perunok/goo-cloud:0.1.0
docker compose up -d --no-build
```

Then sign in on the dashboard with the bootstrap account, create users and a workspace, and in
[goo](https://github.com/perunok/goo/releases/latest) open Settings > goo cloud, enter your server's address and
approve the code. HTTPS with Caddy, backups and upgrades: [`deploy-manual.md`](deploy-manual.md).

## Parts

| Part | |
| --- | --- |
| [`server/`](server/README.md) | Fastify 5 + Prisma + PostgreSQL 16 API: accounts, device sign-in, workspaces, members, notes sync. [`openapi.yaml`](server/openapi.yaml) is the API contract. |
| [`dashboard/`](dashboard/README.md) | Svelte 5 web UI served by the server at `/`: sign-in, workspaces, read-only notes, members and invites, devices, desktop sign-in approval; users, all workspaces and audit log for admins |
| [`e2e/`](e2e/) | Playwright tests driving the dashboard against the real server and a throwaway PostgreSQL |
| [`deploy/`](deploy/), [`docker-compose.yml`](docker-compose.yml) | One image (`goo-cloud`: API + dashboard), PostgreSQL, Caddy for TLS. Guide: [`deploy-manual.md`](deploy-manual.md) |
| [`docs/DESIGN.md`](docs/DESIGN.md) | How it works: data model, auth, the file-based sync protocol, lessons from Slinger Cloud |

The desktop side (sync engine and the Settings > goo cloud tab) lives in the goo app.

To build the image from source instead: `docker compose up -d --build`. Release tags publish the multi-arch image to
`ghcr.io/perunok/goo-cloud` (and Docker Hub when configured).

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
