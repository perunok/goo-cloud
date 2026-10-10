#!/usr/bin/env node
// One-command end-to-end run:  npm run e2e   (from the repo root)
//
//  1. PostgreSQL: a throwaway `postgres:16-alpine` container on a free port (removed afterwards),
//     or your own database when E2E_DATABASE_URL is set (CI uses a service container; unique test data, nothing is deleted).
//  2. `prisma migrate deploy`, a production build of the dashboard, then the real Fastify server serving that build at "/"
//     (as in the Docker image) with a bootstrap super admin + platform admin.
//  3. A second dashboard through the Vite dev server, configured for cross-origin CORS against the API.
//  4. Playwright (Chromium) drives the UI; everything is torn down again, also on Ctrl+C or failure.
//
// Container networking: on Linux the database container uses the host network and listens on 127.0.0.1:<free port>
// (`-c port=... -c listen_addresses=127.0.0.1`), which avoids Docker's port publishing. Set E2E_PG_PUBLISH=1 to publish a
// port with `-p` instead (Docker Desktop on macOS/Windows, where host networking is not the host's loopback).
// Extra arguments are passed to `playwright test` (e.g. `npm run e2e -- -g notes`).
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (dir, name) => join(root, dir, 'node_modules', '.bin', name);
const children = [];
let container = null;
let cleaningUp = false;

const log = (m) => console.log(`[e2e] ${m}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const tail = [];
  const keep = (b) => {
    if (process.env.E2E_STREAM_LOGS && name === 'server') process.stdout.write(String(b));
    tail.push(...String(b).split('\n').filter(Boolean));
    if (tail.length > 40) tail.splice(0, tail.length - 40);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.tail = tail;
  child.name = name;
  children.push(child);
  return child;
}

async function waitFor(what, fn, timeoutMs = 60_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

const httpOk = async (url) => (await fetch(url)).ok;

function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  if (container) {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    log(`removed container ${container}`);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

async function startPostgres() {
  if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('Docker is not available. Start Docker or set E2E_DATABASE_URL to a PostgreSQL URL.');
  }
  const pgPort = await freePort();
  container = `goo-cloud-e2e-pg-${process.pid}`;
  const publish = process.env.E2E_PG_PUBLISH === '1' || process.platform !== 'linux';
  const net = publish ? ['-p', `127.0.0.1:${pgPort}:5432`] : ['--network', 'host'];
  const pgArgs = publish ? [] : ['-c', `port=${pgPort}`, '-c', 'listen_addresses=127.0.0.1'];
  const r = spawnSync('docker', [
    'run', '-d', '--rm', '--name', container, ...net,
    '-e', 'POSTGRES_PASSWORD=e2e', '-e', 'POSTGRES_DB=goo_e2e', '--tmpfs', '/var/lib/postgresql/data',
    'postgres:16-alpine', ...pgArgs
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not start postgres: ${r.stderr}`);
  log(`postgres ${container} on 127.0.0.1:${pgPort}${publish ? ' (published)' : ' (host network)'}`);
  const inner = publish ? '5432' : String(pgPort);
  await waitFor('postgres', () => spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-p', inner, '-U', 'postgres'], { stdio: 'ignore' }).status === 0, 60_000);
  await new Promise((r) => setTimeout(r, 1500)); // the image restarts postgres once after init
  return `postgresql://postgres:e2e@127.0.0.1:${pgPort}/goo_e2e`;
}

