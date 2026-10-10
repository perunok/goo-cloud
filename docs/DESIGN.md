# goo cloud: design

goo cloud keeps goo's note folders in sync between devices and lets people share a folder. It is modelled on
Slinger Cloud (`perunok/slinger-admin`): same stack, same auth, same deploy shape. The difference is the data: goo's
notes are plain Markdown **files**, not database rows, so the sync protocol is designed around files.

Scope of v1: sync + sharing + an admin dashboard. Not in v1: editing notes in the browser, attachments/images,
real-time collaborative editing, end-to-end encryption.

## 1. Pieces

| Piece | Where | What |
| --- | --- | --- |
| Server | `goo-cloud/server` | Fastify 5 + Prisma + PostgreSQL 16, TypeScript. Auth, workspaces, members, notes, sync API, admin API. Routes declared once with zod; `openapi.yaml` is generated from them. |
| Dashboard | `goo-cloud/dashboard` | Svelte 5 SPA served by the server at `/`: sign-in, workspaces, read-only notes, members, pending invites, devices, approving desktop sign-ins; users, all workspaces and audit for admins. |
| Deploy | `goo-cloud/deploy`, `docker-compose.yml`, `deploy-manual.md` | One image (`goo-cloud`: API + dashboard), Postgres, Caddy for TLS. Published multi-arch to GHCR (and Docker Hub when configured) on release tags. |
| e2e | `goo-cloud/e2e` | Playwright against the real server, the built dashboard and a throwaway Postgres. |
| Desktop sync | `goo/crates/goo-sync` + `goo/src/features/cloud` | Rust sync engine and the Settings > goo cloud tab in the goo app. |

## 2. Concepts

- **User**: email + password (argon2id). Platform roles `super_admin`, `admin`, `user`. The first admins come from
  `GOO_ADMIN_BOOTSTRAP`.
- **Workspace**: a synced notes folder. Each device links it to a local folder (the folder name is local, never synced).
- **Membership**: `owner` > `admin` > `editor` > `viewer`. Viewers pull only; editors push; admins manage members;
  owners also rename, transfer and delete.
- **Adding members**: an owner or admin adds people by email with a role (never above their own). An existing account becomes
  a member at once, with nothing to accept (accounts only exist when an admin created them, so the email is the proof). An
  email without an account is kept as a pending **invite** (no token, no expiry, cancellable) that turns into a membership when
  an account with that email is created or signs in.
- **Device** (`SyncClient`): one row per user and installation (name, platform, app version, last seen).
- **Note**: one Markdown file in a workspace:

  | Field | Notes |
  | --- | --- |
  | `id` | UUID made by the client that created the note. The identity; a rename only changes `path`. |
  | `path` | Relative, `/`-separated, e.g. `projects/plan.md`. Unique among live notes of the workspace, compared case-insensitively (macOS/Windows file systems). Folders are implicit. |
  | `content` | UTF-8 text, at most 4 MiB (the client enforces the same cap, so nothing a user can save is refused). |
  | `contentHash` | SHA-256 of `content`, hex. |
  | `version` | Starts at 1, +1 on every accepted change. Optimistic concurrency. |
  | `deleted` | Tombstone. Deleted notes stay as rows (content cleared) so every device learns about the delete. |
  | `seq` | The workspace change counter at the note's last change (see 4). |
  | `updatedBy`, `updatedByClient`, `updatedAt` | Who and which device changed it last. |

## 3. Auth (same as Slinger Cloud)

