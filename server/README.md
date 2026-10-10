# goo cloud server

Node.js 22 / TypeScript implementation of the goo cloud API (Fastify 5 + Prisma 6/PostgreSQL 16 + zod 3). goo cloud keeps
goo's Markdown note folders in sync between devices and lets people share a folder. It implements
[`../docs/DESIGN.md`](../docs/DESIGN.md) (sections 2-4, 6, 7) and is ported from the Slinger Cloud server: same stack, auth,
authorization, admin API and deploy shape; the content model and sync protocol are new and built around files.

- **Machine-readable API:** [`openapi.yaml`](openapi.yaml) (OpenAPI 3.0, generated from the zod schemas of the routes that are
  actually registered; a test fails if it drifts). Regenerate with `npm run openapi`.
- **Not in v1:** editing notes in the browser (the dashboard reads them), attachments/images, real-time collaboration, end-to-end
  encryption, OAuth/SAML, email delivery.

## Quick start (development)

Prerequisites: Node >= 22, Docker (for a throwaway PostgreSQL).

```bash
cd server
docker run -d --rm --name goo-dev-pg -p 127.0.0.1:55433:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=goo postgres:16-alpine

export DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55433/goo
export GOO_ADMIN_BOOTSTRAP='[{"email":"admin@example.com","password":"dev-only-passphrase-1","display_name":"Admin","platform_role":"super_admin"}]'

npm install
npx prisma migrate deploy   # apply checked-in migrations (use `npm run prisma:migrate` to create new ones)
npm run dev                 # tsx watch, http://localhost:8080
```

Without `GOO_SIGNING_SECRET` a random per-process dev secret is generated (with a loud warning); every restart invalidates
all tokens. In production the server refuses to start without a real secret.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | run with tsx in watch mode |
| `npm run build` / `npm start` | compile to `dist/` / run the compiled server |
| `npm run typecheck` | `tsc` for `src/` and for `test/` |
| `npm test` | Vitest (applies migrations to the test DB first, see below) |
| `npm run openapi` | regenerate `openapi.yaml` |
| `npm run prisma:generate` / `prisma:migrate` / `prisma:deploy` | Prisma client / dev migration / deploy migrations |

## Configuration (environment variables)

