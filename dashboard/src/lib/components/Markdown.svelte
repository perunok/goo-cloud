<script lang="ts">
  import type { Block, Inline } from '../markdown';
  import { parseMarkdown } from '../markdown';

  /**
   * Renders Markdown as Svelte elements built from the data tree of `lib/markdown.ts`. Text is always inserted as text
   * (never as HTML), links are limited to http(s)/mailto and open in a new tab, and images are not loaded.
   */
  let { source }: { source: string } = $props();
  const blocks = $derived(parseMarkdown(source));
</script>

{#snippet inlines(items: Inline[])}
  {#each items as n, k (k)}
    {#if n.t === 'text'}{n.v}{:else if n.t === 'code'}<code>{n.v}</code>{:else if n.t === 'strong'}<strong
        >{@render inlines(n.c)}</strong
      >{:else if n.t === 'em'}<em>{@render inlines(n.c)}</em>{:else if n.t === 'del'}<del>{@render inlines(n.c)}</del
      >{:else if n.t === 'br'}<br />{:else if n.t === 'link'}{#if n.href}<a
          href={n.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={n.title}>{@render inlines(n.c)}</a
        >{:else}<span class="dead-link" title={n.title}>{@render inlines(n.c)}</span>{/if}{:else if n.t === 'image'}{#if n.href}<a
          class="image-link"
          href={n.href}
          target="_blank"
          rel="noopener noreferrer nofollow">Image: {n.alt || n.href}</a
        >{:else}<span class="dead-link">Image: {n.alt}</span>{/if}{/if}
  {/each}
{/snippet}

{#snippet render(list: Block[])}
  {#each list as b, k (k)}
    {#if b.t === 'heading'}
      <svelte:element this={`h${b.level}`}>{@render inlines(b.c)}</svelte:element>
    {:else if b.t === 'paragraph'}
      <p>{@render inlines(b.c)}</p>
    {:else if b.t === 'code'}
      <pre><code data-lang={b.lang || undefined}>{b.v}</code></pre>
    {:else if b.t === 'quote'}
      <blockquote>{@render render(b.c)}</blockquote>
    {:else if b.t === 'hr'}
      <hr />
    {:else if b.t === 'list'}
      {#if b.ordered}
        <ol start={b.start}>
          {#each b.items as item, j (j)}<li>{@render listItem(item)}</li>{/each}
        </ol>
      {:else}
        <ul class:tasks={b.items.some((x) => x.checked !== null)}>
          {#each b.items as item, j (j)}<li>{@render listItem(item)}</li>{/each}
        </ul>
      {/if}
    {:else if b.t === 'table'}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>{#each b.head as cell, j (j)}<th style:text-align={b.align[j] ?? undefined}>{@render inlines(cell)}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each b.rows as row, r (r)}
              <tr>{#each row as cell, j (j)}<td style:text-align={b.align[j] ?? undefined}>{@render inlines(cell)}</td>{/each}</tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/each}
{/snippet}

{#snippet listItem(item: { checked: boolean | null; c: Block[] })}
  {#if item.checked !== null}
    <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Done' : 'Not done'} />
  {/if}
  {#if item.c.length === 1 && item.c[0]?.t === 'paragraph'}
    {@render inlines(item.c[0].c)}
  {:else}
    {@render render(item.c)}
  {/if}
{/snippet}

<div class="markdown">{@render render(blocks)}</div>

<style>
  .markdown {
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .markdown :global(:first-child) {
    margin-top: 0;
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    margin: 1.2em 0 0.5em;
    line-height: 1.25;
  }
  .markdown :global(h1) {
    font-size: 1.8em;
  }
  .markdown :global(h2) {
    font-size: 1.45em;
  }
  .markdown :global(h3) {
    font-size: 1.2em;
  }
  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol),
  .markdown :global(blockquote),
  .markdown :global(pre),
  .markdown :global(.table-wrap) {
    margin: 0 0 1em;
  }
  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--surface-2);
    border-radius: 4px;
    padding: 0.1em 0.3em;
  }
  .markdown :global(pre) {
    background: var(--surface-2);
    border: var(--border-width) solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
    overflow-x: auto;
  }
  .markdown :global(pre code) {
    background: none;
    padding: 0;
    white-space: pre;
  }
  .markdown :global(blockquote) {
    border-left: 3px solid var(--border-strong);
    padding-left: var(--space-3);
    color: var(--text-muted);
  }
  .markdown :global(ul.tasks) {
    list-style: none;
    padding-left: var(--space-4);
  }
  .markdown :global(hr) {
    border: 0;
    border-top: var(--border-width) solid var(--border);
    margin: 1.5em 0;
  }
  .markdown :global(.dead-link) {
    text-decoration: underline dotted;
  }
</style>
