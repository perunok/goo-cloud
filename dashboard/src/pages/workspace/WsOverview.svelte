<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '../../lib/api';
  import { ApiError, errorMessage } from '../../lib/api/errors';
  import type { Member, Workspace, WorkspaceRole } from '../../lib/api/schemas';
  import { Action } from '../../lib/state/action.svelte';
  import { session } from '../../lib/state/session.svelte';
  import { router, paths } from '../../lib/state/router.svelte';
  import {
    canDeleteWorkspace,
    canEditWorkspaceSettings,
    canLeaveWorkspace,
    canTransferOwnership,
  } from '../../lib/permissions';
  import { toasts } from '../../lib/state/toasts.svelte';
  import { hasErrors, validateWorkspaceSettings, type Errors } from '../../lib/validation';
  import { formatDate, humanize } from '../../lib/format';
  import Button from '../../lib/components/Button.svelte';
  import ConfirmDialog from '../../lib/components/ConfirmDialog.svelte';
  import Modal from '../../lib/components/Modal.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import TextArea from '../../lib/components/TextArea.svelte';
  import SelectField from '../../lib/components/SelectField.svelte';

  interface Props {
    workspace: Workspace;
    role: WorkspaceRole | null;
    /** Called with the server's copy after a successful save. */
    onupdate?: (w: Workspace) => void;
    /** Re-fetches the workspace and the caller's role (version conflict, after a transfer). */
    onreload?: () => Promise<void> | void;
  }
  let { workspace, role, onupdate, onreload }: Props = $props();
  const canEdit = $derived(canEditWorkspaceSettings(session.platformRole, role));

  // ---- settings ----
  const initial = (w: Workspace) => ({ name: w.name, description: w.description ?? '' });
  let draft = $state(untrack(() => initial(workspace)));
  let errors = $state<Errors<'name' | 'description'>>({});
  let conflict = $state<{ current: number | null } | null>(null);
  const saveAction = new Action();
  // Whenever the persisted copy changes (save, reload after a conflict) the form starts from it again.
  $effect(() => {
    void workspace.id;
    void workspace.version;
    untrack(() => {
      draft = initial(workspace);
      errors = {};
    });
  });
  const dirty = $derived.by(() => {
    const base = initial(workspace);
    return draft.name.trim() !== base.name || draft.description !== base.description;
  });
  let reloading = $state(false);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    errors = validateWorkspaceSettings(draft);
    if (hasErrors(errors) || !dirty) return;
    const base = initial(workspace);
    // Only send what changed, together with the version this form was loaded from.
    const changes: Parameters<typeof api.workspaces.update>[1] = { version: workspace.version };
    if (draft.name.trim() !== base.name) changes.name = draft.name.trim();
    if (draft.description !== base.description) changes.description = draft.description;
    conflict = null;
    const res = await saveAction.run(() => api.workspaces.update(workspace.id, changes), { toastError: false });
    if (res?.ok) {
      onupdate?.(res.value.workspace);
      toasts.success('Workspace settings saved');
    } else if (res && res.error instanceof ApiError) {
      if (res.error.code === 'version_mismatch') {
        const d = res.error.details as { current_version?: number } | undefined;
        conflict = { current: typeof d?.current_version === 'number' ? d.current_version : null };
      } else {
        const f = res.error.fieldErrors;
        errors = { name: f.name, description: f.description };
      }
    }
  }
  async function loadLatest() {
    reloading = true;
    try {
      await onreload?.();
      conflict = null;
      saveAction.error = null;
    } finally {
      reloading = false;
    }
  }

  // ---- transfer ownership ----
  const canTransfer = $derived(canTransferOwnership(session.platformRole, role));
  let transferring = $state(false);
  let candidates = $state<Member[] | null>(null);
  let candidatesError = $state<string | null>(null);
  let newOwner = $state('');
  const transferAction = new Action();
  async function openTransfer() {
    transferring = true;
    transferAction.error = null;
    candidates = null;
    candidatesError = null;
    newOwner = '';
    try {
      // Owners transfer to an existing member; 100 is the server's page cap and plenty for a notes folder.
      const page = await api.workspaces.members(workspace.id, { limit: 100 });
      candidates = page.items.filter((m) => m.role !== 'owner' && m.user_id !== workspace.owner_user_id);
      newOwner = candidates[0]?.id ?? '';
    } catch (e) {
      candidatesError = errorMessage(e);
    }
  }
  const memberLabel = (m: Member) => `${m.display_name || m.email || m.user_id}${m.email && m.display_name ? ` (${m.email})` : ''}`;
  async function transfer(e: SubmitEvent) {
    e.preventDefault();
    const target = candidates?.find((m) => m.id === newOwner);
    if (!target) return;
    const res = await transferAction.run(() => api.workspaces.transfer(workspace.id, target.id, workspace.version), {
      toastError: false,
    });
    if (res?.ok) {
      transferring = false;
      toasts.success(`${target.display_name || target.email} now owns ${workspace.name}`);
      onupdate?.(res.value.workspace);
      // The caller's own role changed (the previous owner becomes admin).
      await onreload?.();
    } else if (res && res.error instanceof ApiError && res.error.code === 'version_mismatch') {
      transferAction.error = 'Someone else changed this workspace meanwhile. Close this dialog, reload the page and try again.';
    }
  }

  // ---- leave ----
  const canLeave = $derived(canLeaveWorkspace(role));
  let leaving = $state(false);
  const leaveAction = new Action();
  async function leave() {
    const res = await leaveAction.run(() => api.workspaces.leave(workspace.id), {
      success: `You left ${workspace.name}`,
      toastError: false,
    });
    if (res?.ok) {
      leaving = false;
      router.navigate(paths.workspaces());
    }
  }

  // ---- delete ----
  const canDelete = $derived(canDeleteWorkspace(session.platformRole, role));
  let confirming = $state(false);
  const action = new Action();

  async function remove() {
    const res = await action.run(() => api.workspaces.remove(workspace.id), {
      success: `Deleted ${workspace.name}`,
      toastError: false,
    });
    if (res?.ok) {
      confirming = false;
      router.navigate(paths.workspaces());
    }
  }
