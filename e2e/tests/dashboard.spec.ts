import { randomUUID } from 'node:crypto';
import { expect, request as pwRequest, test, type Page } from '@playwright/test';
import {
  apiCall,
  apiLogin,
  bearer,
  env,
  PASSWORD,
  person,
  run,
  startDeviceSignIn,
  toast,
  uiLogin,
  type ApiSession,
  type DeviceSession
} from './helpers';

// One serial story through the real dashboard, real API and real PostgreSQL. Later tests build on earlier ones.
test.describe.configure({ mode: 'serial' });

const alice = person('alice'); // plain user, later platform admin and back
const bob = person('bob'); // editor in the workspace; signs in the "desktop app" and pushes notes
const vic = person('vic'); // viewer in the workspace
const gina = person('gina'); // added before she has an account
const wsName = `Team notes ${run}`;
let wsId = '';
let adminApi: ApiSession;
/** Bob's goo desktop app, signed in through the device flow in the device-approval test. */
let bobDevice: DeviceSession;

const NOTE_PLAN = [
  '# Release plan',
  '',
  'Ship **on Friday**. See [the docs](https://example.com/docs).',
  '',
  '- [x] sync engine',
  '- [ ] changelog',
  '',
  '<script>window.__pwned = 1</script>',
  '<img src="x" onerror="window.__pwned = 1">',
  '![remote image](https://example.com/should-not-load.png)',
  '',
  '| Area | Owner |',
  '| --- | --- |',
  '| Sync | Bob |'
].join('\n');

test.beforeAll(async () => {
  adminApi = await apiLogin(env.admin.email, env.admin.password);
});

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
}

/** Collects CSP violations and page errors for the lifetime of the page. */
function watchViolations(page: Page) {
  const violations: string[] = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && violations.push(m.text()));
  page.on('pageerror', (e) => violations.push(e.message));
  return violations;
}

test('login: wrong password is rejected, correct one shows the overview with real counters', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('goo cloud');
  await page.getByLabel('Email').fill(env.admin.email);
  await page.getByLabel('Password').fill('definitely-wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.');

  await page.getByLabel('Password').fill(env.admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  for (const card of ['Users', 'Workspaces', 'Notes', 'Devices', 'Active sessions']) {
    await expect(page.locator('.card.stat', { hasText: card }).first()).toBeVisible();
  }
  await expect(page.getByText('Platform health').locator('..').getByText('Ok')).toBeVisible();
  await expect(page.getByText('postgres')).toBeVisible();

  // A reload restores the session from the cookie and re-derives the CSRF token (nothing in web storage).
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
  expect(stored.toLowerCase()).not.toContain('csrf');
});

