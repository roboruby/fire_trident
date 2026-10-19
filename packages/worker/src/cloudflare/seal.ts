/**
 * Encryption for stored Cloudflare tokens. Each sealed value has its own random salt and IV: the AES-GCM key is derived
 * from FT_GRANT_KEY with HKDF-SHA-256 over that salt, and the value is bound to its context (the FireTrident account and
 * what it holds) as additional data, so a sealed value copied to another account's record, or changed at all, does not
 * open. Format: "v1.<salt>.<iv>.<ciphertext and tag>", each part base64url.
 */

const VERSION = "v1";
const INFO = new TextEncoder().encode("firetrident cloudflare grant v1");
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** A sealed value that did not open: changed, made for another context, or sealed with another key. */
export class SealError extends Error {
  constructor() {
    super("a stored Cloudflare connection could not be decrypted");
    this.name = "SealError";
  }
}

/** Bytes as base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (padding optional) as bytes; throws on anything else. */
export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new SealError();
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(keyMaterial: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyMaterial), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Encrypt `plaintext` for `context` (for example "grant:<account>") under FT_GRANT_KEY's material. */
export async function seal(keyMaterial: string, context: string, plaintext: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await derive(keyMaterial, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, key, new TextEncoder().encode(plaintext));
  return [VERSION, toBase64Url(salt), toBase64Url(iv), toBase64Url(new Uint8Array(ct))].join(".");
}

/** Decrypt a value `seal` made for the same context and key material; throws SealError for anything else. */
export async function unseal(keyMaterial: string, context: string, sealed: string): Promise<string> {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SealError();
  const salt = fromBase64Url(parts[1] ?? "");
  const iv = fromBase64Url(parts[2] ?? "");
  const ct = fromBase64Url(parts[3] ?? "");
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ct.length < 16) throw new SealError();
  try {
    const key = await derive(keyMaterial, salt);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    throw new SealError();
  }
}