All variables are validated with zod at startup; **every** problem is reported in one message and the process exits with code 1.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on the strict checks below |
| `DATABASE_URL` | – | **required in production** (PostgreSQL URL) |
| `GOO_SIGNING_SECRET` | – | JWT signing key; **required in production, >= 32 chars, placeholders like `change-me` rejected**. Outside production a random ephemeral secret is generated and a warning is logged. There is no hardcoded fallback. |
| `GOO_ADMIN_BOOTSTRAP` | unset | JSON array of `{email, password, display_name, platform_role}` where `platform_role` is `super_admin` or `platform_admin`. Strict schema (unknown keys are errors), max one `super_admin`, unique emails. In production passwords must be >= 12 chars and not defaults/placeholders (`admin`, `change-me...`). Missing accounts are created at boot; existing accounts are never modified. Error messages never contain passwords. |
| `GOO_BASE_URL` | `http://localhost:8080` | public URL; used for the device sign-in link (`<base>/device`) |
| `GOO_ALLOWED_ORIGINS` | empty | comma-separated **bare origins** allowed to call the API cross-origin with credentials. Never `*` (rejected). Same-origin requests (Origin host == Host) always work, so the bundled dashboard needs nothing here. |
| `GOO_COOKIE_SECURE` | `true` in production, else `false` | `Secure` flag of the session cookie. Setting `false` in production is allowed but logs a warning (needed for plain-HTTP deployments, because browsers never send Secure cookies over `http://`). |
| `GOO_TRUST_PROXY` | `false` | set `true` only behind a trusted proxy (Caddy in compose) so rate limiting sees the real client IP |
| `PORT` (or `GOO_PORT`) / `GOO_HOST` | `8080` / `0.0.0.0` | |
| `GOO_BODY_LIMIT_BYTES` | `1000000` | request body cap; larger bodies get `413` |
| `GOO_SYNC_BODY_LIMIT_BYTES` | `27262976` (26 MiB) | body cap of `POST .../sync/push` only (up to 200 changes; a 4 MiB note can grow up to 6x when JSON-escaped, so one note always fits; clients batch by about 8 MiB of content); `413` with `details.reason: too_large` above it |
| `GOO_SYNC_RATE_LIMIT_PER_MINUTE` | `120` | per-user budget for the sync endpoints (register, push, pull); `429 rate_limited` with a `Retry-After` header. Uses the same store as the login limiter (`GOO_RATE_LIMIT_STORE`). |
| `GOO_ACCESS_TOKEN_TTL` | `3600` | seconds |
| `GOO_REFRESH_TOKEN_TTL` | `2592000` | seconds |
| `GOO_SESSION_TTL` | `604800` | dashboard session/cookie lifetime, seconds |
| `GOO_DEVICE_FLOW_TTL` | `600` | device sign-in code lifetime, seconds |
| `GOO_LOGIN_RATE_MAX` / `GOO_LOGIN_RATE_WINDOW_SECONDS` | `10` / `300` | per **IP + email** budget for credential endpoints, then `429 rate_limited` |
| `GOO_RATE_LIMIT_STORE` | `memory` | where those counters live: `memory` (per process) or `postgres` (shared by every instance through the existing database, table `rate_limit_buckets`, no Redis needed). Set `postgres` as soon as you run more than one server instance. |
| `GOO_LOG_LEVEL` | `info` | pino level. Authorization/Cookie/CSRF headers are redacted; query strings are not logged. |
| `GOO_DASHBOARD_DIR` | unset | Built dashboard (`dashboard/dist`, must contain `index.html`) served at `/` with its own CSP and caching; the server answers `/runtime-config.js` itself (`window.__GOO_API_BASE_URL__ = "/api"`). The Docker image sets it to `/app/dashboard`. Unset: API only. |
| `GOO_SKIP_MIGRATIONS` | `0` | Docker entrypoint only: `1` skips `prisma migrate deploy` on boot |

## Migrations

Schema: `prisma/schema.prisma`; SQL migrations are checked in under `prisma/migrations/` (one `init` migration so far).

```bash
npm run prisma:migrate -- --name what_changed   # dev: create + apply a migration (needs DATABASE_URL)
npm run prisma:deploy                           # apply pending migrations (CI/production); the Docker image does this on boot
```

The init migration ends with a hand-written **partial unique index** (`notes_workspaceId_pathKey_live_key ON notes
(workspaceId, pathKey) WHERE deleted = false`) that Prisma cannot express. When creating a new migration, check that Prisma did
not add a `DROP INDEX` for it.

## Tests

The tests use `app.inject()` against a **real PostgreSQL** (no mocks for the database). Start a throwaway one and run:

```bash
docker run -d --rm --name goo-cloud-test-pg -p 127.0.0.1:55433:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=goo_test --tmpfs /var/lib/postgresql/data postgres:16-alpine
cd server && npm test        # default TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55433/goo_test
docker stop goo-cloud-test-pg
```

(If Docker's port forwarding does not work on your machine, run the container with `--network host` and
`postgres:16-alpine -c port=55433 -c listen_addresses=127.0.0.1` instead of `-p`.)

`test/globalSetup.ts` runs `prisma migrate deploy` first. Test data is uniquely named, so the database does not need resetting
between runs. Every JSON response is additionally validated against its declared zod schema during tests
(`validateResponses`), which keeps `openapi.yaml` honest. Coverage: auth (browser login + CSRF, device flow and `/device` page,
access tokens, refresh rotation and reuse detection, token families), account (`must_change_password`, password change/reset),
authorization matrix and cross-workspace IDOR (404s), membership (add directly / pending until the account exists / claimed at
sign-in, role changes by owner and admins, leave, transfer), admin routes, config and bootstrap validation, HTTP (CORS, CSP,
request ids, body caps), rate limiting (memory and Postgres stores, two instances), the bundled dashboard, OpenAPI drift, and the
sync wire contract (`test/sync.test.ts`): create/update/rename/delete/revive, partial upserts, no-op upserts, idempotent replays by
`op_id` (also concurrent), every rejection `reason`, case- and Unicode-insensitive path clashes, paths freed earlier in the same
push, size caps, path rules, viewer `forbidden`, coalesced pulls, paging by count and by content size, tombstones (left out of
`after=0`), gap-free concurrent seqs, device sign-out, sync rate limit and the dashboard's note routes.

