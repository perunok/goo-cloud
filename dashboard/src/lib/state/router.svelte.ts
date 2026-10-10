export const WORKSPACE_TABS = ['overview', 'notes', 'members', 'audit'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export type Route =
  | { name: 'overview' }
  | { name: 'users' }
  | { name: 'workspaces' }
  | { name: 'workspace'; id: string; tab: WorkspaceTab }
  | { name: 'note'; id: string; noteId: string }
  | { name: 'audit' }
  | { name: 'account' }
  /** Approve a desktop sign-in; `code` comes from `#/device?code=ABCD-EFGH`. */
  | { name: 'device'; code: string | null }
  | { name: 'not-found'; path: string };

/** Hash routing: refresh, back/forward and deep links all work without server support. */
export function parsePath(path: string): Route {
  const raw = path.replace(/^#/, '');
  const [pathPart, queryPart] = splitOnce(raw, '?');
  const clean = pathPart.replace(/\/+$/, '') || '/';
  const parts = clean.split('/').filter(Boolean).map(decodeURIComponentSafe);
  const [a, b, c, d] = parts;
  if (parts.length === 0) return { name: 'overview' };
  if (a === 'users' && parts.length === 1) return { name: 'users' };
  if (a === 'audit' && parts.length === 1) return { name: 'audit' };
  if (a === 'account' && parts.length === 1) return { name: 'account' };
  if (a === 'device' && parts.length === 1) {
    const code = new URLSearchParams(queryPart).get('code')?.trim() || null;
    return { name: 'device', code };
  }
  if (a === 'workspaces') {
    if (parts.length === 1) return { name: 'workspaces' };
    if (b && parts.length === 2) return { name: 'workspace', id: b, tab: 'overview' };
    if (b && c && parts.length === 3 && (WORKSPACE_TABS as readonly string[]).includes(c)) {
      return { name: 'workspace', id: b, tab: c as WorkspaceTab };
    }
    if (b && c === 'notes' && d && parts.length === 4) return { name: 'note', id: b, noteId: d };
  }
  return { name: 'not-found', path: clean };
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const paths = {
  overview: () => '/',
  users: () => '/users',
  workspaces: () => '/workspaces',
  audit: () => '/audit',
  account: () => '/account',
  device: (code?: string) => (code ? `/device?code=${encodeURIComponent(code)}` : '/device'),
  workspace: (id: string, tab: WorkspaceTab = 'overview') =>
    tab === 'overview' ? `/workspaces/${encodeURIComponent(id)}` : `/workspaces/${encodeURIComponent(id)}/${tab}`,
  note: (id: string, noteId: string) => `/workspaces/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`,
};
export const hashHref = (path: string) => `#${path}`;

class Router {
  route = $state<Route>({ name: 'overview' });
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    const sync = () => (this.route = parsePath(window.location.hash));
    window.addEventListener('hashchange', sync);
    sync();
  }

  get currentPath(): string {
    return window.location.hash.replace(/^#/, '') || '/';
  }

  navigate(path: string, opts: { replace?: boolean } = {}) {
    if (opts.replace) {
      history.replaceState(null, '', `#${path}`);
      this.route = parsePath(path);
    } else {
      window.location.hash = path;
    }
  }
}

export const router = new Router();
