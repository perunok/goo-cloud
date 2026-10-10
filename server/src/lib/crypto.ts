import crypto from "node:crypto";

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Constant-time string comparison (hashes both sides so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** HMAC-derived CSRF token bound to a session id; re-derivable so the dashboard can recover it after a reload. */
export function deriveCsrfToken(secret: string, sessionId: string): string {
  return crypto.createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("base64url");
}

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789"; // no vowels / lookalikes
export function generateUserCode(): string {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
