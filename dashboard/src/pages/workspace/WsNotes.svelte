<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { api } from '../../lib/api';
  import type { NoteMeta } from '../../lib/api/schemas';
  import { Paginator } from '../../lib/state/paginator.svelte';
  import { hashHref, paths } from '../../lib/state/router.svelte';
  import { debounce } from '../../lib/util';
  import { formatBytes, formatDate } from '../../lib/format';
  import ListState from '../../lib/components/ListState.svelte';
  import LoadMore from '../../lib/components/LoadMore.svelte';

  /** Read-only: notes are only written by goo through sync. */
  let { id }: { id: string } = $props();

  let search = $state('');
  let query = $state('');
  const setQuery = debounce((v: string) => (query = v.trim()), 300);
  $effect(() => setQuery(search));
  onMount(() => () => setQuery.cancel());

  const pager = new Paginator<NoteMeta>((cursor) => api.workspaces.notes(id, { cursor, q: query || undefined, limit: 50 }));
  $effect(() => {
    void query;
    untrack(() => void pager.load());
  });

  /** `projects/plan.md` -> folder `projects/`, name `plan.md`. */
  const split = (path: string) => {
    const i = path.lastIndexOf('/');
    return i < 0 ? { folder: '', name: path } : { folder: path.slice(0, i + 1), name: path.slice(i + 1) };
  };
</script>

<p class="muted head">
  The notes stored in goo cloud for this workspace. They are read-only here: edit them in goo, which syncs the changes.
</p>

<div class="card flush">
  <div class="toolbar">
    <div class="field search">
      <label class="sr-only" for="notes-search">Search notes by path</label>
      <input id="notes-search" class="input" type="search" placeholder="Search by path" bind:value={search} />
    </div>
  </div>
  <ListState
    status={pager.status}
    error={pager.error}
    empty={pager.items.length === 0}
    emptyTitle={query ? 'No notes match your search' : 'No notes yet'}
    emptyHint={query ? 'Try another part of the path.' : 'Link this workspace to a folder in goo (Settings > goo cloud) and sync to upload notes.'}
    onretry={() => pager.load()}
  >
    <div class="table-wrap">
      <table>
        <thead><tr><th>Note</th><th>Size</th><th>Updated</th></tr></thead>
        <tbody>
          {#each pager.items as n (n.id)}
            {@const p = split(n.path)}
            <tr>
              <td class="path">
                <a href={hashHref(paths.note(id, n.id))}>{#if p.folder}<span class="muted">{p.folder}</span>{/if}<strong>{p.name}</strong></a>
              </td>
              <td class="muted nowrap">{formatBytes(n.size)}</td>
              <td class="muted">
                {formatDate(n.updated_at)}
                {#if n.updated_by}<div class="small">by {n.updated_by.display_name}</div>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <LoadMore {pager} />
  </ListState>
</div>

<style>
  .head {
    margin-bottom: var(--space-4);
  }
  .toolbar {
    padding: var(--space-4);
    border-bottom: var(--border-width) solid var(--border);
  }
  .search {
    max-width: 360px;
  }
  .path {
    overflow-wrap: anywhere;
  }
  .path a {
    text-decoration: none;
  }
  .path a:hover strong {
    text-decoration: underline;
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
