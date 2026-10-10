<script lang="ts">
  let { reason }: { reason: string } = $props();
</script>

<main class="config-error" role="alert">
  <div class="card stack">
    <h1>Dashboard is not configured</h1>
    <p>The dashboard cannot tell where the goo cloud API lives, so it has not attempted any requests.</p>
    <p class="banner danger">{reason}</p>
    <p class="muted">
      Operators: the goo cloud server image serves the dashboard and answers <code>runtime-config.js</code> itself. If you
      host the built files elsewhere, serve a <code>runtime-config.js</code> that sets
      <code>window.__GOO_API_BASE_URL__</code> (for example <code>"/api"</code> or
      <code>"https://api.example.com"</code>).
    </p>
  </div>
</main>

<style>
  .config-error {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: var(--space-4);
  }
  .card {
    max-width: 560px;
  }
</style>