- Dashboard: `POST /v1/auth/browser/login` sets an httpOnly session cookie; unsafe requests need `X-CSRF-Token`.
- Desktop: device sign-in. `POST /v1/auth/device/start` returns a short user code and a URL; the user approves it
  in the browser (signed in on the dashboard, or on the plain `/device` page); the app polls
  `POST /v1/auth/device/poll` and receives an access token (JWT, 1 h) and a refresh token (opaque, 30 days,
  single-use, rotated; reuse of an old one revokes all of the user's refresh tokens).
- Desktop keeps tokens in the OS keychain, refreshes with one mutex, persists the new pair before using it, and never
  retries a refresh after a network error.
- Authorization in one place on the server (`requireWorkspaceRole`); resources are always looked up by
  `(id, workspaceId)` so foreign ids get 404.

## 4. Sync protocol

The server is the source of order. Each workspace has a counter `checkpoint`; every accepted change takes the next
number and stores it on the note as `seq`. Because the note row itself carries its latest `seq`, the change feed
is simply "notes with `seq` greater than N", already coalesced (ten edits to one note while a device was offline
come down as one change).

### 4.1 Endpoints

- `POST /v1/sync/clients/register {device_name, platform, app_version}` -> `{client_id, protocol_version: 1, features}`.
- `GET /v1/workspaces/{id}/sync/pull?client_id&after=N&limit=` ->
  `{changes: [{note_id, path, version, deleted, content_hash, content, seq}], checkpoint, has_more}`.
  Ordered by `seq`. `content` is null for tombstones. Pages are capped by count and by about 8 MiB of content.
  `after=0` is the initial download (tombstones are left out of it).
- `POST /v1/workspaces/{id}/sync/push {client_id, changes: [...]}` with at most 200 changes. The body cap (26 MiB by
  default) fits one maximal note even when JSON escaping makes it 6x larger; clients batch by about 8 MiB of content:

  ```json
  { "op_id": "uuid", "note_id": "uuid", "op": "upsert", "base_version": 3, "path": "plan.md", "content": "..." }
  { "op_id": "uuid", "note_id": "uuid", "op": "delete", "base_version": 4 }
  ```

  `base_version` is 0 for a new note. On upsert `path` and `content` are each optional (absent = unchanged), so a
  rename does not resend the text. Each change is applied in its own transaction and is idempotent by `op_id` (a
  lost response can be replayed). Answer:

  ```json
  { "accepted": [{ "op_id", "note_id", "version", "seq" }],
    "rejected": [{ "op_id", "note_id", "reason", "message", "current": { "version", "path", "deleted", "content" } }],
    "checkpoint": 1234 }
  ```

  `reason` is one of `version_mismatch`, `path_taken`, `not_found`, `too_large`, `invalid`, `forbidden`. The client
  branches on `reason`, never on HTTP status.

### 4.2 Desktop engine (phase 2, in Rust)

State per linked workspace lives in goo's config dir, never in the notes folder:
`<config>/sync/<workspace-id>/state.json` (`note_id -> {path, version, base_hash}`, the checkpoint, the client id)
and `base/<note_id>` (the last agreed text, the base for merging).

One sync cycle:

1. **Scan** the folder (same filters as the tree: Markdown files, no hidden or build folders). Compare each file
   with the stored base by size/mtime, then hash. This yields the local changes: new, modified, missing. A missing
   file plus a new file with the same hash is a **rename** (same id). No op log is kept: the change is derived from
   the current file against the base, so many offline edits become one change and no-ops vanish.
2. **Pull** pages after the checkpoint and apply them; the checkpoint advances only after a page is applied (never
   from a push response, which may cover changes this device has not pulled yet).
   - Remote change, local untouched: write the file (atomic), update the base.
   - Both changed: **3-way merge** by lines (diff3) against the base. Clean: write the merge, push it with the
     remote version as base. Overlapping edits: keep the local file, write the remote text next to it as
     `name (conflict <device> <date>).md`, and list it in the conflict panel. Nothing is ever discarded silently.
   - Remote delete, local untouched: delete the file. Remote delete, local edited: keep it and push it as new.
   - Remote rename: move the file; if the target path is taken locally, keep both and rename the incoming one.
   - A note with unsaved edits in the goo window is not written; it waits for the next cycle.
3. **Push** the local changes in batches, `op_id`s stored before sending. Rejections: `version_mismatch` -> pull
   again and merge; `path_taken` -> rename locally with a suffix; anything permanent -> quarantined and shown,
   re-armed by the next local edit (never retried in a loop).
4. Repeat pull/push up to 4 rounds while either side made progress.

When: on start, on window focus, a few seconds after a save, and every 60 s while focused (5 min in the
background), with backoff and jitter on errors.

### 4.3 What is synced

Markdown notes and their paths. Not synced: other files in the folder, empty folders, the local folder name,
settings, the MCP token, recent folders.

## 5. Dashboard

Hash-routed pages (`dashboard/README.md`, every endpoint in `dashboard/API-USAGE.md`):

- **Sign-in**, the forced "choose a new password" screen for admin-issued passwords, **Account** (change password; **Devices**:
  the user's goo installations from `GET /v1/me/devices`, each can be signed out).
- **Desktop sign-in** (`#/device?code=...`): approves the code goo shows (`POST /v1/auth/device/approve`), never without a click.
  The server's plain `/device` page (code + email + password) remains for browsers without a dashboard session.
- **Workspaces**: list (platform admins see all), create (slug optional), delete. A workspace has the tabs **Overview** (details;
  rename and description for the owner or platform admins with optimistic concurrency; transfer ownership; leave; delete),
  **Notes** (read-only list with path, size and last change, path search; a note opens as rendered Markdown or plain text: the
  renderer builds elements from a data tree and never injects HTML, only http(s)/mailto links are clickable, images are not
  loaded), **Members** (add by email with a role, change roles, remove, pending invites with cancel) and **Audit log** (owners
  and admins).
- For platform admins: **Overview** (counters, database health, recent activity), **Users** (create with a generated temporary
  password or a typed one, platform roles for the super admin, disable, force a password change, reset the password), the
  platform **Audit log**.

The UI mirrors the authorization matrix (hidden or disabled controls explain why); the server stays the authority.

## 6. Security

- Passwords with argon2id; login rate limited per IP and email.
- Secrets required in production (`GOO_SIGNING_SECRET` at least 32 characters); config validated at start, all
  problems reported at once.
- The dashboard has its own CSP without inline scripts; cookies are httpOnly and SameSite=Lax; CSRF tokens.
- Note contents are stored as text in Postgres; use full-disk/database encryption on the server if needed (E2E
  encryption is out of scope for v1).
- Append-only audit log for sign-ins, membership and workspace changes (not for every note edit).

## 7. Testing

- Server: Vitest with `app.inject()` against a real Postgres (a throwaway container locally, a service container in
  CI); every JSON response is checked against its declared schema; an OpenAPI-is-current test.
- Sync: a wire-contract suite for push/pull (accept, reject reasons, idempotency, coalesced pull, tombstones,
  case-insensitive path clashes).
- e2e: Playwright drives the dashboard against the real server.
- Desktop (phase 2): unit tests for scan/merge/rename detection, plus a two-device convergence test against a real
  server.

## 8. Lessons carried over from Slinger Cloud

1. Derive changes from current state against a stored base; don't keep an op log on the client.
2. Pull before push; advance the checkpoint only when a pull page is applied.
3. Stable, persisted `op_id`s make replays safe.
4. Identity is a client-made id, never the path.
5. Tombstones must be kept and delivered.
6. Branch on structured `reason`s; quarantine permanent failures, re-arm on the next edit.
7. Never discard local work silently: merge, or keep a conflict copy.
8. Never match by name when linking a folder to a workspace; two notes with the same path are kept apart.
9. Grow the protocol with feature flags in both directions; absent fields mean "unchanged".
10. Refresh-token rotation needs one refresher and persist-before-use.
