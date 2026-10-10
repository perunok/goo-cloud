<script lang="ts">
  /** The goo logo (public/goo.svg, the same icon as the goo app) and the product name. */
  let { size = 28 }: { size?: number } = $props();
</script>

<span class="brand-mark">
  <img src="/goo.svg" alt="" width={size} height={size} />
  <span>goo <span class="muted">cloud</span></span>
</span>

<style>
  .brand-mark {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 800;
  }
  img {
    border-radius: 22%;
    flex: none;
  }
</style>
