import { sha256Hex } from "../trunk/digest.ts";

/**
 * The accounts module's cryptography, on Web Crypto only. Secrets FireTrident hands out (session ids, invite codes,
 * scoped tokens) are random and kept only as SHA-256 digests. Cookies that carry state across the GitHub round trip are
 * sealed with AES-GCM, and the session cookie is signed with HMAC-SHA-256, both under keys derived from FT_SESSION_KEY
 * with HKDF, one key per purpose.
 */

export { sha256Hex };

/** `n` random bytes. */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Bytes as base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (padded or not) as bytes; null when it is not base64url. */
export function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
  const b64 = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const s = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Bytes as lowercase base32 (RFC 4648 alphabet, no padding): easy to read aloud and safe to lowercase. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** A new secret: `prefix` and `bytes` random bytes in base32. */
export function newSecret(prefix: string, bytes: number): string {
  return `${prefix}${base32(randomBytes(bytes))}`;
}

/** The PKCE S256 challenge of a verifier: base64url of its SHA-256. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** One derived key per secret and purpose, kept for the isolate's life. */
const keys = new Map<string, Promise<CryptoKey>>();

/** HKDF-SHA-256 from `secret` to a key for `purpose` (an HMAC key, or an AES-GCM key). */
function derived(secret: string, purpose: string, kind: "hmac" | "aes"): Promise<CryptoKey> {
  const cacheKey = `${kind}\u0000${purpose}\u0000${secret}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
      const params = { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("firetrident accounts"), info: new TextEncoder().encode(purpose) };
      return kind === "hmac"
        ? crypto.subtle.deriveKey(params, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"])
        : crypto.subtle.deriveKey(params, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    })();
    keys.set(cacheKey, key);
  }
  return key;
}

/** `value` and its HMAC-SHA-256 under the key for `purpose`: "<value>.<signature>". `value` must not hold a dot. */
export async function signValue(value: string, secret: string, purpose: string): Promise<string> {
  const key = await derived(secret, purpose, "hmac");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return `${value}.${base64url(sig)}`;
}

/** The value of a signed "<value>.<signature>" when the signature checks out (compared in constant time), else null. */
export async function verifySigned(signed: string, secret: string, purpose: string): Promise<string | null> {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0 || signed.length > 512) return null;
  const value = signed.slice(0, dot);
  const sig = fromBase64url(signed.slice(dot + 1));
  if (!sig || sig.length !== 32) return null;
  const key = await derived(secret, purpose, "hmac");
  const ok = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(value));
  return ok ? value : null;
}

/**
 * `payload` as JSON sealed with AES-GCM under the key for `purpose`, with `exp` (ms) inside: base64url of a random
 * 12-byte IV and the ciphertext. The purpose is the additional data too, so a value sealed for one cookie never opens as
 * another.
 */
export async function seal(payload: Record<string, unknown>, exp: number, secret: string, purpose: string): Promise<string> {
  const key = await derived(secret, purpose, "aes");
  const iv = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify({ ...payload, exp }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) }, key, plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return base64url(out);
}

/** What `seal` sealed, when it opens under the key for `purpose` and `exp` is still ahead of `now`; null otherwise. */
export async function open(text: string, now: number, secret: string, purpose: string): Promise<Record<string, unknown> | null> {
  if (text.length > 4_096) return null;
  const bytes = fromBase64url(text);
  if (!bytes || bytes.length < 12 + 16) return null;
  try {
    const key = await derived(secret, purpose, "aes");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(purpose) }, key, bytes.slice(12));
    const v: unknown = JSON.parse(new TextDecoder().decode(plain));
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return typeof o.exp === "number" && Number.isFinite(o.exp) && now < o.exp ? o : null;
  } catch {
    return null;
  }
}
