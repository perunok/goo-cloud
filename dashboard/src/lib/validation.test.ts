import { describe, expect, it } from 'vitest';
import { hasErrors, validateMemberEmail, validateLogin, validateNewUser, validateNewWorkspace, validateUserCode, validateWorkspaceSettings } from './validation';

describe('validation', () => {
  it('login', () => {
    expect(validateLogin({ email: '', password: '' })).toEqual({ email: 'Enter your email address.', password: 'Enter your password.' });
    expect(validateLogin({ email: 'nope', password: 'x' }).email).toMatch(/valid email/);
    expect(hasErrors(validateLogin({ email: 'a@b.co', password: 'x' }))).toBe(false);
  });
  it('new user', () => {
    const e = validateNewUser({ email: 'bad', display_name: ' ', password: 'short' });
    expect(Object.keys(e).sort()).toEqual(['display_name', 'email', 'password']);
    expect(hasErrors(validateNewUser({ email: 'a@b.co', display_name: 'A', password: 'x'.repeat(12) }))).toBe(false);
  });
  it('new user with a generated password needs no password', () => {
    expect(hasErrors(validateNewUser({ email: 'a@b.co', display_name: 'A', password: '', generate: true }))).toBe(false);
    expect(Object.keys(validateNewUser({ email: 'x', display_name: '', password: '', generate: true })).sort()).toEqual(['display_name', 'email']);
  });
  it('workspace settings', () => {
    expect(validateWorkspaceSettings({ name: ' ', description: '' }).name).toBeDefined();
    expect(validateWorkspaceSettings({ name: 'x'.repeat(121), description: '' }).name).toMatch(/120/);
    expect(validateWorkspaceSettings({ name: 'ok', description: 'd'.repeat(2001) }).description).toMatch(/2000/);
    expect(validateWorkspaceSettings({ name: 'ok', description: '' })).toEqual({});
  });
  it('new workspace slug rules (the slug is optional)', () => {
    const base = { name: 'N', description: '' };
    expect(validateNewWorkspace({ ...base, slug: '' })).toEqual({});
    expect(validateNewWorkspace({ ...base, slug: 'x'.repeat(64) }).slug).toMatch(/63/);
    expect(validateNewWorkspace({ ...base, slug: 'Has Space' }).slug).toMatch(/lowercase/);
    expect(validateNewWorkspace({ ...base, slug: 'a--b' }).slug).toBeDefined();
    expect(validateNewWorkspace({ ...base, slug: '-a' }).slug).toBeDefined();
    expect(validateNewWorkspace({ ...base, slug: 'ab' }).slug).toMatch(/at least 3/);
    expect(validateNewWorkspace({ ...base, slug: 'ok-slug-1' }).slug).toBeUndefined();
    expect(validateNewWorkspace({ name: '', slug: 'abc', description: '' }).name).toBeDefined();
  });
  it('add member email', () => {
    expect(validateMemberEmail({ email: '' }).email).toBeDefined();
    expect(validateMemberEmail({ email: 'a@b.io' })).toEqual({});
  });
  it('desktop sign-in code', () => {
    expect(validateUserCode('')).toMatch(/Enter the code/);
    expect(validateUserCode('ab')).toMatch(/does not look/);
    expect(validateUserCode('x'.repeat(17))).toMatch(/does not look/);
    expect(validateUserCode(' abcd-efgh ')).toBeUndefined();
    expect(validateUserCode('ABCDEFGH')).toBeUndefined();
  });
});
