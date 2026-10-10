import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import AccountPage from './AccountPage.svelte';
import { session } from '../lib/state/session.svelte';
import { stubApi, user } from '../test/helpers';

const device = (id: string, name: string) => ({
  id, device_name: name, platform: 'linux', app_version: '0.4.0', created_at: '2026-10-01T10:00:00Z', last_seen_at: '2026-10-09T10:00:00Z',
});

describe('Account: devices', () => {
  it('lists the devices newest first and signs one out after confirmation', async () => {
    session.user = user();
    const calls = stubApi((r) => {
      if (r.method === 'GET' && r.path === '/me/devices') {
        return { json: { items: [device('d1', 'Laptop'), device('d2', 'Desktop')], page: { next_cursor: null, has_more: false } } };
      }
      if (r.method === 'DELETE' && r.path === '/me/devices/d1') return { json: { ok: true } };
    });
    render(AccountPage);
    const row = (await screen.findByText('Laptop')).closest('tr')!;
    expect(within(row).getByText('0.4.0')).toBeInTheDocument();
    expect(calls[0]!.query.get('order')).toBe('desc');
    const ev = userEvent.setup();
    await ev.click(within(row).getByRole('button', { name: 'Sign out Laptop' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await ev.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Laptop')).toBeNull());
    expect(screen.getByText('Desktop')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/me/devices/d1')).toBe(true);
  });

  it('empty list explains where devices come from', async () => {
    session.user = user();
    stubApi(() => ({ json: { items: [], page: { next_cursor: null, has_more: false } } }));
    render(AccountPage);
    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
  });
});
