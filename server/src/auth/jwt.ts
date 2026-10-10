import { SignJWT, jwtVerify } from "jose";
import crypto from "node:crypto";

const ISSUER = "goo-cloud-api";
export const AUDIENCE_API = "goo-cloud-api";

export type AccessTokenClaims = {
  sub: string;
  platform_role: string;
  /** The user's `tokenVersion` at issue time; tokens with an older value are rejected (password change/reset, disable). */
  tv?: number;
  /** Refresh-token family of the desktop sign-in this token came from (absent for tokens not issued through it). */
  fam?: string;
};

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(secret: string, claims: AccessTokenClaims, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ platform_role: claims.platform_role, tv: claims.tv ?? 0, ...(claims.fam && { fam: claims.fam }), typ_: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_API)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .setJti(crypto.randomUUID())
    .sign(key(secret));
}

/** Throws on any problem (bad signature, wrong audience, expired, wrong algorithm). */
export async function verifyAccessToken(secret: string, token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, key(secret), {
    issuer: ISSUER,
    audience: AUDIENCE_API,
    algorithms: ["HS256"]
  });
  if (payload.typ_ !== "access" || typeof payload.sub !== "string") throw new Error("not an access token");
  return {
    sub: payload.sub,
    platform_role: String(payload.platform_role),
    tv: typeof payload.tv === "number" && Number.isInteger(payload.tv) ? payload.tv : 0,
    ...(typeof payload.fam === "string" && { fam: payload.fam })
  };
}
