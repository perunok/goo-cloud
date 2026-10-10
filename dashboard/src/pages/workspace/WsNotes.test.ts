import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import WsNotes from './WsNotes.svelte';
import NoteView from './NoteView.svelte';
import { session } from '../../lib/state/session.svelte';
import { stubApi, user } from '../../test/helpers';

const meta = (id: string, path: string, size = 120) => ({
  id, workspace_id: 'w1', path, version: 2, size, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-02T10:00:00Z',
  updated_by: { id: 'u1', display_name: 'Ann' },
});

describe('Notes tab', () => {
  it('lists notes with path, size and author, linking to the note view; search goes to the server', async () => {
    session.user = user();
    const calls = stubApi((r) => {
      if (r.path !== '/workspaces/w1/notes') return undefined;
      const q = r.query.get('q');
      const items = [meta('n1', 'projects/plan.md', 2048), meta('n2', 'inbox.md')].filter((n) => !q || n.path.includes(q));
      return { json: { items, page: { next_cursor: null, has_more: false } } };
    });
    render(WsNotes, { props: { id: 'w1' } });
    const link = await screen.findByRole('link', { name: 'projects/plan.md' });
    expect(link).toHaveAttribute('href', '#/workspaces/w1/notes/n1');
    const row = link.closest('tr')!;
    expect(within(row).getByText('2.0 KB')).toBeInTheDocument();
    expect(within(row).getByText('by Ann')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'inbox.md' })).toBeInTheDocument();

    await userEvent.setup().type(screen.getByLabelText('Search notes by path'), 'plan');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'inbox.md' })).toBeNull(), { timeout: 2000 });
    expect(calls.at(-1)!.query.get('q')).toBe('plan');
  });

  it('explains how to get notes when there are none', async () => {
    session.user = user();
    stubApi(() => ({ json: { items: [], page: { next_cursor: null, has_more: false } } }));
    render(WsNotes, { props: { id: 'w1' } });
    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
    expect(screen.getByText(/Settings > goo cloud/)).toBeInTheDocument();
  });
});

describe('Note view', () => {
  const note = { ...meta('n1', 'projects/plan.md'), content: '# Plan\n\n<b>raw</b> and [x](javascript:alert(1))', content_hash: 'abc' };

  function setup(n: unknown = note, status = 200) {
    session.user = user();
    return stubApi((r) => {
      if (r.path === '/workspaces/w1') return { json: { workspace: { id: 'w1', slug: 'w', name: 'Team notes', version: 1 }, membership: { role: 'viewer' } } };
      if (r.path === '/workspaces/w1/notes/n1') return status === 200 ? { json: { note: n } } : { status, json: { error: { code: 'not_found', message: 'note not found' } } };
    });
  }

  it('renders Markdown by default and switches to plain text', async () => {
    setup();
    render(NoteView, { props: { workspaceId: 'w1', noteId: 'n1' } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'plan.md' })).toBeInTheDocument();
    expect(screen.getByText('projects/plan.md')).toBeInTheDocument();
    expect(screen.getByText(/version 2 · updated .+ by Ann · read-only/)).toBeInTheDocument();
    expect(document.querySelector('article b')).toBeNull();
    expect(await screen.findByRole('link', { name: /Notes of Team notes/ })).toHaveAttribute('href', '#/workspaces/w1/notes');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Plain text' }));
    expect(screen.getByRole('button', { name: 'Plain text' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('article pre')!.textContent).toBe(note.content);
  });

  it('opens large notes as plain text', async () => {
    setup({ ...note, size: 300 * 1024 });
    render(NoteView, { props: { workspaceId: 'w1', noteId: 'n1' } });
    expect(await screen.findByRole('button', { name: 'Plain text' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a deleted note is "not found"', async () => {
    setup(note, 404);
    render(NoteView, { props: { workspaceId: 'w1', noteId: 'n1' } });
    expect(await screen.findByRole('heading', { name: 'Note not found' })).toBeInTheDocument();
  });
});
