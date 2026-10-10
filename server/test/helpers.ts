import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { PlatformRole, WorkspaceRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth/password.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { newId } from "../src/lib/ids.js";

export const PASSWORD = "Correct-Horse-Battery-9";
let passwordHash: Promise<string> | undefined;

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig(
    {
      NODE_ENV: "test",
      GOO_SIGNING_SECRET: process.env.GOO_SIGNING_SECRET,
      DATABASE_URL: process.env.DATABASE_URL,
      GOO_BASE_URL: "http://localhost:8080",
      ...env
    },
    { warn: () => undefined }
  );
}

export async function makeApp(env: Record<string, string> = {}) {
  const app = await buildApp({ config: testConfig(env), logger: false, validateResponses: true });
  await app.ready();
  return app;
}

let counter = 0;
export const uniq = (p = "u") => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export type TestUser = { id: string; email: string; role: PlatformRole; token: string };

export async function createUser(role: PlatformRole = "user", email = `${uniq()}@example.test`): Promise<TestUser> {
  passwordHash ??= hashPassword(PASSWORD);
  const u = await prisma.user.create({
    data: { id: newId(), email, displayName: `User ${email}`, passwordHash: await passwordHash, platformRole: role }
  });
  const token = await signAccessToken(process.env.GOO_SIGNING_SECRET!, { sub: u.id, platform_role: role }, 3600);
  return { id: u.id, email, role, token };
}

export const auth = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });

export type Req = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  url: string;
  as?: { token: string };
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
};

export async function call(app: FastifyInstance, r: Req): Promise<LightMyRequestResponse & { json: <T = any>() => T }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.inject({
    method: r.method,
    url: r.url,
    headers: { ...(r.as ? auth(r.as) : {}), ...(r.headers ?? {}) },
    cookies: r.cookies,
    payload: r.body as object | undefined
  }) as any;
}

/** Creates a workspace through the API as `owner`; optionally adds members with roles directly in the DB. */
export async function setupWorkspace(
  app: FastifyInstance,
  owner: TestUser,
  members: Array<{ user: TestUser; role: WorkspaceRole }> = []
): Promise<{ id: string; version: number }> {
  const res = await call(app, { method: "POST", url: "/v1/workspaces", as: owner, body: { name: `WS ${uniq()}` } });
  if (res.statusCode !== 201) throw new Error(`workspace create failed: ${res.body}`);
  const ws = res.json().workspace;
  for (const m of members) {
    await prisma.membership.create({ data: { id: newId(), workspaceId: ws.id, userId: m.user.id, role: m.role } });
  }
  return { id: ws.id, version: ws.version };
}

/** Registers a sync device for `u` and returns its client id. */
export async function registerClient(app: FastifyInstance, u: { token: string }, deviceName = "Laptop"): Promise<string> {
  const r = await call(app, {
    method: "POST", url: "/v1/sync/clients/register", as: u,
    body: { device_name: deviceName, platform: "linux", app_version: "0.4.0" }
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().client_id as string;
}

/** A push change with a fresh op id (override anything). */
export const change = <T extends Record<string, unknown>>(c: T) => ({ op_id: randomUUID() as string, base_version: 0, op: "upsert", ...c });

/** Pushes `changes` to a workspace as `u` with device `clientId`. */
export function push(app: FastifyInstance, u: { token: string }, wsId: string, clientId: string, changes: unknown[]) {
  return call(app, { method: "POST", url: `/v1/workspaces/${wsId}/sync/push`, as: u, body: { client_id: clientId, changes } });
}

/** Creates one note through sync push and returns its id. */
export async function makeNote(app: FastifyInstance, u: TestUser, wsId: string, path = `${uniq("n")}.md`, content = "hello") {
  const clientId = await registerClient(app, u);
  const id = randomUUID();
  const r = await push(app, u, wsId, clientId, [change({ note_id: id, path, content })]);
  if (r.statusCode !== 200 || r.json().accepted.length !== 1) throw new Error(r.body);
  return { id, path, version: 1 };
}