test('bundled dashboard: served by the API server under its CSP', async ({ page }) => {
  const violations = watchViolations(page);
  const res = await page.goto('/');
  expect(new URL(page.url()).origin).toBe(new URL(env.api).origin);
  expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(res?.headers()['cache-control']).toBe('no-cache');
  const cfg = await page.request.get('/runtime-config.js');
  expect(await cfg.text()).toContain('window.__GOO_API_BASE_URL__ = "/api"');
  await uiLogin(page, env.admin.email, env.admin.password);
  await page.getByRole('link', { name: 'Users' }).first().click();
  await expect(page).toHaveURL(/#\/users/);
  expect(violations).toEqual([]);
});

test('admin users page: create users, change a platform role (super admin) and see it persist', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, '/#/users');
  for (const u of [alice, bob, vic]) {
    await page.getByRole('button', { name: 'Create user' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Email').fill(u.email);
    await dlg.getByLabel('Display name').fill(u.display_name);
    await dlg.getByLabel('Set a password manually').check();
    await dlg.getByLabel('Initial password').fill(u.password);
    // these accounts are used right away by later tests, so no forced change (default is on)
    await dlg.getByLabel('Require a password change at first sign-in').uncheck();
    await dlg.getByRole('button', { name: 'Create user' }).click();
    await expect(toast(page, 'User created')).toBeVisible();
    await expect(page.getByText(u.email, { exact: true })).toBeVisible();
  }
  // duplicate email -> 409 shown in the dialog
  const dlg = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Create user' }).click();
  await dlg.getByLabel('Email').fill(alice.email);
  await dlg.getByLabel('Display name').fill('Dup');
  await dlg.getByLabel('Set a password manually').check();
  await dlg.getByLabel('Initial password').fill(PASSWORD);
  await dlg.getByRole('button', { name: 'Create user' }).click();
  await expect(dlg.getByRole('alert')).toContainText(/already exists/i);
  await dlg.getByRole('button', { name: 'Cancel' }).click();

  const sel = page.getByLabel(`Platform role for ${alice.email}`);
  await sel.selectOption('platform_admin');
  await expect(toast(page, `${alice.email} is now Platform admin`)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(`Platform role for ${alice.email}`)).toHaveValue('platform_admin');
  await page.getByLabel(`Platform role for ${alice.email}`).selectOption('user');
  await expect(toast(page, `${alice.email} is now User`)).toBeVisible();
  // the super admin can never be assigned or changed
  await expect(page.getByLabel(`Platform role for ${env.admin.email}`)).toHaveCount(0);
  expect(await page.getByLabel(`Platform role for ${alice.email}`).locator('option').allTextContents()).toEqual(['User', 'Platform admin']);
});

test('temporary password: shown once, forces a new password, desktop sign-in refused until then', async ({ page, browser }) => {
  const frank = person('frank');
  await uiLogin(page, env.admin.email, env.admin.password, '/#/users');
  await page.getByRole('button', { name: 'Create user' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Generate a temporary password')).toBeChecked();
  await dlg.getByLabel('Email').fill(frank.email);
  await dlg.getByLabel('Display name').fill(frank.display_name);
  await dlg.getByRole('button', { name: 'Create user' }).click();
  const temp = (await dlg.getByLabel('Temporary password', { exact: true }).textContent())!.trim();
  expect(temp.length).toBeGreaterThanOrEqual(16);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(temp)).toHaveCount(0);

  // the server's own /device page refuses the temporary password for a desktop sign-in
  const flow = await startDeviceSignIn('frank laptop');
  const refused = await flow.anon.post('/device', { form: { user_code: flow.user_code, email: frank.email, password: temp } });
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toContain('must be changed before you can sign in to the desktop app');

  const ctx = await browser.newContext({ baseURL: env.ui });
  const fp = await ctx.newPage();
  await fp.goto('/#/workspaces');
  await fp.getByLabel('Email').fill(frank.email);
  await fp.getByLabel('Password').fill(temp);
  await fp.getByRole('button', { name: 'Sign in' }).click();
  await expect(fp.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await expect(fp.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await fp.getByLabel('Temporary password').fill(temp);
  await fp.getByLabel('New password', { exact: true }).fill(frank.password);
  await fp.getByLabel('Confirm new password').fill(frank.password);
  await fp.getByRole('button', { name: 'Set new password' }).click();
  await expect(fp.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(fp).toHaveURL(/#\/workspaces$/);
  await ctx.close();
});

test('workspaces: create one (slug derived by the server); a duplicate slug is refused', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, '/#/workspaces');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill(wsName);
  await dlg.getByLabel('Description').fill('Shared notes folder');
  await dlg.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { level: 1, name: wsName })).toBeVisible();
  wsId = new URL(page.url()).hash.split('/')[2]!;
  expect(wsId).toMatch(/[0-9a-f-]{36}/);
  const slug = (await (await adminApi.ctx.get(`/v1/workspaces/${wsId}`)).json()).workspace.slug as string;
  expect(slug).toMatch(new RegExp(`^team-notes-${run}-[0-9a-f]{4}$`));
  await expect(page.getByText('Your role: Owner')).toBeVisible();

  await page.getByRole('link', { name: '← All workspaces' }).click();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill(`Other ${run}`);
  await dlg.getByLabel('Slug (optional)').fill(slug);
  await dlg.getByRole('button', { name: 'Create workspace' }).click();
  await expect(dlg.getByText('This slug is already taken.')).toBeVisible();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('row', { name: new RegExp(wsName) })).toBeVisible();
});

test('members: add existing accounts with a role, a pending email joins when its account is created, role change', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, `/#/workspaces/${wsId}/members`);
  const add = async (email: string, role: 'editor' | 'viewer' | 'admin') => {
    await page.getByRole('button', { name: 'Add member' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Email').fill(email);
    await dlg.getByLabel('Role').selectOption(role);
    await dlg.getByRole('button', { name: 'Add member' }).click();
    await expect(dlg).toHaveCount(0);
  };

  await add(bob.email, 'viewer');
  await expect(toast(page, `Added ${bob.email}. The workspace now shows in their dashboard and in goo.`)).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(bob.email) })).toBeVisible();
  const bobApi = await apiLogin(bob.email, bob.password);
  const bobList = await (await bobApi.ctx.get('/v1/workspaces')).json();
  expect(bobList.items.find((w: { id: string }) => w.id === wsId)).toMatchObject({ role: 'viewer', added_by: { display_name: 'E2E Super' } });

  await page.getByLabel(`Role for ${bob.display_name}`).selectOption('editor');
  await expect(toast(page, `${bob.display_name} is now Editor`)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(`Role for ${bob.display_name}`)).toHaveValue('editor');
  await expect(page.getByLabel('Role for E2E Super')).toHaveCount(0); // the owner row is locked

  await add(vic.email, 'viewer');
  await expect(page.getByRole('row', { name: new RegExp(vic.email) })).toBeVisible();

  // gina has no account yet: she waits, and joins as soon as an admin creates her account
  await add(gina.email, 'editor');
  const waiting = page.locator('section', { has: page.getByRole('heading', { name: 'Waiting for an account' }) });
  await expect(waiting.getByRole('row', { name: new RegExp(gina.email) })).toBeVisible();
  // a second pending email is cancelled again
  const nobody = `nobody-${run}@example.test`;
  await add(nobody, 'viewer');
  await waiting.getByRole('button', { name: `Remove ${nobody}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(waiting.getByRole('row', { name: new RegExp(nobody) })).toHaveCount(0);

  const created = await apiCall(adminApi, 'POST', '/admin/users', { email: gina.email, display_name: gina.display_name, password: gina.password });
  expect(created.status()).toBe(201);
  await page.reload();
  await expect(page.getByRole('row', { name: new RegExp(gina.email) })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for an account' })).toHaveCount(0);
});

test('desktop sign-in: a code opened while signed out is approved after signing in; the app gets tokens', async ({ page }) => {
  const flow = await startDeviceSignIn('Bob laptop');
  expect(flow.verification_uri).toBe(`${env.api}/device`);
  expect((await flow.poll()).status).toBe('pending');

  // bob follows the dashboard link with the code, signs in, lands on the approval page with the code filled in
  await page.goto(`/#/device?code=${encodeURIComponent(flow.user_code)}`);
  await page.getByLabel('Email').fill(bob.email);
  await page.getByLabel('Password').fill(bob.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desktop sign-in' })).toBeVisible();
  const code = page.getByLabel('Code shown by the goo app');
  await expect(code).toHaveValue(flow.user_code);
  expect((await flow.poll()).status).toBe('pending'); // nothing is approved without a click
  await page.getByRole('button', { name: 'Approve sign-in' }).click();
  await expect(page.getByTestId('device-approved')).toContainText(flow.user_code);

  const approved = await flow.poll();
  expect(approved).toMatchObject({ status: 'approved', user: { email: bob.email } });
  bobDevice = { ctx: await bearer(approved.access_token), accessToken: approved.access_token, refreshToken: approved.refresh_token };

  // the same code cannot be approved twice
  await code.fill(flow.user_code);
  await page.getByRole('button', { name: 'Approve sign-in' }).click();
  await expect(page.getByRole('alert')).toContainText('unknown, has expired or was already used');

  // the app registers for sync; the device shows up on the account page
  const reg = await bobDevice.ctx.post('/v1/sync/clients/register', { data: { device_name: 'Bob laptop', platform: 'linux', app_version: '0.5.0-e2e' } });
  expect(reg.status()).toBe(201);
  bobDevice.clientId = (await reg.json()).client_id;
  await page.getByRole('link', { name: 'Account > Devices' }).click();
  const row = page.getByRole('row', { name: /Bob laptop/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('0.5.0-e2e');
});

test('notes: pushed by the desktop app through sync, listed in the Notes tab and shown read-only and safely', async ({ page }) => {
  const planId = randomUUID();
  const push = await bobDevice.ctx.post(`/v1/workspaces/${wsId}/sync/push`, {
    data: {
      client_id: bobDevice.clientId,
      changes: [
        { op_id: randomUUID(), note_id: planId, op: 'upsert', base_version: 0, path: 'release-plan.md', content: NOTE_PLAN },
        { op_id: randomUUID(), note_id: randomUUID(), op: 'upsert', base_version: 0, path: 'projects/sync/design.md', content: '# Design\n\nPull, then push.\n' },
        { op_id: randomUUID(), note_id: randomUUID(), op: 'upsert', base_version: 0, path: 'inbox.md', content: 'plain line\n' }
      ]
    }
  });
  expect(push.status()).toBe(200);
  const pushed = await push.json();
  expect(pushed.rejected).toEqual([]);
  expect(pushed.accepted).toHaveLength(3);

  const violations = watchViolations(page);
  await uiLogin(page, env.admin.email, env.admin.password, `/#/workspaces/${wsId}/notes`);
  const list = page.locator('tbody');
  await expect(list.getByRole('link', { name: 'release-plan.md' })).toBeVisible();
  await expect(list.getByRole('link', { name: 'projects/sync/design.md' })).toBeVisible();
  await expect(page.getByRole('row', { name: /release-plan\.md/ })).toContainText(`by ${bob.display_name}`);

  // server-side search by path
  await page.getByLabel('Search notes by path').fill('sync/');
  await expect(list.getByRole('link', { name: 'inbox.md' })).toHaveCount(0);
  await expect(list.getByRole('link', { name: 'projects/sync/design.md' })).toBeVisible();
  await page.getByLabel('Search notes by path').fill('');
  await expect(list.getByRole('link', { name: 'inbox.md' })).toBeVisible();

  await list.getByRole('link', { name: 'release-plan.md' }).click();
  await expect(page).toHaveURL(new RegExp(`#/workspaces/${wsId}/notes/${planId}$`));
  const article = page.getByRole('article', { name: 'Note content' });
  await expect(article.getByRole('heading', { level: 1, name: 'Release plan' })).toBeVisible();
  await expect(article.locator('strong')).toHaveText('on Friday');
  await expect(article.getByRole('checkbox')).toHaveCount(2);
  await expect(article.locator('table td').first()).toHaveText('Sync');
  const link = article.getByRole('link', { name: 'the docs' });
  await expect(link).toHaveAttribute('href', 'https://example.com/docs');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  // raw HTML is text, remote images are not loaded
  await expect(article).toContainText('<script>window.__pwned = 1</script>');
  await expect(article.locator('script, img')).toHaveCount(0);
  await expect(article.getByRole('link', { name: 'Image: remote image' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

  await page.getByRole('button', { name: 'Plain text' }).click();
  await expect(article.locator('pre')).toHaveText(NOTE_PLAN);
  await page.getByRole('link', { name: `← Notes of ${wsName}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/workspaces/${wsId}/notes$`));

  // the dashboard shows what sync stored: an update and a delete from the app appear after a reload
  const update = await bobDevice.ctx.post(`/v1/workspaces/${wsId}/sync/push`, {
    data: { client_id: bobDevice.clientId, changes: [{ op_id: randomUUID(), note_id: planId, op: 'upsert', base_version: 1, path: 'archive/release-plan.md' }] }
  });
  expect((await update.json()).accepted).toHaveLength(1);
  await page.reload();
  await expect(list.getByRole('link', { name: 'archive/release-plan.md' })).toBeVisible();
  expect(violations).toEqual([]);
});

test('CSP: no violations on any page, including the note view', async ({ page }) => {
  const violations = watchViolations(page);
  await uiLogin(page, env.admin.email, env.admin.password, '/');
  for (const path of ['/', '/#/users', '/#/workspaces', `/#/workspaces/${wsId}`, `/#/workspaces/${wsId}/notes`, `/#/workspaces/${wsId}/members`, `/#/workspaces/${wsId}/audit`, '/#/audit', '/#/account', '/#/device']) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeVisible();
  }
  await page.goto(`/#/workspaces/${wsId}/notes`);
  await page.locator('tbody a').first().click();
  await expect(page.getByRole('article', { name: 'Note content' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(violations).toEqual([]);
});

test('role-based UI: a viewer reads notes but cannot manage anything; the server agrees', async ({ page }) => {
  await uiLogin(page, vic.email, vic.password, '/');
  // no platform pages; non-admins land on their workspaces
  await expect(page).toHaveURL(/#\/workspaces$/);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Workspaces', 'Desktop sign-in']);
  await expect(page.getByRole('row', { name: new RegExp(wsName) })).toContainText('Viewer');
  await expect(page.getByRole('button', { name: `Delete ${wsName}` })).toBeDisabled();

  await page.goto(`/#/workspaces/${wsId}`);
  await expect(page.getByText('Your role: Viewer')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('link')).toHaveText(['Overview', 'Notes', 'Members']);
  await expect(page.getByRole('region', { name: 'Settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Transfer ownership' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete workspace' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leave workspace' })).toBeVisible();

  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await page.getByRole('link', { name: 'inbox.md' }).click();
  await expect(page.getByRole('article', { name: 'Note content' })).toContainText('plain line');

  await page.goto(`/#/workspaces/${wsId}/members`);
  await expect(page.getByRole('row', { name: new RegExp(bob.email) })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add member' })).toHaveCount(0);
  await expect(page.locator('tbody select')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(page.getByText(/only the workspace owner, its admins or a platform admin/i)).toBeVisible();
  await page.goto(`/#/workspaces/${wsId}/audit`);
  await expect(page.getByText('Your role does not include access to this section.')).toBeVisible();
  await page.goto('/#/users');
  await expect(page.getByText('Not available for your role')).toBeVisible();

  // the server enforces the same: no settings change, no member management, and every pushed change is refused
  const vicApi = await apiLogin(vic.email, vic.password);
  expect((await apiCall(vicApi, 'PATCH', `/workspaces/${wsId}`, { name: 'hax', version: 1 })).status()).toBe(403);
  expect((await apiCall(vicApi, 'POST', `/workspaces/${wsId}/members`, { email: alice.email, role: 'viewer' })).status()).toBe(403);
  const reg = await apiCall(vicApi, 'POST', '/sync/clients/register', { device_name: 'vic box', platform: 'linux', app_version: 'e2e' });
  const push = await apiCall(vicApi, 'POST', `/workspaces/${wsId}/sync/push`, {
    client_id: (await reg.json()).client_id,
    changes: [{ op_id: randomUUID(), note_id: randomUUID(), op: 'upsert', base_version: 0, path: 'vic.md', content: 'x' }]
  });
  expect((await push.json()).rejected[0].reason).toBe('forbidden');
});

test('a workspace admin manages editors and viewers but not the owner; transfer and leave', async ({ page }) => {
  // the owner makes bob an admin, then hands the workspace over to him
  await uiLogin(page, env.admin.email, env.admin.password, `/#/workspaces/${wsId}/members`);
  await page.getByLabel(`Role for ${bob.display_name}`).selectOption('admin');
  await expect(toast(page, `${bob.display_name} is now Admin`)).toBeVisible();
  await signOut(page);

  await uiLogin(page, bob.email, bob.password, `/#/workspaces/${wsId}/members`);
  await expect(page.getByLabel(`Role for ${vic.display_name}`)).toBeEnabled();
  await expect(page.getByLabel('Role for E2E Super')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove E2E Super' })).toBeDisabled();
  await page.getByLabel(`Role for ${gina.display_name}`).selectOption('viewer');
  await expect(toast(page, `${gina.display_name} is now Viewer`)).toBeVisible();
  await signOut(page);

  await uiLogin(page, env.admin.email, env.admin.password, `/#/workspaces/${wsId}`);
  await page.getByRole('button', { name: 'Transfer ownership' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('New owner').selectOption({ label: `${bob.display_name} (${bob.email})` });
  await dlg.getByRole('button', { name: 'Transfer ownership' }).click();
  await expect(toast(page, `${bob.display_name} now owns ${wsName}`)).toBeVisible();
  await expect(page.getByText('Your role: Admin')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Transfer ownership' })).toBeVisible(); // still offered: super admin
  const ws = (await (await adminApi.ctx.get(`/v1/workspaces/${wsId}`)).json()).workspace;
  const bobId = (await (await adminApi.ctx.get(`/v1/admin/users?q=${encodeURIComponent(bob.email)}`)).json()).items[0].id;
  expect(ws.owner_user_id).toBe(bobId);
  await signOut(page);

  // vic leaves
  await uiLogin(page, vic.email, vic.password, `/#/workspaces/${wsId}`);
  await page.getByRole('button', { name: 'Leave workspace' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Leave workspace' }).click();
  await expect(page).toHaveURL(/#\/workspaces$/);
  await expect(page.locator('tbody').getByText(wsName)).toHaveCount(0);
});

test('devices: signing a device out stops its refresh token', async ({ page }) => {
  await uiLogin(page, bob.email, bob.password, '/#/account');
  const row = page.getByRole('row', { name: /Bob laptop/ });
  await row.getByRole('button', { name: 'Sign out Bob laptop' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(toast(page, 'Signed out Bob laptop')).toBeVisible();
  await expect(page.getByRole('row', { name: /Bob laptop/ })).toHaveCount(0);
  const anon = await pwRequest.newContext({ baseURL: env.api });
  expect((await anon.post('/v1/auth/refresh', { data: { refresh_token: bobDevice.refreshToken } })).status()).toBe(401);
});

test('audit logs: platform and workspace views with the action filter', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, '/#/audit');
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  await page.getByLabel('Action').selectOption('auth.device_approved');
  await expect(rows.first()).toContainText(bob.email);
  await page.getByLabel('Action').selectOption('device.signed_out');
  await expect(rows.first()).toContainText('Bob laptop');

  await page.goto(`/#/workspaces/${wsId}/audit`);
  await page.getByLabel('Action').selectOption('workspace.ownership_transferred');
  await expect(rows).toHaveCount(1);
  await page.getByLabel('Action').selectOption('member.added');
  await expect(rows).toHaveCount(2); // bob and vic (gina joined through her pending invite)
  await page.getByLabel('Action').selectOption('invite.accepted');
  await expect(rows).toHaveCount(1);
});

test('workspace delete needs the typed name (owner)', async ({ page }) => {
  await uiLogin(page, bob.email, bob.password, `/#/workspaces/${wsId}`);
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  const dlg = page.getByRole('dialog');
  const confirm = dlg.getByRole('button', { name: 'Delete workspace' });
  await expect(confirm).toBeDisabled();
  await dlg.getByLabel(/Type .* to confirm/).fill(wsName);
  await confirm.click();
  await expect(page).toHaveURL(/#\/workspaces$/);
  await expect(page.locator('tbody').getByText(wsName)).toHaveCount(0);
  const gone = await adminApi.ctx.get(`/v1/workspaces/${wsId}`);
  expect([403, 404]).toContain(gone.status());
});

test('logout ends the server session', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, '/');
  const session = (await page.context().cookies()).find((c) => c.name === 'goo_session')!;
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Lax');
  await signOut(page);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const replay = await pwRequest.newContext({ baseURL: env.api, extraHTTPHeaders: { cookie: `goo_session=${session.value}` } });
  expect((await replay.get('/v1/auth/browser/session')).status()).toBe(401);
});

test('cross-origin dashboard (CORS allowlist + credentials + CSRF)', async ({ page, request }) => {
  await uiLogin(page, env.admin.email, env.admin.password, env.uiCrossOrigin + '/');
  const apiRequests: string[] = [];
  page.on('request', (r) => r.url().startsWith(env.api) && apiRequests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.goto(env.uiCrossOrigin + '/#/users');
  await page.getByLabel(`Platform role for ${alice.email}`).selectOption('platform_admin');
  await expect(toast(page, `${alice.email} is now Platform admin`)).toBeVisible();
  await page.getByLabel(`Platform role for ${alice.email}`).selectOption('user');
  await expect(toast(page, `${alice.email} is now User`)).toBeVisible();
  expect(apiRequests.some((r) => r.startsWith('PATCH /v1/admin/users/'))).toBe(true);

  const evil = await request.fetch(`${env.api}/v1/admin/users`, {
    method: 'OPTIONS',
    headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' }
  });
  expect(evil.status()).toBe(403);
  const ok = await request.fetch(`${env.api}/v1/admin/users`, {
    method: 'OPTIONS',
    headers: { origin: env.uiCrossOrigin, 'access-control-request-method': 'POST' }
  });
  expect(ok.status()).toBe(204);
  expect(ok.headers()['access-control-allow-origin']).toBe(env.uiCrossOrigin);
});
