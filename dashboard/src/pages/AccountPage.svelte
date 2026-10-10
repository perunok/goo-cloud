<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { Device } from '../lib/api/schemas';
  import { session } from '../lib/state/session.svelte';
  import { Paginator } from '../lib/state/paginator.svelte';
  import { Action } from '../lib/state/action.svelte';
  import { hashHref, paths } from '../lib/state/router.svelte';
  import { platformRoleLabel } from '../lib/permissions';
  import { formatDate } from '../lib/format';
  import ChangePasswordForm from '../lib/components/ChangePasswordForm.svelte';
  import ListState from '../lib/components/ListState.svelte';
  import LoadMore from '../lib/components/LoadMore.svelte';
  import Button from '../lib/components/Button.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';

  const devices = new Paginator<Device>((cursor) => api.me.devices({ cursor }));
  onMount(() => void devices.load());

  let signingOut = $state<Device | null>(null);
  const signOutAction = new Action();
  async function signOut() {
    const target = signingOut;
    if (!target) return;
    const res = await signOutAction.run(() => api.me.signOutDevice(target.id), {
      success: `Signed out ${target.device_name}`,
      toastError: false,
    });
    if (res?.ok) {
      devices.remove((d) => d.id === target.id);
      signingOut = null;
    }
  }
</script>

<div class="page-head">
  <div>
    <h1>Account</h1>
    <p>Your goo cloud sign-in and the devices that sync with it.</p>
  </div>
</div>

<div class="stack">
  <div class="grid">
    <section class="card stack" aria-labelledby="profile-title">
      <h2 id="profile-title">Profile</h2>
      <dl>
        <dt>Email</dt><dd>{session.user?.email}</dd>
        <dt>Display name</dt><dd>{session.user?.display_name || '—'}</dd>
        <dt>Platform role</dt><dd>{session.platformRole ? platformRoleLabel[session.platformRole] : '—'}</dd>
      </dl>
    </section>

    <section class="card stack" aria-labelledby="password-title">
      <h2 id="password-title">Change password</h2>
      <ChangePasswordForm />
    </section>
  </div>

  <section class="stack" aria-labelledby="devices-title">
    <div class="row between">
      <div>
        <h2 id="devices-title">Devices</h2>
        <p class="muted small">
          goo installations signed in to your account. Sign one out if you no longer use it or it was lost. To add one,
          sign in from goo and <a href={hashHref(paths.device())}>approve its code</a>.
        </p>
      </div>
    </div>
    <div class="card flush">
      <ListState
        status={devices.status}
        error={devices.error}
        empty={devices.items.length === 0}
        emptyTitle="No devices yet"
        emptyHint="Devices appear here after goo signs in and syncs for the first time."
        onretry={() => devices.load()}
      >
        <div class="table-wrap">
          <table>
            <thead><tr><th>Device</th><th>goo version</th><th>Last seen</th><th>Signed in</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {#each devices.items as d (d.id)}
                <tr>
                  <td><strong>{d.device_name}</strong><div class="muted small">{d.platform}</div></td>
                  <td class="mono muted">{d.app_version}</td>
                  <td class="muted">{formatDate(d.last_seen_at)}</td>
                  <td class="muted">{formatDate(d.created_at)}</td>
                  <td class="actions">
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label="Sign out {d.device_name}"
                      onclick={() => {
                        signOutAction.error = null;
                        signingOut = d;
                      }}>Sign out</Button
                    >
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <LoadMore pager={devices} />
      </ListState>
    </div>
  </section>
</div>

{#if signingOut}
  <ConfirmDialog
    title="Sign out device"
    confirmLabel="Sign out"
    danger
    busy={signOutAction.pending}
    error={signOutAction.error}
    onconfirm={signOut}
    oncancel={() => (signingOut = null)}
  >
    <p>
      <strong>{signingOut.device_name}</strong> stops syncing within the hour (when its current access token expires) and has
      to sign in again. Its notes stay on the device.
    </p>
  </ConfirmDialog>
{/if}

<style>
  .grid {
    display: grid;
    gap: var(--space-5);
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
    align-items: start;
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  @media (max-width: 860px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