## Docker / deployment

One image, `goo-cloud`, built from the **repository root** because it also builds the dashboard (`../dashboard`) and serves it at
`/`: `docker build -f server/Dockerfile -t goo-cloud .`. The image applies migrations on boot (`docker-entrypoint.sh`) and has a
`/healthz` (database-pinging) health check. Compose adds Postgres and Caddy (TLS only).

One origin, and the proxy passes everything through: the server answers `/v1/*` (desktop app), the same routes under `/api/v1/*`
(what the dashboard calls; the prefix is stripped before routing), `/device` (device sign-in page), `/healthz` (probes) and the
dashboard at `/`. Dashboard responses get their own `Content-Security-Policy` (scripts, styles and API calls from `'self'`, no
inline scripts) and caching (`/assets/*` is content-hashed and cached for a year, everything else revalidates); API responses keep
`no-store` and the locked-down API policy.

**Cookie `Secure` behaviour:** on by default in production; browsers do not send Secure cookies over `http://`, so plain-HTTP
setups must set `GOO_COOKIE_SECURE=false` explicitly (a warning is logged in production).

Graceful shutdown: on SIGTERM/SIGINT the server stops accepting connections, drains in-flight requests, disconnects Prisma
and exits (forced exit after 10 s). An hourly sweep drops expired sessions, refresh tokens, device flows and push outcomes
older than 30 days.

## Conventions (for dashboard / desktop clients)

- Base path `/v1`; JSON; timestamps ISO-8601 UTC; server ids are UUIDv7 strings, note ids are UUIDs made by the client; field
  names are `snake_case`.
