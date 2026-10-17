import type { Sha } from "@fire_trident/core";
import { LANDING_IDENTITY, writeCommitObject, type GitRepo } from "../artifacts/git.ts";
import type { Env } from "../env.ts";
import { commitContent, objectId } from "./objects.ts";
import { publishedKeys, type NoteSigner, type PublishedKey } from "./signature.ts";
import { writePending } from "./surgery.ts";

/**
 * Stock git signatures on the trunk writer's commits. With FT_NOTE_KEY set, every commit the trunk writer builds (each
 * landing and each system commit: antibodies, reverts) carries, besides its FT-Note-Signature trailer, a `gpgsig` header
 * holding an SSH signature made with the same Ed25519 key, the format `git commit -S` writes with gpg.format=ssh:
 *
 *   gpgsig -----BEGIN SSH SIGNATURE-----
 *    <base64, 70 columns a line>
 *    -----END SSH SIGNATURE-----
 *
 * after the committer line, each line after the first indented by one space (git's header continuation). The signature
 * covers the commit object without that header (exactly what objects.ts commitContent builds), in the SSH signature
 * format (PROTOCOL.sshsig) with namespace "git" and hash sha512: the Ed25519 signature of "SSHSIG" + string("git") +
 * string("") + string("sha512") + string(SHA-512 of the commit object), each string a 4-byte length and its bytes. So
 * stock git checks it with no FireTrident code:
 *
 *   curl -s <deployment>/.well-known/firetrident-allowed-signers > allowed_signers
 *   git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=allowed_signers verify-commit <commit>
 *
 * which says `Good "git" signature for lanes@firetrident.dev with ED25519 key SHA256:…`. The allowed signers list each
 * published key (trunk/signature.ts: the current one and every retired one) under the trunk writer's committer address,
 * with valid-after and valid-before from the key's window, which git checks against the commit's committer time. Without
 * the secret, commits are built exactly as before. The private key never leaves the signer.
 */

/** Where the allowed signers are published (text, one key a line, as ssh-keygen reads them). */
export const ALLOWED_SIGNERS_PATH = "/.well-known/firetrident-allowed-signers";
/** The principal every key is allowed for: the address the trunk writer commits as. */
export const SIGNER_PRINCIPAL = LANDING_IDENTITY.email;
/** The namespace git signs and verifies commits in. */
export const GIT_NAMESPACE = "git";

const KEY_TYPE = "ssh-ed25519";
const HASH = "sha512";
const MAGIC = "SSHSIG";
const VERSION = 1;
/** Base64 columns a line of the armored signature, as ssh-keygen writes it. */
const COLUMNS = 70;
const enc = new TextEncoder();

let signFailureLogged = false;

/** `bytes` as an SSH wire string: a 4-byte big-endian length, then the bytes. */
function sshString(bytes: Uint8Array | string): Uint8Array {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length);
  out.set(b, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const s = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** The SSH wire form of an Ed25519 public key given as its raw 32 bytes in base64url (a published key's `publicKey`). */
export function sshPublicKeyBlob(publicKey: string): Uint8Array {
  return concat([sshString(KEY_TYPE), sshString(fromBase64url(publicKey))]);
}

/** An Ed25519 public key in the SSH text form (an allowed signers or authorized keys line): "ssh-ed25519 AAAA…". */
export function sshPublicKey(publicKey: string): string {
  return `${KEY_TYPE} ${base64(sshPublicKeyBlob(publicKey))}`;
}

/** What an SSH signature of `payload` in `namespace` signs (PROTOCOL.sshsig "Signed Data"). */
export async function sshSignedData(payload: Uint8Array, namespace = GIT_NAMESPACE): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", payload));
  return concat([enc.encode(MAGIC), sshString(namespace), sshString(""), sshString(HASH), sshString(digest)]);
}

/** The armored SSH signature of `payload` in the git namespace by `signer`, ending with a newline. */
export async function sshSignature(payload: Uint8Array, signer: Pick<NoteSigner, "key" | "signBytes">): Promise<string> {
  const raw = await signer.signBytes(await sshSignedData(payload));
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, VERSION);
  const blob = concat([
    enc.encode(MAGIC),
    version,
    sshString(sshPublicKeyBlob(signer.key.publicKey)),
    sshString(GIT_NAMESPACE),
    sshString(""),
    sshString(HASH),
    sshString(concat([sshString(KEY_TYPE), sshString(raw)])),
  ]);
  const text = base64(blob);
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += COLUMNS) lines.push(text.slice(i, i + COLUMNS));
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

