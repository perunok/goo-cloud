export type Errors<K extends string> = Partial<Record<K, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isEmail = (v: string) => EMAIL_RE.test(v.trim());

export function validateLogin(v: { email: string; password: string }): Errors<'email' | 'password'> {
  const e: Errors<'email' | 'password'> = {};
  if (!v.email.trim()) e.email = 'Enter your email address.';
  else if (!isEmail(v.email)) e.email = 'Enter a valid email address.';
  if (!v.password) e.password = 'Enter your password.';
  return e;
}

/** Mirrors the server policy (`server/src/routes/me.ts`): 12-256 characters. */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

/** Human-readable password rules, shown next to every "new password" field. */
export const PASSWORD_RULES = [
  `At least ${MIN_PASSWORD} characters (at most ${MAX_PASSWORD}).`,
  'Different from your current password.',
  'A long passphrase of several unrelated words is easiest to remember.',
];

export function validatePasswordChange(v: {
  current: string;
  next: string;
  confirm: string;
}): Errors<'current' | 'next' | 'confirm'> {
  const e: Errors<'current' | 'next' | 'confirm'> = {};
  if (!v.current) e.current = 'Enter your current password.';
  if (!v.next) e.next = 'Enter a new password.';
  else if (v.next.length < MIN_PASSWORD) e.next = `The new password must be at least ${MIN_PASSWORD} characters.`;
  else if (v.next.length > MAX_PASSWORD) e.next = `The new password must be at most ${MAX_PASSWORD} characters.`;
  else if (v.current && v.next === v.current) e.next = 'The new password must differ from the current one.';
  if (!e.next && v.confirm !== v.next) e.confirm = 'The passwords do not match.';
  return e;
}

export function validateNewUser(v: {
  email: string;
  display_name: string;
  password: string;
  /** The server generates a temporary password, so none is typed and none is validated. */
  generate?: boolean;
}): Errors<'email' | 'display_name' | 'password'> {
  const e: Errors<'email' | 'display_name' | 'password'> = {};
  if (!v.email.trim()) e.email = 'Email is required.';
  else if (!isEmail(v.email)) e.email = 'Enter a valid email address.';
  const name = v.display_name.trim();
  if (!name) e.display_name = 'Display name is required.';
  else if (name.length > 80) e.display_name = 'Display name must be 80 characters or fewer.';
  if (v.generate) return e;
  if (!v.password) e.password = 'Password is required.';
  else if (v.password.length < MIN_PASSWORD) e.password = `Password must be at least ${MIN_PASSWORD} characters.`;
  else if (v.password.length > MAX_PASSWORD) e.password = `Password must be at most ${MAX_PASSWORD} characters.`;
  return e;
}

/** Create-workspace form. The slug is optional: the server derives one from the name when it is left empty. */
export function validateNewWorkspace(v: {
  name: string;
  slug: string;
  description: string;
}): Errors<'name' | 'slug' | 'description'> {
  const e: Errors<'name' | 'slug' | 'description'> = {};
  const name = v.name.trim();
  const slug = v.slug.trim();
  if (!name) e.name = 'Name is required.';
  else if (name.length > 120) e.name = 'Name must be 120 characters or fewer.';
  if (slug) {
    if (slug.length < 3) e.slug = 'Slug must be at least 3 characters.';
    else if (slug.length > 63) e.slug = 'Slug must be 63 characters or fewer.';
    else if (!SLUG_RE.test(slug)) e.slug = 'Use lowercase letters, numbers and single hyphens only.';
  }
  if (v.description.length > 2000) e.description = 'Description must be 2000 characters or fewer.';
  return e;
}

export function validateWorkspaceSettings(v: { name: string; description: string }): Errors<'name' | 'description'> {
  const e: Errors<'name' | 'description'> = {};
  const name = v.name.trim();
  if (!name) e.name = 'Name is required.';
  else if (name.length > 120) e.name = 'Name must be 120 characters or fewer.';
  if (v.description.length > 2000) e.description = 'Description must be 2000 characters or fewer.';
  return e;
}

/** Add-member form: the email of the person to add (an account need not exist yet). */
export function validateMemberEmail(v: { email: string }): Errors<'email'> {
  const e: Errors<'email'> = {};
  if (!v.email.trim()) e.email = 'Email is required.';
  else if (!isEmail(v.email)) e.email = 'Enter a valid email address.';
  return e;
}

/**
 * The code the goo app shows for a desktop sign-in (`ABCD-EFGH`; the server ignores case and separators).
 * Returns an error message or undefined.
 */
export function validateUserCode(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return 'Enter the code shown by the goo app.';
  const letters = v.replace(/[^A-Za-z0-9]/g, '');
  if (v.length > 16 || letters.length < 4) return 'That does not look like a sign-in code (for example ABCD-EFGH).';
  return undefined;
}

export const hasErrors = (e: object) => Object.keys(e).length > 0;
