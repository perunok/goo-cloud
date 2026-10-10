<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '../lib/api';
  import { ApiError } from '../lib/api/errors';
  import { Action } from '../lib/state/action.svelte';
  import { session } from '../lib/state/session.svelte';
  import { hashHref, paths } from '../lib/state/router.svelte';
  import { validateUserCode } from '../lib/validation';
  import TextField from '../lib/components/TextField.svelte';
  import Button from '../lib/components/Button.svelte';

  /** Pre-filled from `#/device?code=...`; never approved without an explicit click. */
  let { code = null }: { code?: string | null } = $props();

  let value = $state(untrack(() => code ?? ''));
  let error = $state<string | undefined>(undefined);
  let approved = $state<string | null>(null);
  const action = new Action();

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = validateUserCode(value);
    if (error) return;
    const userCode = value.trim().toUpperCase();
    const res = await action.run(() => api.auth.approveDevice(userCode), { toastError: false });
    if (res?.ok) {
      approved = userCode;
      value = '';
    } else if (res && res.error instanceof ApiError && res.error.status === 404) {
      action.error = 'That code is unknown, has expired or was already used. Start the sign-in again from the goo app.';
    }
  }
</script>

<div class="page-head">
  <div>
    <h1>Desktop sign-in</h1>
    <p>Sign the goo desktop app in to goo cloud as <strong>{session.user?.email}</strong>.</p>
  </div>
</div>

<div class="grid">
  <section class="card stack" aria-labelledby="device-form-title">
    <h2 id="device-form-title">Approve a sign-in code</h2>
    {#if approved}
      <div class="banner success" role="status" data-testid="device-approved">
        Approved <span class="mono">{approved}</span>. Go back to the goo app: it finishes signing in within a few seconds.
      </div>
    {/if}
    <form class="form-grid" onsubmit={submit} novalidate>
      {#if action.error}<div class="form-error" role="alert">{action.error}</div>{/if}
      <TextField
        label="Code shown by the goo app"
        bind:value
        error={error}
        hint="Eight letters and digits, like ABCD-EFGH."
        autocomplete="off"
        spellcheck={false}
      />
      <div><Button type="submit" variant="primary" busy={action.pending}>Approve sign-in</Button></div>
    </form>
  </section>

  <section class="card stack" aria-labelledby="device-help-title">
    <h2 id="device-help-title">How it works</h2>
    <ol>
      <li>In goo, open Settings &gt; goo cloud and choose <strong>Sign in</strong>. The app shows a code.</li>
      <li>Enter that code here (or open the link from the app) and approve it.</li>
      <li>The app signs in as you and can sync the workspaces you belong to.</li>
    </ol>
    <p class="banner warning">
      Only approve a code that your own goo app is showing right now. Anyone who gets you to approve their code can read and
      edit your notes.
    </p>
    <p class="muted small">
      Signed-in apps are listed under <a href={hashHref(paths.account())}>Account &gt; Devices</a>, where you can sign them out.
    </p>
  </section>
</div>

<style>
  .grid {
    display: grid;
    gap: var(--space-5);
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: start;
  }
  ol {
    margin: 0;
    padding-left: var(--space-5);
    display: grid;
    gap: var(--space-2);
  }
  @media (max-width: 860px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
