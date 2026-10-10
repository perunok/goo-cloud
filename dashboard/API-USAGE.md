# API usage

Everything the dashboard calls lives in **one file**, `src/lib/api/endpoints.ts`, with response shapes in
`src/lib/api/schemas.ts` (zod). The authoritative reference is [`../server/openapi.yaml`](../server/openapi.yaml) and the
authorization matrix in [`../server/README.md`](../server/README.md); the routes below are exercised end to end by `npm run e2e`
(repo root) against a real server and PostgreSQL. The in-memory `src/dev/mockApi.ts` speaks the same shapes.

## Conventions

| | |
|---|---|
| Base | `{API_BASE_URL}/v1{path}`. `API_BASE_URL` comes from `runtime-config.js` (`/api` when served by the goo cloud server, which strips the prefix itself). In `npm run dev` it defaults to `/api`, which Vite proxies to `http://localhost:8080` (override with `GOO_API_PROXY`). |
| Credentials | `credentials: 'include'`; the session is the httpOnly `goo_session` cookie (`SameSite=Lax`, `Secure` per server config). |
| CSRF | Every non-GET request sends `X-CSRF-Token` from `POST /auth/browser/login`, re-issued after a reload by `GET /auth/browser/session`. `403 csrf_invalid` returns the UI to the login screen. |
| Lists | `?cursor=&limit=&order=asc\|desc` -> `{ items, page: { next_cursor, has_more } }`, ordered by `(created_at, id)`. The dashboard asks for `order=desc` for users, workspaces, devices, pending invites and audit logs; members and notes stay oldest first. |
| Search | `q` on `/admin/users`, `/admin/workspaces` and `/workspaces/{id}/notes` (path substring). `GET /workspaces` has no `q`: the UI filters the loaded rows. |
| Errors | `{ error: { code, message, details, request_id } }`; `details.issues: [{path, message}]` become field errors. `401` (except login and the boot probe) or `403 csrf_invalid` -> login screen, then back to the same page. `403 password_change_required` -> the "Choose a new password" screen. |

## Routes

| Method | Path | Used by |
|---|---|---|
| POST | `/auth/browser/login` | Login |
| GET | `/auth/browser/session` | Boot (restores the session and CSRF token after a reload) |
| POST | `/auth/browser/logout` | Sign out |
| POST | `/auth/device/approve` `{ user_code }` | Desktop sign-in (`#/device?code=...`); `404` = unknown, expired or used code |
| POST | `/me/password` | Account, forced password change |
| GET | `/me/devices` | Account > Devices |
| DELETE | `/me/devices/{id}` | Account > Devices > Sign out |
| GET | `/workspaces` | Workspaces (members) |
| POST | `/workspaces` `{ name, slug?, description? }` | Create workspace |
| GET | `/workspaces/{id}` | Workspace page (workspace + caller's membership) |
| PATCH | `/workspaces/{id}` `{ name?, description?, version }` | Overview > Settings (`409 version_mismatch` -> "Load latest version") |
| POST | `/workspaces/{id}/transfer` `{ member_id, version }` | Overview > Ownership |
| POST | `/workspaces/{id}/leave` | Overview > Leave workspace |
| DELETE | `/workspaces/{id}` | Workspaces list, Overview > Danger zone |
| GET | `/workspaces/{id}/notes?q=` | Notes tab (metadata only) |
| GET | `/workspaces/{id}/notes/{note_id}` | Note view (read-only; rendered Markdown or plain text) |
| GET, POST | `/workspaces/{id}/members` | Members tab, Add member (`added` or `pending`), Overview > Transfer (candidates) |
| PATCH, DELETE | `/workspaces/{id}/members/{member_id}` | Members tab: change role (`{ role, version }`), remove |
| GET | `/workspaces/{id}/invites?status=pending` | Members tab > Waiting for an account |
| DELETE | `/workspaces/{id}/invites/{invite_id}` | Cancel a pending addition |
| GET | `/workspaces/{id}/audit-logs` | Audit tab (owner/admin) |
| GET | `/admin/stats`, `/admin/health`, `/admin/audit-logs?limit=5` | Overview (platform admins); `503` from health is data |
| GET, POST | `/admin/users` | Users (create with a generated temporary password or a typed one) |
| PATCH | `/admin/users/{id}` `{ platform_role }` / `{ disabled }` / `{ must_change_password }` | Users |
| POST | `/admin/users/{id}/reset-password` | Users > Reset password (temporary password shown once) |
| GET | `/admin/workspaces` | Workspaces (platform admins see all) |
| GET | `/admin/audit-logs` | Audit log |
