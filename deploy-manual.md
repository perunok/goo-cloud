# Self-hosting goo cloud

The stack is `postgres` + `server` (the `goo-cloud` image: Node/TypeScript API that also serves the dashboard, see
`server/README.md`), behind a Caddy reverse proxy. Only the proxy publishes host ports (`GOO_HTTP_PORT` -> 80,
`GOO_HTTPS_PORT` -> 443); Postgres and the server are reachable only on the internal Compose network.

Requirements: Docker with the Compose plugin, about 512 MB of RAM, and a DNS name if you want HTTPS (recommended for anything
beyond a trial: passwords and notes travel over this connection).

## 1. Configure

```bash
git clone https://github.com/perunok/goo-cloud.git && cd goo-cloud   # or download docker-compose.yml, .env.example and deploy/
cp .env.example .env
```

Fill in the values marked REQUIRED. Compose refuses to start while they are empty (there are no default secrets):

| Variable | What |
|---|---|
| `POSTGRES_PASSWORD` | URL-safe characters only (it is embedded in `DATABASE_URL`): `openssl rand -hex 24` |
| `GOO_SIGNING_SECRET` | at least 32 characters, signs sessions and tokens: `openssl rand -hex 32`. Changing it signs everybody out. |
| `GOO_ADMIN_BOOTSTRAP` | the first admin account(s), see below |
| `GOO_BASE_URL` | the public URL, e.g. `https://cloud.example.com` (used for the desktop sign-in link `<base>/device`) |

Other settings (all optional) are listed in `.env.example`; the complete list of server variables with defaults is in
`server/README.md` ("Configuration"). Values that compose does not pass through can be added under `server.environment` in
`docker-compose.yml`, e.g. `GOO_LOG_LEVEL`, `GOO_SESSION_TTL` or `GOO_SYNC_BODY_LIMIT_BYTES`.

### The first admin (`GOO_ADMIN_BOOTSTRAP`)

There is no sign-up page: accounts are created by admins. The first one comes from `GOO_ADMIN_BOOTSTRAP`, a single-quoted
JSON array:

```env
GOO_ADMIN_BOOTSTRAP='[{"email":"you@example.com","password":"a-long-passphrase-of-several-words","display_name":"You","platform_role":"super_admin"}]'
```

- `platform_role` is `super_admin` (at most one; the only role that can create other admins, change roles and delete any
  workspace) or `platform_admin` (manages users and sees every workspace).
- Passwords must be at least 12 characters and not a placeholder; the server refuses to boot otherwise and says why (without
  echoing passwords).
- Missing accounts are created at boot; **existing accounts are never modified**. After the first start you can remove the
  password from `.env` (keep the variable set to `[]` or leave the entry: it is ignored once the account exists). Change the
  password on the dashboard's Account page.

Then sign in on the dashboard, create users on the Users page (a generated temporary password is shown once and must be
changed at first sign-in), create workspaces and add members by email. Someone added before they have an account joins
automatically when their account is created.

## 2. Choose HTTP or HTTPS

**HTTP (default, HTTPS is OFF).** `deploy/Caddyfile` serves plain HTTP on port 80. Keep `GOO_COOKIE_SECURE=false` (browsers do
not send `Secure` cookies over `http://`, so dashboard sign-in would silently fail otherwise) and `GOO_BASE_URL=http://<host>`.
Use this only on a trusted network or behind another TLS terminator.

**HTTPS (automatic Let's Encrypt).** Point a DNS record at the host, make ports 80 and 443 reachable, then in `.env`:

```env
GOO_CADDYFILE=./deploy/Caddyfile.https
GOO_DOMAIN=cloud.example.com
GOO_BASE_URL=https://cloud.example.com
GOO_COOKIE_SECURE=true
```

Caddy obtains and renews the certificate and redirects HTTP to HTTPS; with `GOO_COOKIE_SECURE=true` the server also sends
`Strict-Transport-Security`. Behind your own TLS terminator instead: keep `deploy/Caddyfile` (or drop the proxy service and
publish the server's port 8080 yourself), set `GOO_BASE_URL=https://...`, `GOO_COOKIE_SECURE=true`, and only set
`GOO_TRUST_PROXY=true` when the proxy in front is the only way to reach the server.

## 3. Start

```bash
docker compose up -d --build
docker compose ps        # server becomes healthy once migrations ran and /healthz can reach Postgres
docker compose logs -f server
```

The server applies database migrations on boot (`prisma migrate deploy`). Open `GOO_BASE_URL` and sign in with the bootstrap
account. In goo, open Settings > goo cloud, enter the same URL and sign in: goo shows a code, which you approve on the dashboard's
"Desktop sign-in" page (or on the `/device` page the app opens).

### Or use a published image (no local build)

Release tags publish a multi-arch image (linux/amd64 and linux/arm64) to `ghcr.io/perunok/goo-cloud` (and to Docker Hub as
`perunok/goo-cloud` when that is configured), tagged `X.Y.Z`, `X.Y` and `latest`:

```env
GOO_IMAGE=ghcr.io/perunok/goo-cloud:0.1
```

```bash
docker compose pull server
docker compose up -d --no-build
```

Pin `X.Y` (or `X.Y.Z`) rather than `latest` so an update only happens when you change the tag.

## What the server answers

Caddy passes every request to the server unchanged; it only adds HTTPS and compression.

| Path | What |
|---|---|
| `/v1/*` | API (the goo app) |
| `/api/v1/*` | the same API under the prefix the dashboard uses |
| `/device` | desktop sign-in page (code + email + password) |
| `/healthz` | database-checking health probe |
| `/`, `/assets/*`, other files of the build | dashboard (hash routes such as `/#/workspaces`) |

Anything else gets the API's JSON 404. To run the API without the dashboard, set `GOO_DASHBOARD_DIR=` (empty) on the server.
If you change the public port (`GOO_HTTP_PORT=8088`), include it in `GOO_BASE_URL` (`http://your-host:8088`) so the desktop
sign-in link is right.

## Backups

Everything lives in PostgreSQL (accounts, workspaces, members, the notes themselves, the audit log); Caddy's certificates are in
the `caddy-data` volume and can be re-issued. Back up the database regularly and keep `.env` (the signing secret) somewhere safe.

```bash
# dump (consistent while the server keeps running)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > goo-$(date +%F).dump

# restore into an empty stack
docker compose up -d postgres
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < goo-2026-10-10.dump
docker compose up -d
```

Notes are also on every device that syncs them, but a device only has the workspaces it linked; the database is the complete
copy. Note contents are stored as plain text: use disk or volume encryption on the host if that matters to you.

## Upgrading

```bash
git pull && docker compose up -d --build                         # building locally
docker compose pull server && docker compose up -d --no-build    # published image (bump GOO_IMAGE in .env first)
```

Migrations run automatically on boot; take a backup first. Read the release notes before jumping several minor versions.
Sessions and devices stay signed in across upgrades (unless `GOO_SIGNING_SECRET` changes).

## Operations

- Logs: `docker compose logs -f server` (structured JSON; authorization headers, cookies and secrets are never logged).
- Health: `/healthz` for probes; platform admins see database health and counters on the dashboard's Overview page.
- More than one server instance: set `GOO_RATE_LIMIT_STORE=postgres` so the login and sync rate limits are shared.
- Forgotten password: there is no email delivery; a platform admin resets it on the Users page (a temporary password is shown
  once; only the super admin can reset another admin). Nobody can reset the super admin's password through the API, so keep it
  in a password manager.
- Lost device: the owner signs it out under Account > Devices; it stops syncing when its current access token expires
  (within an hour).