async function main() {
  // ---------------------------------------------------------------- database
  const databaseUrl = process.env.E2E_DATABASE_URL || (await startPostgres());
  const serverEnv = { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'development' };
  // The image restarts postgres once after init; retry the first connection for a while.
  let mig;
  for (let attempt = 0; attempt < 10; attempt++) {
    mig = spawnSync(bin('server', 'prisma'), ['migrate', 'deploy'], { cwd: join(root, 'server'), env: serverEnv, encoding: 'utf8' });
    if (mig.status === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (mig.status !== 0) throw new Error(`prisma migrate deploy failed:\n${mig.stdout}\n${mig.stderr}`);
  log('migrations applied');

  // The server serves this build, like the Docker image does.
  const build = spawnSync(bin('dashboard', 'vite'), ['build'], { cwd: join(root, 'dashboard'), encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`dashboard build failed:\n${build.stdout}\n${build.stderr}`);
  log('dashboard built');

  // ---------------------------------------------------------------- ports / credentials
  const [apiPort, xoPort] = [await freePort(), await freePort()];
  const api = `http://localhost:${apiPort}`;
  // The bundled dashboard: same origin as the API.
  const ui = api;
  const uiCrossOrigin = `http://localhost:${xoPort}`;
  const admin = { email: 'e2e-super@example.test', password: 'e2e-super-passphrase-1' };
  const padmin = { email: 'e2e-padmin@example.test', password: 'e2e-padmin-passphrase-1' };

  // ---------------------------------------------------------------- server
  const server = start('server', bin('server', 'tsx'), ['src/index.ts'], {
    cwd: join(root, 'server'),
    env: {
      ...serverEnv,
      PORT: String(apiPort),
      GOO_HOST: '127.0.0.1',
      GOO_SIGNING_SECRET: 'e2e-signing-secret-that-is-long-enough-0123456789',
      GOO_BASE_URL: api,
      GOO_ALLOWED_ORIGINS: uiCrossOrigin,
      GOO_LOG_LEVEL: process.env.E2E_SERVER_LOG_LEVEL ?? 'warn',
      // Every test signs in fresh; the default 10 attempts / 5 min per IP+email would trip (covered by server tests).
      GOO_LOGIN_RATE_MAX: '500',
      GOO_DASHBOARD_DIR: join(root, 'dashboard', 'dist'),
      GOO_ADMIN_BOOTSTRAP: JSON.stringify([
        { email: admin.email, password: admin.password, display_name: 'E2E Super', platform_role: 'super_admin' },
        { email: padmin.email, password: padmin.password, display_name: 'E2E Platform', platform_role: 'platform_admin' }
      ])
    }
  });
  await waitFor('server /healthz', () => httpOk(`${api}/healthz`), 90_000).catch((e) => {
    throw new Error(`${e.message}\n${server.tail.join('\n')}`);
  });
  log(`server on ${api}`);

  // ---------------------------------------------------------------- cross-origin dashboard
  // Same dashboard through the Vite dev server, talking to the API directly from another origin (CORS + cookies + CSRF).
  const xoProc = start(`dashboard:${xoPort}`, bin('dashboard', 'vite'), ['--port', String(xoPort), '--strictPort', '--host', 'localhost'], {
    cwd: join(root, 'dashboard'),
    env: { ...process.env, VITE_API_BASE_URL: api }
  });
  await waitFor(`dashboard ${uiCrossOrigin}`, () => httpOk(uiCrossOrigin), 60_000).catch((e) => {
    throw new Error(`${e.message}\n${xoProc.tail.join('\n')}`);
  });
  log(`dashboard on ${ui} (served by the server) and ${uiCrossOrigin} (cross-origin)`);

  // ---------------------------------------------------------------- playwright
  const args = ['test', ...process.argv.slice(2)];
  const pw = spawn(bin('e2e', 'playwright'), args, {
    cwd: join(root, 'e2e'),
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_UI_URL: ui,
      E2E_UI_CROSS_ORIGIN_URL: uiCrossOrigin,
      E2E_API_URL: api,
      E2E_ADMIN_EMAIL: admin.email,
      E2E_ADMIN_PASSWORD: admin.password,
      E2E_PADMIN_EMAIL: padmin.email,
      E2E_PADMIN_PASSWORD: padmin.password
    }
  });
  const code = await new Promise((resolve) => pw.on('exit', (c) => resolve(c ?? 1)));
  if (code !== 0) {
    log('server log tail:');
    console.log(server.tail.slice(-15).join('\n'));
  }
  return code;
}

let exit = 1;
try {
  exit = await main();
} catch (e) {
  console.error(`[e2e] ${e.message}`);
} finally {
  cleanup();
}
process.exit(exit);
