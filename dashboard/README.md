# goo cloud dashboard

Svelte 5 (runes) + TypeScript (strict) + Vite web UI for goo cloud: sign-in, workspaces and their notes (read-only),
members, devices, desktop sign-in approval, and for platform admins users, all workspaces and the audit log. Ported from the
Slinger Cloud admin dashboard. Talks to the API under `/v1` with an httpOnly session cookie plus `X-CSRF-Token`; every endpoint
it calls is listed in `API-USAGE.md`.

## Commands

```sh
npm ci
npm run dev          # http://localhost:5173, proxies /api/* to the API on :8080 (GOO_API_PROXY overrides)
npm run dev:mock     # dev server against the in-memory fake API (no backend needed)
npm run typecheck    # svelte-check (strict)
npm test             # vitest (unit + component tests, jsdom)
npm run build        # production bundle in dist/
```

### Mock API

`VITE_MOCK_API=1` (used by `npm run dev:mock`) installs `src/dev/mockApi.ts` as the HTTP client's `fetch`. It enforces CSRF,
cursor pagination, the error envelope and the workspace roles, so the real client and zod schemas run unchanged; it is not part
of production bundles. Accounts (password `password-12345`): `super@example.com` (super admin), `admin@example.com` (platform
admin), `owner@example.com`, `editor@example.com`, `viewer@example.com` (owner, editor, viewer of "Team notes"),
`temp@example.com` (must change its password first). Desktop sign-in codes `ABCD-EFGH` and `WXYZ-2345` can be approved once.
Console hooks: `__mock.expireSession()`, `__mock.failNext(502)`, `__mock.latency(ms)`, `__mock.reset()`,
`__mock.healthDown()`, `__mock.addDeviceCode('ABCD-1234')`.

## Configuration

The API base URL (the prefix in front of `/v1`) is resolved at runtime from `window.__GOO_API_BASE_URL__`, set by
`/runtime-config.js`. In production the dashboard is served by the goo cloud server (`GOO_DASHBOARD_DIR`, see
`server/README.md`), which answers `/runtime-config.js` itself with `/api`: same origin, and the server accepts `/api/v1/...` as
well as `/v1/...`. The file in `public/` is only a placeholder; a production build that still sees it shows a blocking
"Dashboard is not configured" screen. Only `npm run dev` falls back to `VITE_API_BASE_URL` / `/api`.

Docker: there is no dashboard image of its own. `server/Dockerfile` (build context: the repository root) runs `npm run build`
here and copies `dist/` into the `goo-cloud` image. Without Docker: `npm run build`, then start the server with
`GOO_DASHBOARD_DIR=../dashboard/dist`.

The server sends a strict Content-Security-Policy for the dashboard (scripts, styles, images and API calls from its own origin
only). Keep scripts in files (the theme bootstrap is `public/theme-init.js` for that reason).

## Structure

```
src/
  lib/api/          ALL HTTP: client.ts (fetch, CSRF, error normalization, global 401), endpoints.ts (routes),
                    schemas.ts (zod), errors.ts, config.ts
  lib/state/        session, router (hash), toasts, theme, paginator, action (busy/double-submit guard)
  lib/permissions.ts  authorization matrix from server/README.md (UI only; the server decides)
  lib/markdown.ts     small Markdown reader for the note view (data tree, no HTML strings)
  lib/validation.ts   client-side form validation
  lib/components/   Button, fields, Modal (native <dialog>), ConfirmDialog, Toasts, ListState, AuditTable, Markdown, Brand
  pages/            Overview, Users, Workspaces, WorkspaceDetail (+ workspace/: overview, notes, note view, members,
                    audit), Audit, Account (password + devices), Device (approve a desktop sign-in), ForcePassword
  dev/mockApi.ts    fake API for VITE_MOCK_API=1
```

Design notes:

- **Routing**: hash router (`#/workspaces/<id>/notes/<note-id>`, `#/device?code=ABCD-EFGH`), so refresh, back/forward and deep
  links work from static files. A deep link opened while signed out is shown after signing in.
- **Notes** are read-only: the list shows path, size and last change; the note view renders Markdown with
  `lib/markdown.ts` + `components/Markdown.svelte`, which build ordinary Svelte elements from a data tree. Nothing from a note
  is ever inserted as HTML (`{@html}` is not used anywhere), raw HTML in a note shows as text, only `http(s):`/`mailto:` links
  are clickable (`rel="noopener noreferrer nofollow"`, new tab) and images are shown as links, never loaded. Notes over 256 KB
  open as plain text.
- **Desktop sign-in**: goo shows a code; the user approves it on `#/device` (pre-filled from `?code=`, never approved without a
  click). The server's own `/device` page (email + password form) remains for browsers without a dashboard session.
- **Role-based UI** mirrors the server's matrix: owners and platform admins manage every member but the owner; workspace admins
  add people and manage editors and viewers; owners (or the super admin) rename, transfer and delete; everyone but the owner can
  leave. Hidden or disabled controls explain why; the server remains the authority.
- **Errors**: everything thrown by the client is an `ApiError` with a user-safe message; non-JSON bodies, network failures and
  schema mismatches never surface raw parser errors. Mutations go through `Action.run` (no double submits).
- **Themes**: `data-theme` on `<html>` (`system`, `light`, `dark`, `midnight`, `contrast`), persisted in `localStorage`
  (`goo.theme`), applied before first paint. Colours only via the tokens in `src/app.css` (accent: goo's violet).
- **Passwords**: `#/account` changes the password (the server keeps this session and signs out every other session and
  device). Accounts with `must_change_password` only get the "Choose a new password" screen.

## Known limitations

- No "forgot password" (the server sends no email); an admin resets it on the Users page.
- Notes cannot be edited, created or deleted in the browser (by design for v1; goo writes them through sync).
- Keyboard/screen-reader support relies on native elements and has not been audited with assistive technology.
