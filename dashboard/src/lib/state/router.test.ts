import { describe, expect, it } from 'vitest';
import { parsePath, paths } from './router.svelte';

describe('parsePath', () => {
  it('maps deep links', () => {
    expect(parsePath('')).toEqual({ name: 'overview' });
    expect(parsePath('#/')).toEqual({ name: 'overview' });
    expect(parsePath('#/users')).toEqual({ name: 'users' });
    expect(parsePath('#/audit')).toEqual({ name: 'audit' });
    expect(parsePath('#/workspaces')).toEqual({ name: 'workspaces' });
    expect(parsePath('#/workspaces/abc')).toEqual({ name: 'workspace', id: 'abc', tab: 'overview' });
    expect(parsePath('#/workspaces/abc/notes')).toEqual({ name: 'workspace', id: 'abc', tab: 'notes' });
    expect(parsePath('#/workspaces/a%2Fb/audit/')).toEqual({ name: 'workspace', id: 'a/b', tab: 'audit' });
    expect(parsePath('#/workspaces/abc/notes/n%201')).toEqual({ name: 'note', id: 'abc', noteId: 'n 1' });
    expect(parsePath('#/account')).toEqual({ name: 'account' });
    expect(parsePath('#/device')).toEqual({ name: 'device', code: null });
    expect(parsePath('#/device?code=ABCD-EFGH')).toEqual({ name: 'device', code: 'ABCD-EFGH' });
  });
  it('unknown paths are not-found', () => {
    expect(parsePath('#/nope').name).toBe('not-found');
    expect(parsePath('#/workspaces/abc/settings').name).toBe('not-found');
    expect(parsePath('#/workspaces/abc/hosts').name).toBe('not-found');
    expect(parsePath('#/workspaces/abc/members/x').name).toBe('not-found');
  });
  it('round-trips through paths', () => {
    expect(parsePath(paths.workspace('x y', 'members'))).toEqual({ name: 'workspace', id: 'x y', tab: 'members' });
    expect(parsePath(paths.note('w', 'n/1'))).toEqual({ name: 'note', id: 'w', noteId: 'n/1' });
    expect(parsePath(paths.device('AB CD'))).toEqual({ name: 'device', code: 'AB CD' });
  });
});
