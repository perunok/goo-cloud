import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import DevicePage from './DevicePage.svelte';
import { session } from '../lib/state/session.svelte';
import { client } from '../lib/api';
import { stubApi, user } from '../test/helpers';

describe('Desktop sign-in approval', () => {
  it('pre-fills the code from the link but only approves on click, with the CSRF token', async () => {
    session.user = user({ email: 'me@example.com' });
    client.setCsrfToken('c1');
    const calls = stubApi((r) => (r.path === '/auth/device/approve' ? { json: { ok: true } } : undefined));
    render(DevicePage, { props: { code: 'abcd-efgh' } });
    expect(screen.getByText('me@example.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Code shown by the goo app')).toHaveValue('abcd-efgh');
    expect(calls).toHaveLength(0);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve sign-in' }));
    expect(await screen.findByTestId('device-approved')).toHaveTextContent('ABCD-EFGH');
    expect(calls[0]!.body).toEqual({ user_code: 'ABCD-EFGH' });
    expect(calls[0]!.headers.get('X-CSRF-Token')).toBe('c1');
  });

  it('explains an unknown or expired code and validates locally first', async () => {
    session.user = user();
    const calls = stubApi(() => ({ status: 404, json: { error: { code: 'not_found', message: 'device login request not found or expired' } } }));
    render(DevicePage, { props: { code: null } });
    const ev = userEvent.setup();
    await ev.click(screen.getByRole('button', { name: 'Approve sign-in' }));
    expect(screen.getByText('Enter the code shown by the goo app.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await ev.type(screen.getByLabelText('Code shown by the goo app'), 'WXYZ-1234');
    await ev.click(screen.getByRole('button', { name: 'Approve sign-in' }));
    expect(await screen.findByText(/unknown, has expired or was already used/)).toBeInTheDocument();
  });
});
