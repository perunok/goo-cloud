import { expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';

export const env = {
  ui: process.env.E2E_UI_URL!,
  uiCrossOrigin: process.env.E2E_UI_CROSS_ORIGIN_URL!,
  api: process.env.E2E_API_URL!,
  admin: { email: process.env.E2E_ADMIN_EMAIL!, password: process.env.E2E_ADMIN_PASSWORD! },
  padmin: { email: process.env.E2E_PADMIN_EMAIL!, password: process.env.E2E_PADMIN_PASSWORD! }
};

/** Unique per run so the suite can also be pointed at a reused database. */
export const run = Math.random().toString(36).slice(2, 8);
export const PASSWORD = 'e2e-user-passphrase-1';
export const person = (name: string) => ({
  email: `${name}-${run}@example.test`,
  display_name: `${name[0]!.toUpperCase()}${name.slice(1)} ${run}`,
  password: PASSWORD
});

export type ApiSession = { ctx: APIRequestContext; csrf: string; user: { id: string; email: string } };

/** Signs in through the real login endpoint (cookie jar + CSRF token), exactly like a browser client. */
export async function apiLogin(email: string, password: string): Promise<ApiSession> {
  const ctx = await pwRequest.newContext({ baseURL: env.api });
  const res = await ctx.post('/v1/auth/browser/login', { data: { email, password } });
  expect(res.status(), `login ${email}`).toBe(200);
  const body = await res.json();
  return { ctx, csrf: body.csrf_token, user: body.user };
}

export async function apiCall(s: ApiSession, method: 'POST' | 'PATCH' | 'DELETE', path: string, data?: unknown) {
  return s.ctx.fetch(`/v1${path}`, { method, data, headers: { 'x-csrf-token': s.csrf } });
}

/** What the goo desktop app holds after a device sign-in: Bearer tokens (no cookies, no CSRF). */
export type DeviceSession = { ctx: APIRequestContext; accessToken: string; refreshToken: string; clientId?: string };

/** Starts a desktop (device flow) sign-in like goo does; returns the codes shown to the user. */
export async function startDeviceSignIn(deviceName: string) {
  const anon = await pwRequest.newContext({ baseURL: env.api });
  const res = await anon.post('/v1/auth/device/start', { data: { client_name: 'goo', device_name: deviceName } });
  expect(res.status()).toBe(200);
  const start = (await res.json()) as { device_code: string; user_code: string; verification_uri: string };
  const poll = async () => (await anon.post('/v1/auth/device/poll', { data: { device_code: start.device_code } })).json();
  return { ...start, anon, poll };
}

export async function bearer(accessToken: string): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: env.api, extraHTTPHeaders: { authorization: `Bearer ${accessToken}` } });
}

export async function uiLogin(page: Page, email: string, password: string, url = '/') {
  await page.goto(url);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

export const toast = (page: Page, text: string | RegExp) => page.locator('.toast').getByText(text).first();
