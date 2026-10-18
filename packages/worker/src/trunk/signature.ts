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
 *
 * A key ring: FT_NOTE_KEYS_RETIRED (optional, public data) lists the keys the deployment signed with before, as a JSON
 * array of {"x": <raw public key, base64url>, "since": <ISO 8601, optional>, "until": <ISO 8601>}. The keys document lists
 * the current key (until null) and every retired one, and a signature checks out when its key is listed and the key's
 * window, from since to until (each to the second, both ends included; an absent since is open), covers the commit's
 * committer time. The current key's window is its "since" onward, so FT_NOTE_KEY's "since" must not be later than the
 * first commit it signed. Rotating FT_NOTE_KEY leaves older signatures good once the old key is listed as retired. To
 * rotate: add the current key's x to FT_NOTE_KEYS_RETIRED with its since and an until an hour or more after the switch
 * (ssh-keygen reads git's local commit times an hour late in a time zone on daylight saving time, so the margin keeps
 * the old key's last commits good for `git verify-commit` everywhere), set FT_NOTE_KEY to the new key with "since" at
 * the switch, and deploy. A key that leaked is not retired but dropped: what it signed then reads as a bad signature.
 *
 * The same key also signs each commit the stock git way (trunk/gitsig.ts), so `git verify-commit` checks it too.
 *
 * Signing fails closed: once FT_NOTE_KEY's signer has loaded (its halves proven to match by one signature), a signature
 * that fails at landing time throws SigningFailed, logged and counted every time, so that cycle lands nothing and its
 * lanes retry; no commit goes out unsigned while the key is good. A secret that never loads (not such a key) leaves
 * landings unsigned as before, since refusing them would stop every colony on a typo; noteKeyProblem says why, and the
 * note checks (`ft verify`) report it as a failure.
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
const RETIRED_ENTRY = '{"x":"<public key, base64url>","since":"<ISO date, optional>","until":"<ISO date>"}';
const RETIRED_HELP = `a JSON array of ${RETIRED_ENTRY}`;

/** A public key as GET /.well-known/firetrident-keys.json lists it. */
export interface PublishedKey {
  /** The first 16 hex digits of the SHA-256 of the raw public key. */
  id: string;
  alg: "Ed25519";
  /** The raw 32-byte public key, base64url without padding. */
  publicKey: string;
  /** When the key started signing (ISO 8601, from FT_NOTE_KEY's "since"), or null when the secret does not say. */
  since: string | null;
  /** When a retired key stopped signing (ISO 8601, from FT_NOTE_KEYS_RETIRED), or null for the key that signs now. */
  until: string | null;
}

/** The trunk writer's signing key: its published half, and the signature of a text, or of bytes, with its private half. */
export interface NoteSigner {
  key: PublishedKey;
  sign(text: string): Promise<string>;
  /** The raw 64-byte Ed25519 signature of `data` (stock git signatures, trunk/gitsig.ts). */
  signBytes(data: Uint8Array): Promise<Uint8Array>;
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
/** Why the secret being loaded was refused (refuse), read by noteKeyProblem. */
let refused: string | null = null;
/** Signatures that failed at landing time since this isolate started (SigningFailed). */
let signFailures = 0;

/**
 * A signature that failed at landing time with a key that loaded: the commit is not built, so nothing lands unsigned.
 * The landing cycle that hit it fails and its lanes retry; a system commit (an antibody, a revert) fails to its caller.
 */
export class SigningFailed extends Error {
  constructor(what: string, cause: unknown) {
    signFailures++;
    super(`${what} was not signed, so it was held: signing failed (${cause instanceof Error ? cause.name : "unknown error"}); its changes are tried again (${signFailures} signing failure${signFailures === 1 ? "" : "s"} since this trunk writer started)`);
    this.name = "SigningFailed";
    console.error(this.message);
  }
}

/** How many signatures failed at landing time since this isolate started (SigningFailed). */
export function signingFailures(): number {
  return signFailures;
}

/**
 * The signer FT_NOTE_KEY holds, or null when it is absent, or is not an Ed25519 private key as a JWK whose halves match
 * (said once in the log, never with the secret). Never throws.
 */
export function noteSigner(secret: unknown): Promise<NoteSigner | null> {
  if (typeof secret !== "string" || secret.trim() === "") return Promise.resolve(null);
  if (loaded?.secret !== secret) {
    refused = null;
    loaded = { secret, signer: loadSigner(secret).catch(() => refuse("it could not be loaded")) };
  }
  return loaded.signer;
}

/**
 * Why FT_NOTE_KEY is set and still signs nothing (not an Ed25519 private key as a JWK whose halves match), as a sentence
 * the note checks report; null when it is absent or signs. Never says the secret. Never throws.
 */
export async function noteKeyProblem(secret: unknown): Promise<string | null> {
  if (typeof secret !== "string" || secret.trim() === "") return null;
  if (await noteSigner(secret)) return null;
  return `FT_NOTE_KEY is set but cannot sign (${refused ?? "it could not be loaded"}), so landings go out unsigned: set it to ${KEY_HELP} and deploy again`;
}

/** The id of the key that signs lineage notes (GET /api/about), or null when landings are not signed. */
export async function noteKeyId(secret: unknown): Promise<string | null> {
  return (await noteSigner(secret))?.key.id ?? null;
}

/**
 * The keys a checker accepts: the one FT_NOTE_KEY holds, first, then each key FT_NOTE_KEYS_RETIRED (`retired`) lists, the
 * most recently retired first; none when the deployment has never signed. A retired entry for the current key is left out.
 */
export async function publishedKeys(secret: unknown, retired?: unknown): Promise<PublishedKey[]> {
  const signer = await noteSigner(secret);
  const out = signer ? [signer.key] : [];
  for (const k of await retiredKeys(retired)) if (!out.some((o) => o.id === k.id)) out.push(k);
  return out;
}

/** The retired keys FT_NOTE_KEYS_RETIRED last held, kept for the isolate's life like the signer. */
let retiredLoaded: { value: string; keys: Promise<PublishedKey[]> } | null = null;

/**
 * The keys FT_NOTE_KEYS_RETIRED lists (see the module comment), the most recently retired first; none when it is absent.
 * An entry that is not such a key is left out, said once in the log with its place in the list. Never throws.
 */
export function retiredKeys(value: unknown): Promise<PublishedKey[]> {
  if (typeof value !== "string" || value.trim() === "") return Promise.resolve([]);
  if (retiredLoaded?.value !== value) retiredLoaded = { value, keys: loadRetired(value).catch(() => []) };
  return retiredLoaded.keys;
}

/**
 * Why `key`'s window does not cover a commit made at `committedAt` (Unix seconds, the committer time), or null when it
 * does. A key with neither since nor until covers every commit, also one whose time is not known.
 */
export function windowProblem(key: Pick<PublishedKey, "id" | "since" | "until">, committedAt: unknown): string | null {
  const since = key.since === null ? null : Math.floor(Date.parse(key.since) / 1000);
  const until = key.until === null ? null : Math.floor(Date.parse(key.until) / 1000);
  if (since === null && until === null) return null;
  const span = `which signed from ${key.since ?? "its first commit"} until ${key.until ?? "now"}`;
  if (typeof committedAt !== "number" || !Number.isFinite(committedAt)) return `the signature is by key ${key.id}, ${span}, and the commit's time is not known, so the window cannot be checked`;
  const t = Math.floor(committedAt);
  if ((since !== null && !(t >= since)) || (until !== null && !(t <= until))) return `the signature is by key ${key.id}, ${span}; this commit is dated ${new Date(t * 1000).toISOString()}, outside that window`;
  return null;
}

/**
 * GET /.well-known/firetrident-keys.json: {"keys":[{"id","alg","publicKey","since","until"}]}, the current key first
 * (until null), then the retired ones; an empty list when the deployment does not sign. Public: any git client checks a
 * commit's FT-Note-Signature with it (scripts/verify_note.mjs --keys).
 */
export async function keysResponse(env: Pick<Env, "FT_NOTE_KEY" | "FT_NOTE_KEYS_RETIRED">): Promise<Response> {
  const body = `${JSON.stringify({ keys: await publishedKeys(env.FT_NOTE_KEY, env.FT_NOTE_KEYS_RETIRED) }, null, 2)}\n`;
  return new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}

/**
 * `message` with its commit's signature line appended, over the note's `digest`, the commit's `tree` and its `parents`;
 * the caller then adds the FT-Note trailer as the last line (withNoteDigest). Unchanged when `signer` is null. Throws
 * SigningFailed when signing fails, so the commit is not built unsigned.
 */
export async function withSignature(message: string, signer: Pick<NoteSigner, "key" | "sign"> | null, p: { digest: string; tree: Sha; parents: readonly Sha[] }): Promise<string> {
  if (!signer) return message;
  let signature: string;
  try {
    signature = await signer.sign(signedText(p));
  } catch (e) {
    throw new SigningFailed("a trunk commit's lineage note", e);
  }
  return `${message.replace(/\s+$/, "")}\n${SIGNATURE_TRAILER}: ed25519 ${signer.key.id} ${signature}`;
}

/**
 * A commit's signature against the published `keys`: `signed`, `bad-signature` with why, or `unsigned` (no signature line
 * just above a last-line FT-Note trailer). Signed means by a listed key whose window covers the commit's `committedAt`
 * (Unix seconds; see windowProblem). Null when it cannot be checked: the commit's parents are not known. Never throws.
 */
export async function checkSignature(commit: { tree: string; message: string; parents?: readonly string[]; committedAt?: number }, keys: readonly PublishedKey[]): Promise<NoteSignatureCheck | null> {
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
  if (!(await verifyWith(key, signedText({ digest, tree: commit.tree, parents: commit.parents }), m[2]!))) {
    return { status: "bad-signature", keyId, detail: `the signature does not verify with key ${keyId}: the note digest, tree or parent this commit carries is not what the trunk writer signed` };
  }
  // Key ring: a key counts only for commits made while it was signing.
  const outside = windowProblem(key, commit.committedAt);
  return outside ? { status: "bad-signature", keyId, detail: outside } : { status: "signed", keyId };
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
  const signBytes = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign(ALG, privateKey, data));
  const sign = async (text: string): Promise<string> => toBase64url(await signBytes(new TextEncoder().encode(text)));
  const key: PublishedKey = { id: await keyIdOf(fromBase64url(parsed.x)), alg: "Ed25519", publicKey: parsed.x, since: parsed.since, until: null };
  try {
    const probe = signedText({ digest: "0".repeat(64), tree: "0".repeat(40), parents: [] });
    if (await verifyWith(key, probe, await sign(probe))) return { key, sign, signBytes };
  } catch {
    // Falls through: a key that cannot sign is not used.
  }
  return refuse('its private half ("d") does not match its public half ("x")');
}

/** Read FT_NOTE_KEYS_RETIRED: each entry a public key that imports, with an until and a since no later than it. */
async function loadRetired(value: string): Promise<PublishedKey[]> {
  let list: unknown;
  try {
    list = JSON.parse(value);
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) {
    console.error(`FT_NOTE_KEYS_RETIRED is set but not used, so no retired key is published: it is not a JSON array. It must be ${RETIRED_HELP}.`);
    return [];
  }
  const out: PublishedKey[] = [];
  const problems: string[] = [];
  for (const [i, entry] of list.entries()) {
    const k = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const at = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : Number.NaN);
    const since = at(k.since);
    const until = at(k.until);
    let why: string | null = null;
    if (typeof k.x !== "string" || !KEY_BYTES.test(k.x)) why = 'it has no 32-byte public key ("x")';
    else if (!Number.isFinite(until)) why = 'it has no "until" date';
    else if (k.since !== undefined && k.since !== null && !Number.isFinite(since)) why = 'its "since" is not a date';
    else if (Number.isFinite(since) && since > until) why = 'its "since" is after its "until"';
    else if (!(await importable(k.x))) why = "the runtime refused it as an Ed25519 public key";
    if (why !== null || typeof k.x !== "string") {
      problems.push(`entry ${i + 1}: ${why ?? "it is not a key"}`);
      continue;
    }
    const id = await keyIdOf(fromBase64url(k.x));
    if (out.some((o) => o.id === id)) continue;
    out.push({ id, alg: "Ed25519", publicKey: k.x, since: Number.isFinite(since) ? new Date(since).toISOString() : null, until: new Date(until).toISOString() });
  }
  if (problems.length > 0) console.error(`FT_NOTE_KEYS_RETIRED: ${problems.join("; ")}; those entries are not published. Each must be ${RETIRED_ENTRY}.`);
  return out.sort((a, b) => Date.parse(b.until ?? "") - Date.parse(a.until ?? ""));
}

/** Whether a base64url public key imports as an Ed25519 key. */
async function importable(x: string): Promise<boolean> {
  try {
    await crypto.subtle.importKey("raw", fromBase64url(x), { name: ALG }, false, ["verify"]);
    return true;
  } catch {
    return false;
  }
}

/** Say once why FT_NOTE_KEY is not used (never the secret itself), keep why for noteKeyProblem, and sign nothing. */
function refuse(reason: string): null {
  refused = reason;
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
