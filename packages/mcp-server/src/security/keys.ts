// Per-entity API keys (ARCHITECTURE §2.9: one key per entity, never shared).
// Keys are 256-bit random secrets; only their SHA-256 digest is stored. Because the secret is
// high-entropy, a fast hash is appropriate (no password-stretching needed) and lookups are by digest.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "sdk_";

export function generateApiKey(): string {
  return PREFIX + randomBytes(32).toString("base64url");
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function looksLikeApiKey(s: string): boolean {
  return s.startsWith(PREFIX) && s.length === PREFIX.length + 43;
}

export function digestsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Extract a bearer token from an Authorization header value. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** Replace anything that looks like a SignalDesk key before it reaches logs or error messages. */
export function redactSecrets(s: string): string {
  return s.replace(/sdk_[A-Za-z0-9_-]{20,}/g, "sdk_[REDACTED]");
}
