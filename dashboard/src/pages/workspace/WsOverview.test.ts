import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import WsOverview from './WsOverview.svelte';
import { session } from '../../lib/state/session.svelte';
import { toasts } from '../../lib/state/toasts.svelte';
import { stubApi, user } from '../../test/helpers';
import type { Workspace } from '../../lib/api/schemas';

const ws: Workspace = {
  id: 'w1', slug: 'acme', name: 'Acme', description: 'Team space', owner_user_id: 'owner-1',
  version: 4, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

describe('workspace settings form', () => {
  it('is offered to the owner and to platform admins only', () => {
    for (const [platform, role, shown] of [
      ['user', 'owner', true], ['platform_admin', null, true], ['super_admin', null, true],
      ['user', 'admin', false], ['user', 'editor', false], ['user', 'viewer', false],
    ] as const) {
      session.user = user({ platform_role: platform });
      const { unmount } = render(WsOverview, { props: { workspace: ws, role } });
      expect(!!screen.queryByRole('heading', { name: 'Settings' }), `${platform}/${role}`).toBe(shown);
      unmount();
    }
  });

  it('sends only the changed fields with the loaded version, and applies the server copy', async () => {
    session.user = user({ platform_role: 'user' });
    const updated = { ...ws, name: 'Acme Platform', description: 'Notes', version: 5 };
    const calls = stubApi((r) => (r.method === 'PATCH' && r.path === '/workspaces/w1' ? { json: { workspace: updated } } : undefined));
    const onupdate = vi.fn();
    render(WsOverview, { props: { workspace: ws, role: 'owner', onupdate } });
    const ev = userEvent.setup();
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled(); // nothing changed yet
    await ev.clear(screen.getByLabelText('Name'));
    await ev.type(screen.getByLabelText('Name'), 'Acme Platform');
    await ev.clear(screen.getByLabelText('Description'));
    await ev.type(screen.getByLabelText('Description'), 'Notes');
    await ev.click(save);
    await waitFor(() => expect(onupdate).toHaveBeenCalledWith(updated));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Acme Platform', description: 'Notes', version: 4 });
    expect(toasts.items.some((t) => /settings saved/i.test(t.message))).toBe(true);
  });

  it('validates the name client-side and sends nothing', async () => {
    session.user = user({ platform_role: 'user' });
    const calls = stubApi(() => ({ json: {} }));
    render(WsOverview, { props: { workspace: ws, role: 'owner' } });
    const ev = userEvent.setup();
    await ev.clear(screen.getByLabelText('Name'));
    await ev.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(calls.length).toBe(0);
  });

  it('a stale version shows the conflict message; "Load latest version" reloads and resets the form', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi(() => ({
      status: 409,
      json: { error: { code: 'version_mismatch', message: 'resource was modified by someone else', details: { current_version: 7 } } },
    }));
    let current = ws;
    const onreload = vi.fn(async () => {
      current = { ...ws, name: 'Renamed elsewhere', version: 7 };
      await view.rerender({ workspace: current, role: 'owner', onreload });
    });
    const view = render(WsOverview, { props: { workspace: current, role: 'owner', onreload } });
    const ev = userEvent.setup();
    await ev.clear(screen.getByLabelText('Name'));
    await ev.type(screen.getByLabelText('Name'), 'My edit');
    await ev.click(screen.getByRole('button', { name: 'Save settings' }));
    const alert = await screen.findByTestId('version-conflict');
    expect(alert).toHaveTextContent(/Someone else changed this workspace/);
    expect(alert).toHaveTextContent(/version 7/);
    expect(screen.getByLabelText('Name')).toHaveValue('My edit'); // the user's edit is not thrown away silently
    await ev.click(screen.getByRole('button', { name: 'Load latest version' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Renamed elsewhere'));
    expect(onreload).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('version-conflict')).toBeNull();
  });

  it('other server errors are shown in the form', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi(() => ({ status: 403, json: { error: { code: 'workspace_access_denied', message: 'You do not have access to this workspace.' } } }));
    render(WsOverview, { props: { workspace: ws, role: 'owner' } });
    const ev = userEvent.setup();
    await ev.type(screen.getByLabelText('Name'), ' 2');
    await ev.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('You do not have access to this workspace.')).toBeInTheDocument();
  });
});

describe('ownership, leaving and deleting', () => {
  it('offers transfer to the owner and the super admin, leave to non-owner members, delete to owner and super admin', () => {
    for (const [platform, role, transfer, leave, del] of [
      ['user', 'owner', true, false, true],
      ['super_admin', null, true, false, true],
      ['platform_admin', null, false, false, false],
      ['user', 'admin', false, true, false],
      ['user', 'viewer', false, true, false],
    ] as const) {
      session.user = user({ platform_role: platform });
      const { unmount } = render(WsOverview, { props: { workspace: ws, role } });
      const label = `${platform}/${role}`;
      expect(!!screen.queryByRole('button', { name: 'Transfer ownership' }), label).toBe(transfer);
      expect(!!screen.queryByRole('button', { name: 'Leave workspace' }), label).toBe(leave);
      expect(screen.getByRole('button', { name: 'Delete workspace' }).hasAttribute('disabled'), label).toBe(!del);
      unmount();
    }
  });

  it('transfers to the chosen member with the workspace version and reloads the role', async () => {
    session.user = user({ id: 'owner-1', platform_role: 'user' });
    const members = {
      items: [
        { id: 'm-own', user_id: 'owner-1', email: 'o@example.com', display_name: 'Olive', role: 'owner', status: 'active', version: 1 },
        { id: 'm-ed', user_id: 'u2', email: 'e@example.com', display_name: 'Eddie', role: 'editor', status: 'active', version: 1 },
      ],
      page: { next_cursor: null, has_more: false },
    };
    const calls = stubApi((r) => {
      if (r.method === 'GET' && r.path === '/workspaces/w1/members') return { json: members };
      if (r.method === 'POST' && r.path === '/workspaces/w1/transfer') return { json: { workspace: { ...ws, owner_user_id: 'u2', version: 5 } } };
    });
    const onreload = vi.fn();
    const onupdate = vi.fn();
    render(WsOverview, { props: { workspace: ws, role: 'owner', onreload, onupdate } });
    const ev = userEvent.setup();
    await ev.click(screen.getByRole('button', { name: 'Transfer ownership' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    const select = await within(dialog).findByLabelText('New owner');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Eddie (e@example.com)']);
    await ev.click(within(dialog).getByRole('button', { name: 'Transfer ownership' }));
    await waitFor(() => expect(onreload).toHaveBeenCalledOnce());
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ member_id: 'm-ed', version: 4 });
    expect(onupdate).toHaveBeenCalledWith(expect.objectContaining({ owner_user_id: 'u2', version: 5 }));
  });

  it('leaving asks for confirmation and calls POST /leave', async () => {
    session.user = user({ platform_role: 'user' });
    const calls = stubApi((r) => (r.method === 'POST' && r.path === '/workspaces/w1/leave' ? { json: { ok: true } } : undefined));
    render(WsOverview, { props: { workspace: ws, role: 'editor' } });
    const ev = userEvent.setup();
    await ev.click(screen.getByRole('button', { name: 'Leave workspace' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await ev.click(within(dialog).getByRole('button', { name: 'Leave workspace' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/workspaces/w1/leave')).toBe(true));
  });
});
