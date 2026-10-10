<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../../lib/api';
  import type { Note } from '../../lib/api/schemas';
  import { errorMessage } from '../../lib/api/errors';
  import { hashHref, paths } from '../../lib/state/router.svelte';
  import { formatBytes, formatDate } from '../../lib/format';
  import Button from '../../lib/components/Button.svelte';
  import Markdown from '../../lib/components/Markdown.svelte';

  /** Read-only view of one note: rendered Markdown (safe, see lib/markdown.ts) or the plain text. */
  let { workspaceId, noteId }: { workspaceId: string; noteId: string } = $props();

  /** Larger notes open as plain text: rendering megabytes of Markdown in the browser is slow and rarely useful. */
  const RENDER_LIMIT = 256 * 1024;

  let note = $state<Note | null>(null);
  let workspaceName = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);
  let loading = $state(true);
  let mode = $state<'rendered' | 'plain'>('rendered');

  async function load() {
    loading = true;
    loadError = null;
    notFound = false;
    // The workspace name is only for the heading; the note decides success.
    void api.workspaces.get(workspaceId).then(
      (d) => (workspaceName = d.workspace.name),
      () => {},
    );
    try {
      note = (await api.workspaces.note(workspaceId, noteId)).note;
      mode = note.size > RENDER_LIMIT ? 'plain' : 'rendered';
    } catch (e) {
      loadError = errorMessage(e);
      notFound = (e as { status?: number }).status === 404;
    } finally {
      loading = false;
    }
  }
  onMount(load);

  const name = $derived(note ? (note.path.split('/').pop() ?? note.path) : '');
  const meta = $derived(
    note
      ? [
          formatBytes(note.size),
          `version ${note.version}`,
          `updated ${formatDate(note.updated_at)}${note.updated_by ? ` by ${note.updated_by.display_name}` : ''}`,
          'read-only (edit it in goo)',
        ].join(' · ')
      : '',
  );
</script>

<p class="small">
  <a href={hashHref(paths.workspace(workspaceId, 'notes'))}>← {workspaceName ? `Notes of ${workspaceName}` : 'Notes'}</a>
</p>

{#if loading}
  <div class="card" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Loading note…</div>
{:else if loadError || !note}
  <div class="card stack" role="alert">
    <h1>{notFound ? 'Note not found' : 'Could not load the note'}</h1>
    <p class="muted">{notFound ? 'It may have been deleted or renamed since the list was loaded.' : loadError}</p>
    {#if !notFound}<div><Button onclick={load}>Try again</Button></div>{/if}
  </div>
{:else}
  <div class="page-head">
    <div>
      <h1>{name}</h1>
      {#if note.path !== name}<p class="mono path">{note.path}</p>{/if}
    </div>
    <div class="segmented" role="group" aria-label="Display">
      <button type="button" class="btn sm" aria-pressed={mode === 'rendered'} onclick={() => (mode = 'rendered')}>Rendered</button>
      <button type="button" class="btn sm" aria-pressed={mode === 'plain'} onclick={() => (mode = 'plain')}>Plain text</button>
    </div>
  </div>

  <p class="muted small meta">{meta}</p>

  <article class="card note" aria-label="Note content">
    {#if note.content === ''}
      <p class="muted">This note is empty.</p>
    {:else if mode === 'rendered'}
      <Markdown source={note.content} />
    {:else}
      <pre class="plain">{note.content}</pre>
    {/if}
  </article>
{/if}

<style>
  .path {
    overflow-wrap: anywhere;
  }
  .meta {
    margin-bottom: var(--space-4);
  }
  .note {
    max-width: 860px;
  }
  .plain {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: 0.9em;
  }
  .segmented {
    display: inline-flex;
  }
  .segmented .btn:first-child {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .segmented .btn:last-child {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    margin-left: calc(-1 * var(--border-width));
  }
  .segmented .btn[aria-pressed='true'] {
    background: var(--primary-soft);
    color: var(--primary);
    border-color: var(--primary);
    position: relative;
  }
</style>
