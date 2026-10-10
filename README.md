# goo cloud

Sync and sharing for [goo](https://github.com/perunok/goo), the local-first Markdown editor: keep a folder of notes
in sync between your devices and share it with others (owner, admin, editor, viewer). Self-hosted, MIT licensed.
Modelled on [Slinger Cloud](https://github.com/perunok/slinger-admin).

| Part | |
| --- | --- |
| [`server/`](server/README.md) | Fastify 5 + Prisma + PostgreSQL 16 API: accounts, device sign-in, workspaces, members, notes sync |
| [`docs/DESIGN.md`](docs/DESIGN.md) | How it works: data model, auth, the file-based sync protocol, lessons from Slinger Cloud |

Status: the server is in place; the dashboard, deployment files and the desktop side (in goo) are next.