- **Auth:** `Authorization: Bearer <access_token>` (desktop) **or** the `goo_session` httpOnly cookie (dashboard).
  Bearer wins if both are sent. Access tokens live 1 h; refresh tokens are opaque, single-use (rotation) and stored hashed;
  reusing an old refresh token revokes all of that user's refresh tokens. Each desktop sign-in is a token **family** (rotation
  keeps it, access tokens carry it as the `fam` claim); a device registered with such a token can be signed out from the
  dashboard (`DELETE /v1/me/devices/{id}` deletes that family's refresh tokens).
- **Dashboard login is email + password:** `POST /v1/auth/browser/login {email, password}` -> `200 {user, csrf_token}` + cookie
  (`HttpOnly; SameSite=Lax; Path=/`, `Secure` per config). After a page reload get the CSRF token again with
  `GET /v1/auth/browser/session` -> `{user, csrf_token}` (HMAC-derived from the session id; readable only by same/allowlisted origins).
- **CSRF:** every `POST/PUT/PATCH/DELETE` authenticated by the cookie must send `X-CSRF-Token: <csrf_token>`, else
  `403 {error.code: "csrf_invalid"}`. Bearer requests are exempt. Login/refresh/device-poll (unauthenticated) need none.
- **Errors:** `{ "error": { "code", "message", "details", "request_id" } }`. Codes: `invalid_request` (400/413/415; zod problems
  in `details.issues[{path,message}]`), `unauthenticated` 401, `forbidden` 403, `workspace_access_denied` 403, `csrf_invalid` 403,
  `origin_not_allowed` 403, `password_change_required` 403, `not_found` 404, `conflict` 409, `version_mismatch` 409
  (`details.current_version`), `rate_limited` 429 (+ `Retry-After`), `internal_error` 500. Send `X-Request-Id`
  (<=128 chars `[A-Za-z0-9._:-]`) or one is generated; it is echoed in the `X-Request-Id` response header and `error.request_id`.
  Sync push answers per-change rejections inside a 200 instead (see below).
- **Pagination:** every list: `?cursor=&limit=&order=` (limit default 20, max 100, `order=asc|desc`, ordered by `(created_at, id)`;
  use `order=desc` on audit logs for newest first). Response `{items: [...], page: {next_cursor, has_more}}`. Sync pull uses
  checkpoints instead (`after`, `has_more`).
- **Optimistic concurrency:** `PATCH` bodies and `POST .../transfer` require `version` (the version you last read) -> `409
  version_mismatch` if stale. `DELETE` accepts optional `?version=`.
- Device sign-in: the desktop calls `POST /v1/auth/device/start`, opens `verification_uri_complete` (`/device?user_code=..`, an HTML
  page where the user enters email + password) **or** the dashboard's signed-in user calls `POST /v1/auth/device/approve {user_code}`;
  the desktop polls `POST /v1/auth/device/poll {device_code}` -> `pending` | `approved` (tokens, once) | `expired` | `denied`
  (`reason: password_change_required`).
- **Passwords:** policy 12-256 characters (`src/routes/me.ts`). `POST /v1/me/password {current_password, new_password}` (new must differ;
  wrong current -> `403 forbidden` + `details.reason: invalid_current_password`; per-user rate limit with the login budget -> `429`).
  After a password change every refresh token is revoked, every access token issued before is rejected (the user's `tokenVersion`
  is bumped; access tokens carry it as the `tv` claim), and every dashboard session is deleted **except the caller's own cookie
  session**. Password reset by an admin and disabling sign the user out everywhere the same way.
- **`must_change_password`**: set for generated temporary passwords (`POST /v1/admin/users` without `password`) and by
  `POST /v1/admin/users/{id}/reset-password`. While set only `GET /v1/me`, `POST /v1/me/password`, `GET /v1/auth/browser/session`
  and `POST /v1/auth/browser/logout` are served; every other route answers `403 password_change_required`. Desktop sign-in is
  refused (the `/device` page shows a 403 with instructions after the correct password; approve is a 403; a flow approved before
  the flag was set polls as `denied`).

## Authorization matrix

Computed once by `requireWorkspaceRole(minRole)` (`src/auth/middleware.ts`), which every `/v1/workspaces/{workspace_id}/...`
route uses; nothing is hand-rolled per handler. `platform` = `super_admin` or `platform_admin`.

| Action | Allowed when |
|---|---|
| Read the workspace, its members, its notes (dashboard), sync pull | platform admin **or** any active member (owner/admin/editor/viewer) |
| Sync push | platform admin **or** owner/admin/editor. **Viewer: every change is rejected with `reason: forbidden`** (200, nothing written) |
| Add members, list/cancel pending additions, read the workspace audit log | platform admin **or** owner/admin (never granting a role above the caller's own) |
| Change a member's role, remove a member | platform admin **or** owner (anyone but the owner) **or** admin (only editors and viewers; grants at most `admin`) |
| Leave | any active member except the owner |
| Rename / change the description | platform admin **or** owner |
| Transfer ownership | `super_admin` **or** owner (the previous owner becomes `admin`) |
| Delete workspace | `super_admin` **or** owner (`platform_admin` alone is **not** enough) |
| Create workspace, register a device, own devices | any authenticated user |
| `/v1/admin/*` | platform admin only |
| `POST /v1/admin/users` with `platform_role: platform_admin`, `PATCH /v1/admin/users/{id}` role changes or any change to an admin, password reset of an admin, `DELETE /v1/admin/workspaces/{id}` | `super_admin` only |
| `POST /v1/admin/users/{id}/reset-password` | platform admin for regular users; never yourself (use `POST /v1/me/password`), so never the super admin |
| Everything except `GET /v1/me`, `POST /v1/me/password`, session probe, logout | not while the caller's `must_change_password` is set (`403 password_change_required`) |

Notes: the workspace owner's role can't be changed or removed (transfer instead); the single `super_admin` can't be created,
demoted or disabled via the API. Non-members get the same `403 workspace_access_denied` for real and nonexistent workspace ids.
Resources are always looked up by `(id, workspace_id)`; an id from another workspace yields `404 not_found` (notes, members,
invites) or `not_found` in a push. Adding a member needs no token: accounts exist only when an admin creates them (no
self-signup), so the account's email is the proof. An email without an account becomes a pending invite (no token, no expiry)
that turns into a membership when an account with that email is created or signs in.

**Audit log** (`GET /v1/workspaces/{id}/audit-logs`, `GET /v1/admin/audit-logs`; append-only, survives workspace deletion), written in
the same transaction as the change: `auth.login` (dashboard sign-in), `auth.device_approved` (details `via: dashboard|device_page`,
client and device name), `device.signed_out`, `user.password_changed`, `workspace.created|updated|deleted|ownership_transferred`,
`member.added|role_changed|removed|left`, `invite.created|revoked|accepted` (details `via: account_created|sign_in`),
`admin.user_created|user_updated|user_role_changed|user_password_reset|workspace_deleted`. Never passwords or tokens; **note
changes are not audited**.

## Sync

Each workspace has a change counter `checkpoint`. Every accepted note change takes the next value (atomic increment under the
workspace row lock, in the same transaction as the change) and stores it on the note as `seq`, so "changes after N" is simply
"notes with `seq > N`", already coalesced: a note edited ten times while a device was offline comes down once, in its latest
state. Seqs are gap-free and committed in order.

**Note** (`notes` table): `id` (client-made UUID, scoped to the workspace; a rename only changes `path`), `path`, `content` (UTF-8,
<= 4 MiB, `""` for tombstones), `content_hash` (SHA-256 hex, computed by the server), `version` (1, +1 per accepted change),
`deleted` (tombstone), `seq`, `updatedBy` / `updatedByClient` / `updatedAt`. **Paths** are relative and `/`-separated, without
empty, `.` or `..` segments, backslashes or control characters; segments <= 200 and the whole path <= 1024 characters; they end in
`.md`, `.markdown`, `.mdown` or `.mkd` (any case). Among the **live** notes of a workspace a path is unique compared
case-insensitively and after Unicode NFC normalisation (`pathKey`), like the file systems of macOS and Windows; tombstones keep
their path but do not hold it.

### `POST /v1/sync/clients/register`

`{device_name, platform, app_version}` -> `201 {client_id, protocol_version: 1, features: []}`. One row per user and
installation, listed under `GET /v1/me/devices` (with `last_seen_at`, updated by push and pull). Push and pull need a `client_id`
of the caller (another user's is `400`).

### `GET /v1/workspaces/{id}/sync/pull?client_id&after=N&limit=` (viewer+)

-> `{changes: [{note_id, path, version, deleted, content_hash, content, seq}], checkpoint, has_more}`, ordered by `seq`.
`content` and `content_hash` are `null` for tombstones. `limit` defaults to 200 (max 500); a page also stops after about 8 MiB of
content (always at least one change). `after=0` is the initial download and leaves tombstones out; the following pages and pulls
deliver them, so clients ignore tombstones of notes they do not have. `checkpoint` is the `seq` of the last change when
`has_more`, else the workspace checkpoint (covering left-out tombstones). Store it only after applying the page, and never take
it from a push answer.

### `POST /v1/workspaces/{id}/sync/push` (editor+)

```json
{ "client_id": "...", "changes": [
  { "op_id": "uuid", "note_id": "uuid", "op": "upsert", "base_version": 3, "path": "plan.md", "content": "..." },
  { "op_id": "uuid", "note_id": "uuid", "op": "delete", "base_version": 4 } ] }
```

At most 200 changes and `GOO_SYNC_BODY_LIMIT_BYTES` (26 MiB; clients batch by about 8 MiB of content). Changes apply in array order, **each in its own transaction**, and
are **idempotent by `op_id`** (per workspace): the outcome, accepted or rejected, is stored, and a replay returns it again and
changes nothing (a replayed rejection carries the note's state as it is now). Unknown fields are ignored.

| Change | Result |
|---|---|
| upsert, unknown `note_id`, `base_version` 0, `path` and `content` given | created, `version` 1 |
| upsert, unknown `note_id`, `base_version` > 0; delete of an unknown note | `not_found` |
| any change to an existing note with `base_version` != its version (incl. 0) | `version_mismatch` with `current` |
| upsert with the current version | `path` / `content` each optional (absent = unchanged): edit, rename, or both; `version` +1. Nothing changed: accepted with the same version and seq |
| upsert of a tombstone with its version | revived (`deleted: false`; absent content stays `""`), `version` +1 |
| delete with the current version | tombstone: content cleared, `deleted: true`, `version` +1, new `seq`. Deleting a tombstone again: accepted, unchanged |

Answer (always `200` once the request itself is valid):

```json
{ "accepted": [{ "op_id", "note_id", "version", "seq" }],
  "rejected": [{ "op_id", "note_id", "reason", "message", "current": { "version", "path", "deleted", "content" } | null }],
  "checkpoint": 1234 }
```

| reason | meaning | `current` |
|---|---|---|
| `version_mismatch` | `base_version` differs from the server's version (pull and merge) | the note's state |
| `path_taken` | another live note has this path (case-insensitively); rename locally | the note's state if it exists, else null |
| `not_found` | the note does not exist in this workspace (ids of other workspaces look the same) | null |
| `too_large` | content over 4 MiB (4194304 UTF-8 bytes) | null |
| `invalid` | bad path (message says why), `note_id` not a UUID, a new note without `path` or `content`, NUL in content | null |
| `forbidden` | the caller is a viewer: every change is refused and nothing is written (not stored, so the same `op_id` works after a promotion) | null |

`current.content` is `null` for tombstones, and also once the rejections of one answer already carry about 8 MiB of content (pull
to get the text). A malformed request (bad envelope, more than 200 changes) is a `400`, a too large body a `413`, non-members get
`403 workspace_access_denied`. `checkpoint` is the workspace checkpoint after the push.

**Limits:** `GOO_SYNC_RATE_LIMIT_PER_MINUTE` (default 120 requests per user per minute over register, push and pull) answers
`429 rate_limited` + `Retry-After`. Other routes keep the 1 MB body cap.

### Dashboard note routes (viewer+)

`GET /v1/workspaces/{id}/notes?q=&cursor=&limit=` lists live notes as metadata (`id, workspace_id, path, version, size, created_at,
updated_at, updated_by {id, display_name} | null`, no content; `q` filters by path substring). `GET /v1/workspaces/{id}/notes/{note_id}`
returns `{note}` with `content` and `content_hash`; tombstones and ids of other workspaces are `404`. Notes are only written
through sync.

## Endpoint reference

Generated from the registered routes (authoritative schemas: `openapi.yaml`). "auth" = Bearer or cookie(+CSRF).

#### System

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/healthz` | public | 200/503 | Liveness/readiness probe; verifies the database is reachable (503 otherwise) |

#### Auth

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/device` | public | 200 | Device login approval page (HTML). Open from `verification_uri_complete`. |
| `POST` | `/device` | public | 200 | Submit code + email + password (urlencoded form) to approve a device login |
| `POST` | `/v1/auth/browser/login` | public | 200 | Dashboard login (email + password). Sets the httpOnly session cookie and returns the CSRF token. |
| `POST` | `/v1/auth/device/start` | public | 200 | Start the desktop device login flow |
| `POST` | `/v1/auth/device/poll` | public | 200 | Poll a device login; returns tokens once approved (exactly once) |
| `POST` | `/v1/auth/refresh` | public | 200 | Rotate a refresh token for a new access/refresh pair |
| `POST` | `/v1/auth/device/approve` | auth | 200 | Approve a pending device login (used by the dashboard for the signed-in user) |
| `POST` | `/v1/auth/logout` | public | 200 | Revoke a refresh token (desktop logout). Always succeeds. |
| `POST` | `/v1/auth/browser/logout` | auth | 200 | Dashboard logout: deletes the server-side session and clears the cookie |
| `GET` | `/v1/auth/browser/session` | auth | 200 | Current dashboard session: user + CSRF token (recoverable after a page reload) |
| `GET` | `/v1/me` | auth | 200 | Current user and their active workspace memberships |
| `POST` | `/v1/me/password` | auth | 200 | Change own password; signs out every other session and device |
| `GET` | `/v1/me/devices` | auth | 200 | The caller's registered sync devices |
| `DELETE` | `/v1/me/devices/{deviceId}` | auth | 200 | Sign a device out: drops the refresh tokens of the sign-in it registered with and removes it |

#### Workspaces

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/v1/workspaces` | auth | 200 | Workspaces the caller is an active member of (with the caller's role) |
| `POST` | `/v1/workspaces` | auth | 201 | Create a workspace (a synced notes folder); the caller becomes its owner |
| `GET` | `/v1/workspaces/{workspaceId}` | auth — any active member, or platform admin (membership is null for non-member platform admins) | 200 | Workspace metadata and the caller's membership |
| `PATCH` | `/v1/workspaces/{workspaceId}` | auth — workspace owner, or platform admin | 200 | Rename a workspace or change its description (optimistic concurrency via `version`) |
| `POST` | `/v1/workspaces/{workspaceId}/transfer` | auth — workspace owner, or super_admin | 200 | Transfer ownership to another active member; the previous owner stays as admin |
| `DELETE` | `/v1/workspaces/{workspaceId}` | auth — workspace owner, or super_admin (platform_admin is NOT sufficient) | 200 | Delete a workspace and all of its notes |

#### Membership

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/v1/workspaces/{workspaceId}/members` | auth — any active member, or platform admin | 200 | List active members |
| `POST` | `/v1/workspaces/{workspaceId}/members` | auth — workspace owner/admin, or platform admin | 201 | Add a member by email |
| `PATCH` | `/v1/workspaces/{workspaceId}/members/{memberId}` | auth — workspace owner/admin, or platform admin | 200 | Change a member's role (the workspace owner's role cannot be changed; use transfer) |
| `DELETE` | `/v1/workspaces/{workspaceId}/members/{memberId}` | auth — workspace owner/admin, or platform admin | 200 | Remove a member (soft: status becomes `removed`); the owner cannot be removed |
| `POST` | `/v1/workspaces/{workspaceId}/leave` | auth — any active member except the owner | 200 | Leave a workspace (the owner must transfer ownership or delete the workspace instead) |
| `GET` | `/v1/workspaces/{workspaceId}/invites` | auth — workspace owner/admin, or platform admin | 200 | List people added before they had an account (`?status=pending` for the open ones) |
| `DELETE` | `/v1/workspaces/{workspaceId}/invites/{inviteId}` | auth — workspace owner/admin, or platform admin | 200 | Cancel a pending addition (the person is not added when their account is created) |

#### Notes

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/v1/workspaces/{workspaceId}/notes` | auth — any active workspace member, or platform admin | 200 | List the live notes of a workspace (metadata only, no content) |
| `GET` | `/v1/workspaces/{workspaceId}/notes/{noteId}` | auth — any active workspace member, or platform admin | 200 | One live note with its content |

#### Sync

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `POST` | `/v1/sync/clients/register` | auth | 201 | Register a device for sync |
| `POST` | `/v1/workspaces/{workspaceId}/sync/push` | auth — any active member (changes of viewers are rejected `forbidden`), or platform admin | 200 | Push note changes. Each change is accepted or rejected on its own. |
| `GET` | `/v1/workspaces/{workspaceId}/sync/pull` | auth — any active workspace member, or platform admin | 200 | Pull the notes changed after a checkpoint (repeat with the returned checkpoint while has_more) |

#### Admin

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/v1/admin/users` | auth — platform_admin or super_admin | 200 | List platform users |
| `POST` | `/v1/admin/users` | auth — platform_admin or super_admin; platform_role=platform_admin needs super_admin only | 201 | Create/onboard a user. Creating a platform_admin requires super_admin. |
| `PATCH` | `/v1/admin/users/{userId}` | auth — platform_admin or super_admin for regular users; super_admin only for roles and for other admins | 200 | Update a user's display name, platform role, disabled state or must-change-password flag |
| `POST` | `/v1/admin/users/{userId}/reset-password` | auth — platform_admin or super_admin for regular users; super_admin only for other admins; never yourself | 200 | Reset a user's password to a new temporary one (returned once) that must be changed at next sign-in |
| `GET` | `/v1/admin/workspaces` | auth — platform_admin or super_admin | 200 | List all workspaces on the platform |
| `GET` | `/v1/admin/workspaces/{workspaceId}` | auth — platform_admin or super_admin | 200 | Workspace inspection: metadata, owner, member and note counts |
| `DELETE` | `/v1/admin/workspaces/{workspaceId}` | auth — super_admin only | 200 | Delete any workspace (platform level) |
| `GET` | `/v1/admin/audit-logs` | auth — platform_admin or super_admin | 200 | Platform-wide audit trail (append-only). Ordered by (created_at, id); pass order=desc for newest first. |
| `GET` | `/v1/workspaces/{workspaceId}/audit-logs` | auth — workspace owner/admin, or platform admin | 200 | Workspace audit trail. Ordered by (created_at, id); pass order=desc for newest first. |
| `GET` | `/v1/admin/health` | auth — platform_admin or super_admin | 200/503 | Operational health: pings PostgreSQL (503 when the database is unreachable) |
| `GET` | `/v1/admin/stats` | auth — platform_admin or super_admin | 200 | Platform counters for the dashboard |

## Key request/response field names

(See `openapi.yaml` for complete schemas.)

- **User**: `id, email, display_name, platform_role` (`super_admin|platform_admin|user`), `must_change_password`; admin views add `disabled, created_at, updated_at`.
- **Workspace**: `id, slug, name, description, owner_user_id, created_at, updated_at, version`; list items add `role, joined_at, added_by`.
  Create `{name, slug?, description?}`; patch `{name?, description?, version}`; transfer `{member_id, version}`.
- **Member**: `id, workspace_id, user_id, email, display_name, role, status, joined_at, created_at, updated_at, version`; `PATCH {role: admin|editor|viewer, version}`.
- **Add member**: `POST /v1/workspaces/{id}/members {email, role}` -> `{status: "added", member}` or `{status: "pending", invite}`.
- **Invite**: `id, workspace_id, email, role, status (pending|accepted|revoked), invited_by_user_id, created_at, updated_at, version`.
- **Device**: `id, device_name, platform, app_version, created_at, last_seen_at`.
- **Audit log**: `id, actor_user_id, actor_email (null for system/deleted users), action, resource_type, resource_id, workspace_id, request_id, details, created_at`.
- **Admin**: `GET /v1/admin/workspaces/{id}` -> `{workspace, owner, counts: {members, pending_invites, notes, note_bytes, checkpoint}}`;
  `GET /v1/admin/stats` -> `{users, platform_admins, disabled_users, workspaces, memberships, pending_invites, notes, devices, active_sessions, audit_logs}`.

## Differences from Slinger Cloud and DESIGN.md (deliberate)

- Dropped from Slinger: collections/folders/requests/environments/variables/globals, collection versions, hosts, the sync v2
  operation log and snapshot, extension features, realtime/collab token issuers, join requests, `GET /v1/workspaces/resolve`,
  `POST /v1/workspaces/publish`, workspace `visibility` / `default_role_for_requests` / `host_mode`, legacy token invites.
- Added: notes and the file-based sync protocol, device list and sign-out (token families), ownership transfer, leave, sign-in
  audit entries. Workspace admins may now change and remove editors and viewers (Slinger: owner only).
- DESIGN.md describes invites the user accepts on the dashboard; like Slinger's latest behaviour, an existing account is added
  directly and an email without an account waits as a pending invite (claimed when the account is created or signs in).
- Viewer pushes are answered per change with `reason: forbidden` (Slinger refused the whole request with 403), so clients branch
  only on `reason`.

## Known limitations

- Login rate limiting counts in per-process memory by default (N instances = N x the budget); set `GOO_RATE_LIMIT_STORE=postgres`
  to share the counters. Fixed window, per IP + email.
- No self-service "forgot password" (no email delivery): an admin resets it.
- Signing a device out stops it from refreshing; its current access token stays valid until it expires (1 h by default).
- Push outcomes are kept 30 days for replays; a replay after that is applied as a new change (and usually rejected
  `version_mismatch`).
- Note contents are stored as plain text in PostgreSQL; use disk/database encryption where needed.
