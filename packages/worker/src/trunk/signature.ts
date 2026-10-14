import type { NoteSignatureCheck, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { sha256Hex } from "./digest.ts";

/**
 * Signed lineage notes. The FT-Note trailer (trunk/digest.ts) proves that a note and its commit agree, not who wrote
 * them: anyone who can rewrite history can rewrite both. With FT_NOTE_KEY set (an Ed25519 private key as a JWK), the
 * trunk writer signs each landing commit it builds, and the line just above the FT-Note trailer (which stays the last
 * line) is
 *
 *   FT-Note-Signature: ed25519 <key id> <signature>
 *
 * the Ed25519 signature, base64url without padding, over the UTF-8 text
 *
 *   firetrident-note-signature v1\n<note sha256>\n<tree>\n<parents>\n
 *
 * where the note sha256 is the digest the commit's FT-Note trailer carries, the tree is the commit's root tree and the
 * parents are its parent commits separated by spaces (a landing has exactly one). The key id is the first 16 hex digits
 * of the SHA-256 of the raw 32-byte public key, which GET /.well-known/firetrident-keys.json publishes; a checker
 * recomputes it, so a key id cannot name another key. Commits landed before signing, or while the secret is absent,
 * carry no signature line. The private key is never printed or logged.
 */

/** The trailer key of a commit's signature. */
export const SIGNATURE_TRAILER = "FT-Note-Signature";
/** The first line of the text a signature covers: what it is, and its version. */
export const SIGNED_TEXT_V1 = "firetrident-note-signature v1";
/** Where the keys are published. */
export const KEYS_PATH = "/.well-known/firetrident-keys.json";

const ALG = "Ed25519";
const SIGNATURE_LINE = /^FT-Note-Signature: ed25519 ([0-9a-f]{16}) ([A-Za-z0-9_-]{86})$/;
const NOTE_LINE = /^FT-Note: sha256:([0-9a-f]{64})$/;
/** 32 bytes as base64url without padding. */
const KEY_BYTES = /^[A-Za-z0-9_-]{43}$/;
const KEY_HELP = 'an Ed25519 private key as a JWK JSON string ({"kty":"OKP","crv":"Ed25519","d":"…","x":"…"})';

/** A public key as GET /.well-known/firetrident-keys.json lists it. */
export interface PublishedKey {
  /** The first 16 hex digits of the SHA-256 of the raw public key. */
  id: string;
  alg: "Ed25519";
  /** The raw 32-byte public key, base64url without padding. */
  publicKey: string;
  /** When the key started signing (ISO 8601, from FT_NOTE_KEY's "since"), or null when the secret does not say. */
  since: string | null;
}

/** The trunk writer's signing key: its published half, and the signature of a text with its private half. */
export interface NoteSigner {
  key: PublishedKey;
  sign(text: string): Promise<string>;
}

/** The text a commit's signature covers (see the module comment). */
export function signedText(p: { digest: string; tree: Sha; parents: readonly Sha[] }): string {
  return `${SIGNED_TEXT_V1}\n${p.digest}\n${p.tree}\n${p.parents.join(" ")}\n`;
}

/** The id of an Ed25519 public key: the first 16 hex digits of the SHA-256 of its raw 32 bytes. */
export async function keyIdOf(publicKey: Uint8Array): Promise<string> {
  return (await sha256Hex(publicKey)).slice(0, 16);
}

/** The signer FT_NOTE_KEY last held, kept for the isolate's life: every landing cycle and every key read asks. */
let loaded: { secret: string; signer: Promise<NoteSigner | null> } | null = null;
let signFailureLogged = false;

/**
 * The signer FT_NOTE_KEY holds, or null when it is absent, or is not an Ed25519 private key as a JWK whose halves match
 * (said once in the log, never with the secret). Never throws.
 */
export function noteSigner(secret: unknown): Promise<NoteSigner | null> {
  if (typeof secret !== "string" || secret.trim() === "") return Promise.resolve(null);
  if (loaded?.secret !== secret) loaded = { secret, signer: loadSigner(secret).catch(() => refuse("it could not be loaded")) };
  return loaded.signer;
}

/** The id of the key that signs lineage notes (GET /api/about), or null when landings are not signed. */
export async function noteKeyId(secret: unknown): Promise<string | null> {
  return (await noteSigner(secret))?.key.id ?? null;
}

/** The keys a checker accepts: the one FT_NOTE_KEY holds, or none. */
export async function publishedKeys(secret: unknown): Promise<PublishedKey[]> {
  const signer = await noteSigner(secret);
  return signer ? [signer.key] : [];
}

/**
 * GET /.well-known/firetrident-keys.json: {"keys":[{"id","alg","publicKey","since"}]}, an empty list when the deployment
 * does not sign. Public: any git client checks a commit's FT-Note-Signature with it (scripts/verify_note.mjs --keys).
 */
export async function keysResponse(env: Pick<Env, "FT_NOTE_KEY">): Promise<Response> {
  const body = `${JSON.stringify({ keys: await publishedKeys(env.FT_NOTE_KEY) }, null, 2)}\n`;
  return new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}

/**
 * `message` with its commit's signature line appended, over the note's `digest`, the commit's `tree` and its `parents`;
 * the caller then adds the FT-Note trailer as the last line (withNoteDigest). Unchanged when `signer` is null, and when
 * signing fails (logged once; the landing goes on unsigned).
 */
export async function withSignature(message: string, signer: NoteSigner | null, p: { digest: string; tree: Sha; parents: readonly Sha[] }): Promise<string> {
  if (!signer) return message;
  let signature: string;
  try {
    signature = await signer.sign(signedText(p));
  } catch (e) {
    if (!signFailureLogged) console.error(`a landing commit was left unsigned: signing its note failed (${e instanceof Error ? e.name : "unknown error"})`);
    signFailureLogged = true;
    return message;
  }
  return `${message.replace(/\s+$/, "")}\n${SIGNATURE_TRAILER}: ed25519 ${signer.key.id} ${signature}`;
}

/**
 * A commit's signature against the published `keys`: `signed`, `bad-signature` with why, or `unsigned` (no signature line
 * just above a last-line FT-Note trailer). Null when it cannot be checked: the commit's parents are not known. Never throws.
 */
export async function checkSignature(commit: { tree: string; message: string; parents?: readonly string[] }, keys: readonly PublishedKey[]): Promise<NoteSignatureCheck | null> {
  const lines = typeof commit.message === "string" ? commit.message.replace(/\s+$/, "").split("\n") : [];
  const digest = NOTE_LINE.exec(lines[lines.length - 1] ?? "")?.[1];
  const line = lines.length >= 2 ? (lines[lines.length - 2] ?? "") : "";
  if (digest === undefined || !line.startsWith(`${SIGNATURE_TRAILER}:`)) return { status: "unsigned" };
  const m = SIGNATURE_LINE.exec(line);
  if (!m) return { status: "bad-signature", detail: "the FT-Note-Signature trailer is not in the form the trunk writer writes" };
  const keyId = m[1]!;
  if (!Array.isArray(commit.parents)) return null;
  const key = keys.find((k) => k.id === keyId);
  if (!key) return { status: "bad-signature", keyId, detail: `the signature names key ${keyId}, which this deployment does not publish` };
  if (await verifyWith(key, signedText({ digest, tree: commit.tree, parents: commit.parents }), m[2]!)) return { status: "signed", keyId };
  return { status: "bad-signature", keyId, detail: `the signature does not verify with key ${keyId}: the note digest, tree or parent this commit carries is not what the trunk writer signed` };
}

/** Public keys imported for checks, by their base64url bytes (only the deployment's own keys reach here). */
const publicKeys = new Map<string, Promise<CryptoKey>>();

/** Whether `signature` (base64url) is `key`'s signature of `text`; false for one that cannot be read. */
async function verifyWith(key: PublishedKey, text: string, signature: string): Promise<boolean> {
  try {
    let k = publicKeys.get(key.publicKey);
    if (!k) {
      k = crypto.subtle.importKey("raw", fromBase64url(key.publicKey), { name: ALG }, false, ["verify"]);
      publicKeys.set(key.publicKey, k);
      k.catch(() => publicKeys.delete(key.publicKey));
    }
    return await crypto.subtle.verify(ALG, await k, fromBase64url(signature), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

/** Load FT_NOTE_KEY: parse it, import its private half, and prove the halves match with one signature. */
async function loadSigner(secret: string): Promise<NoteSigner | null> {
  const parsed = parseKey(secret);
  if (typeof parsed === "string") return refuse(parsed);
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: parsed.d, x: parsed.x }, { name: ALG }, false, ["sign"]);
  } catch {
    return refuse("the runtime refused it as an Ed25519 private key");
  }
  const sign = async (text: string): Promise<string> => toBase64url(new Uint8Array(await crypto.subtle.sign(ALG, privateKey, new TextEncoder().encode(text))));
  const key: PublishedKey = { id: await keyIdOf(fromBase64url(parsed.x)), alg: "Ed25519", publicKey: parsed.x, since: parsed.since };
  try {
    const probe = signedText({ digest: "0".repeat(64), tree: "0".repeat(40), parents: [] });
    if (await verifyWith(key, probe, await sign(probe))) return { key, sign };
  } catch {
    // Falls through: a key that cannot sign is not used.
  }
  return refuse('its private half ("d") does not match its public half ("x")');
}

/** Say once why FT_NOTE_KEY is not used (never the secret itself), and sign nothing. */
function refuse(reason: string): null {
  console.error(`FT_NOTE_KEY is set but not used, so landings stay unsigned: ${reason}. It must be ${KEY_HELP}.`);
  return null;
}

/** FT_NOTE_KEY's private and public halves and its "since", or why it is not such a key. */
function parseKey(secret: string): { d: string; x: string; since: string | null } | string {
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    return "it is not JSON";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "it is not a JSON object";
  const k = value as Record<string, unknown>;
  if (k.kty !== "OKP" || k.crv !== "Ed25519") return 'it is not an Ed25519 key ("kty" must be "OKP" and "crv" "Ed25519")';
  if (typeof k.d !== "string" || !KEY_BYTES.test(k.d)) return 'it has no 32-byte private half ("d")';
  if (typeof k.x !== "string" || !KEY_BYTES.test(k.x)) return 'it has no 32-byte public half ("x")';
  const at = typeof k.since === "string" ? Date.parse(k.since) : Number.NaN;
  return { d: k.d, x: k.x, since: Number.isFinite(at) ? new Date(at).toISOString() : null };
}

function toBase64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const s = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
