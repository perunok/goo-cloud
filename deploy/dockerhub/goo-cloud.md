# goo cloud

Self-hosted sync and sharing server for [goo](https://github.com/perunok/goo), the local-first Markdown editor: keep a folder
of notes in sync between your devices and share it with others (owner, admin, editor, viewer).

One image: the API (Node.js 22, Fastify 5, Prisma, PostgreSQL 16) plus the web dashboard at `/` (sign-in, workspaces, read-only
notes, members, devices, desktop sign-in approval; users and audit log for admins). It needs a PostgreSQL database; for HTTPS
put a reverse proxy in front. The Docker Compose setup below starts all three. MIT licensed. Source, issues and docs:
[github.com/perunok/goo-cloud](https://github.com/perunok/goo-cloud).

Also published as `ghcr.io/perunok/goo-cloud`.

## Tags

| Tag | Meaning |
|---|---|
| `X.Y.Z` (e.g. `0.1.0`) | one exact release |
| `X.Y` (e.g. `0.1`) | newest patch release of that minor version, **recommended** |
| `latest` | newest release |

Every tag is multi-arch: `linux/amd64` and `linux/arm64`.

## Quick start (Docker Compose)

```bash
mkdir goo-cloud && cd goo-cloud
V=0.1.0   # the release to run
curl -fsSLO https://raw.githubusercontent.com/perunok/goo-cloud/v$V/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/perunok/goo-cloud/v$V/.env.example -o .env
mkdir deploy
curl -fsSL  https://raw.githubusercontent.com/perunok/goo-cloud/v$V/deploy/Caddyfile -o deploy/Caddyfile
```

Edit `.env`; compose refuses to start until the required values are set (there are no default secrets):

```env
POSTGRES_PASSWORD=...        # openssl rand -hex 24
GOO_SIGNING_SECRET=...       # openssl rand -hex 32
GOO_ADMIN_BOOTSTRAP='[{"email":"you@example.com","password":"a-long-passphrase","display_name":"You","platform_role":"super_admin"}]'
GOO_IMAGE=perunok/goo-cloud:0.1
GOO_BASE_URL=http://your-host
```

```bash
docker compose pull
docker compose up -d --no-build
```

Open `GOO_BASE_URL`, sign in with the bootstrap account, create users and workspaces. In goo, open Settings > goo cloud, enter the
same URL and approve the code it shows on the dashboard's "Desktop sign-in" page.

For HTTPS (automatic Let's Encrypt via Caddy), backups and upgrades see
[deploy-manual.md](https://github.com/perunok/goo-cloud/blob/main/deploy-manual.md).

## Running the image directly

```bash
docker run -d -p 8080:8080 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgresql://goo:secret@db:5432/goo \
  -e GOO_SIGNING_SECRET=$(openssl rand -hex 32) \
  -e GOO_ADMIN_BOOTSTRAP='[{"email":"you@example.com","password":"a-long-passphrase","display_name":"You","platform_role":"super_admin"}]' \
  -e GOO_BASE_URL=https://cloud.example.com \
  perunok/goo-cloud:0.1
```

The container applies database migrations on start (`GOO_SKIP_MIGRATIONS=1` skips that), listens on 8080, runs as the
unprivileged `node` user and has a health check on `/healthz`. All settings: `server/README.md` in the repository.