/** A commit object with `signature` as its gpgsig header, placed and indented the way git inserts it (end of the headers). */
export function withSignatureHeader(content: Uint8Array, signature: string): Uint8Array {
  let at = content.length;
  for (let i = 0; i + 1 < content.length; i++) {
    if (content[i] === 0x0a && content[i + 1] === 0x0a) {
      at = i + 1;
      break;
    }
  }
  const header = enc.encode(`gpgsig ${signature.replace(/\n+$/, "").split("\n").join("\n ")}\n`);
  return concat([content.subarray(0, at), header, content.subarray(at)]);
}

/**
 * `content` (a commit object as commitContent builds it) signed the stock git way by `signer`: the same bytes with a
 * gpgsig header. Unchanged when `signer` is null, and when signing fails (logged once; the commit goes on unsigned).
 */
export async function signCommit(content: Uint8Array, signer: Pick<NoteSigner, "key" | "signBytes"> | null): Promise<Uint8Array> {
  if (!signer) return content;
  try {
    return withSignatureHeader(content, await sshSignature(content, signer));
  } catch (e) {
    if (!signFailureLogged) console.error(`a trunk commit was left without its git signature: signing it failed (${e instanceof Error ? e.name : "unknown error"})`);
    signFailureLogged = true;
    return content;
  }
}

/**
 * Write a system commit (TrunkDO.systemCommitNow) as the trunk writer's identity at `at`: through writeCommitObject as
 * before when `signer` is null, otherwise built in memory (the same bytes), signed with signCommit and written as is.
 */
export async function writeTrunkCommit(repo: GitRepo, p: { tree: Sha; parents: Sha[]; message: string; at: number }, signer: Pick<NoteSigner, "key" | "signBytes"> | null): Promise<Sha> {
  if (!signer) return writeCommitObject(repo, p);
  const content = await signCommit(commitContent({ tree: p.tree, parents: p.parents, message: p.message, name: LANDING_IDENTITY.name, email: LANDING_IDENTITY.email, timestamp: Math.floor(p.at / 1000) }), signer);
  const id = objectId("commit", content);
  await writePending(repo, new Map([[id, { type: "commit" as const, content }]]));
  return id;
}

/** An ISO 8601 time as ssh-keygen reads a UTC timestamp: YYYYMMDDHHMMSSZ (to the second, rounded down). */
function sshTime(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:T]/g, "").replace(/\.\d+Z$/, "")}Z`;
}

/** The allowed signers line of one key: the trunk writer's address, the git namespace and the key's window, then the key. */
export function allowedSignerLine(key: PublishedKey): string {
  const after = key.since === null ? null : sshTime(key.since);
  const before = key.until === null ? null : sshTime(key.until);
  const options = [`namespaces="${GIT_NAMESPACE}"`, ...(after ? [`valid-after="${after}"`] : []), ...(before ? [`valid-before="${before}"`] : [])];
  return `${SIGNER_PRINCIPAL} ${options.join(",")} ${sshPublicKey(key.publicKey)}`;
}

/** The allowed signers file for `keys` (the published keys, current first): a comment line before each key's line. */
export function allowedSigners(keys: readonly PublishedKey[]): string {
  const head = [
    "# The keys this FireTrident deployment signs its trunk commits with, for stock git:",
    "# git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=<this file> verify-commit <commit>",
  ];
  if (keys.length === 0) return `${[...head, "# This deployment does not sign its commits (FT_NOTE_KEY is not set), so no key is listed."].join("\n")}\n`;
  const lines = keys.flatMap((k) => [
    k.until === null ? `# Key ${k.id}: signing now${k.since ? `, since ${k.since}` : ""}.` : `# Key ${k.id}: retired, signed from ${k.since ?? "its first commit"} until ${k.until}.`,
    allowedSignerLine(k),
  ]);
  return `${[...head, ...lines].join("\n")}\n`;
}

/**
 * GET /.well-known/firetrident-allowed-signers: the published keys (/.well-known/firetrident-keys.json) as an allowed
 * signers file for `git verify-commit`; only comments when the deployment does not sign. Public, like the keys.
 */
export async function allowedSignersResponse(env: Pick<Env, "FT_NOTE_KEY" | "FT_NOTE_KEYS_RETIRED">): Promise<Response> {
  return new Response(allowedSigners(await publishedKeys(env.FT_NOTE_KEY, env.FT_NOTE_KEYS_RETIRED)), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}
