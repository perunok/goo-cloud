export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const humanize = (s: string) => s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (status) {
    case 'active':
    case 'ok':
    case 'ready':
    case 'approved':
    case 'accepted':
      return 'success';
    case 'pending':
    case 'pending_verification':
    case 'degraded':
      return 'warning';
    case 'revoked':
    case 'rejected':
    case 'expired':
    case 'failed':
    case 'down':
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** 1536 -> "1.5 KB" (binary units, as file managers show note sizes). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