</script>

<div class="stack">
  <section class="card stack" aria-labelledby="details">
    <h2 id="details">Details</h2>
    <dl>
      <dt>Name</dt><dd>{workspace.name}</dd>
      <dt>Slug</dt><dd class="mono">{workspace.slug}</dd>
      <dt>Description</dt><dd>{workspace.description || '—'}</dd>
      <dt>Your role</dt><dd>{role ? humanize(role) : 'None (platform admin access)'}</dd>
      <dt>Created</dt><dd>{formatDate(workspace.created_at)}</dd>
      <dt>Last updated</dt><dd>{formatDate(workspace.updated_at)}</dd>
      <dt>ID</dt><dd class="mono">{workspace.id}</dd>
    </dl>
    <p class="muted small">
      To sync this workspace, sign in to goo cloud in the goo app (Settings &gt; goo cloud) and link the workspace to a folder of
      notes on that device.
    </p>
  </section>

  {#if canEdit}
    <section class="card stack" aria-labelledby="settings">
      <h2 id="settings">Settings</h2>
      <form class="form-grid" onsubmit={save} novalidate>
        {#if conflict}
          <div class="form-error" role="alert" data-testid="version-conflict">
            <p>
              <strong>Someone else changed this workspace</strong> while you were editing{#if conflict.current !== null} (it is now at version {conflict.current}){/if}.
              Your changes were not saved.
            </p>
            <Button size="sm" busy={reloading} onclick={loadLatest}>Load latest version</Button>
          </div>
        {:else if saveAction.error && !hasErrors(Object.fromEntries(Object.entries(errors).filter(([, v]) => v)))}
          <div class="form-error" role="alert">{saveAction.error}</div>
        {/if}
        <TextField label="Name" bind:value={draft.name} error={errors.name} />
        <TextArea label="Description" rows={3} bind:value={draft.description} error={errors.description} />
        <div class="row">
          <Button type="submit" variant="primary" busy={saveAction.pending} disabled={!dirty}>Save settings</Button>
          {#if dirty}<Button disabled={saveAction.pending} onclick={() => { draft = initial(workspace); errors = {}; conflict = null; }}>Discard changes</Button>{/if}
        </div>
      </form>
    </section>
  {/if}

  {#if canTransfer}
    <section class="card stack" aria-labelledby="ownership">
      <h2 id="ownership">Ownership</h2>
      <p class="muted">
        Hand the workspace over to another member. They become the owner and the current owner stays on as an admin.
      </p>
      <div><Button onclick={openTransfer}>Transfer ownership</Button></div>
    </section>
  {/if}

  {#if canLeave}
    <section class="card stack" aria-labelledby="leave">
      <h2 id="leave">Leave workspace</h2>
      <p class="muted">You stop syncing this workspace. The notes already on your devices stay there.</p>
      <div>
        <Button variant="danger" onclick={() => { leaveAction.error = null; leaving = true; }}>Leave workspace</Button>
      </div>
    </section>
  {/if}

  <section class="card stack danger-zone" aria-labelledby="danger">
    <h2 id="danger">Danger zone</h2>
    <p class="muted">Deleting a workspace permanently removes its notes from goo cloud and revokes every member's access.</p>
    <div>
      <Button
        variant="danger"
        disabled={!canDelete}
        title={canDelete ? undefined : 'Only a super admin or the workspace owner can delete a workspace'}
        onclick={() => {
          action.error = null;
          confirming = true;
        }}>Delete workspace</Button
      >
    </div>
  </section>
</div>

{#if transferring}
  <Modal title="Transfer ownership" onclose={() => (transferring = false)} locked={transferAction.pending}>
    <form id="transfer-form" class="form-grid" onsubmit={transfer} novalidate>
      {#if transferAction.error}<div class="form-error" role="alert">{transferAction.error}</div>{/if}
      {#if candidatesError}
        <div class="form-error" role="alert">{candidatesError}</div>
      {:else if candidates === null}
        <p class="muted" role="status"><span class="spinner" aria-hidden="true"></span> Loading members…</p>
      {:else if candidates.length === 0}
        <p class="muted">Add another member first: ownership can only go to someone who already belongs to the workspace.</p>
      {:else}
        <SelectField
          label="New owner"
          bind:value={newOwner}
          options={candidates.map((m) => ({ value: m.id, label: memberLabel(m) }))}
        />
        <p class="muted small">You stay a member as an admin. Only the new owner can transfer it back.</p>
      {/if}
    </form>
    {#snippet footer()}
      <Button onclick={() => (transferring = false)} disabled={transferAction.pending}>Cancel</Button>
      <Button
        type="submit"
        form="transfer-form"
        variant="primary"
        busy={transferAction.pending}
        disabled={!candidates || candidates.length === 0}>Transfer ownership</Button
      >
    {/snippet}
  </Modal>
{/if}

{#if leaving}
  <ConfirmDialog
    title="Leave workspace"
    confirmLabel="Leave workspace"
    danger
    busy={leaveAction.pending}
    error={leaveAction.error}
    onconfirm={leave}
    oncancel={() => (leaving = false)}
  >
    <p>You lose access to <strong>{workspace.name}</strong> until an owner or admin adds you again.</p>
  </ConfirmDialog>
{/if}

{#if confirming}
  <ConfirmDialog
    title="Delete workspace"
    confirmLabel="Delete workspace"
    danger
    typedConfirmation={workspace.name}
    busy={action.pending}
    error={action.error}
    onconfirm={remove}
    oncancel={() => (confirming = false)}
  >
    <p>This permanently deletes <strong>{workspace.name}</strong> and its notes from goo cloud. This cannot be undone.</p>
  </ConfirmDialog>
{/if}

<style>
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-2) var(--space-5);
    margin: 0;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .danger-zone {
    border-color: var(--danger);
  }
</style>
