import type { CommitSignatureCheck, NoteCheck } from "@fire_trident/core";
import { GIT_NAMESPACE, sshSignedData } from "./gitsig.ts";
import { keyIdOf, windowProblem, type PublishedKey } from "./signature.ts";

/**
 * FireTrident's own check of a commit's full-commit signature: the gpgsig header the trunk writer adds with FT_NOTE_KEY
 * (trunk/gitsig.ts), an SSH signature in the git namespace over the whole commit object without that header, so over its
 * tree, parents, author, committer and message, trailers included. The FT-Note-Signature trailer (trunk/signature.ts)
 * covers only the note's digest, the tree and the parents: a commit whose note signature verifies and whose full-commit
 * signature does not had its message, author or committer changed after it was signed. The key must be one the
 * deployment publishes (the current one or a retired one), and its window must cover the commit's committer time, as
 * `git verify-commit` checks with /.well-known/firetrident-allowed-signers. Commits built before full-commit signatures
 * (2026-10-17) carry only the note signature: `note-only`, which is not a failure, unless an older landing already
 * carries one (flagLateSignatures). Read only; never throws.
 */

const NL = 0x0a;
const SPACE = 0x20;
const HEADER = new TextEncoder().encode("gpgsig ");
const dec = new TextDecoder();

/** The commit object as git verifies it (without its gpgsig header) and the armored signature; null without one; `many` with more than one. */
export function splitCommitSignature(raw: Uint8Array): { payload: Uint8Array; armored: string } | null | "many" {
  // The headers end at the first empty line.
  let end = raw.length;
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] === NL && raw[i + 1] === NL) {
      end = i + 1;
      break;
    }
  }
  const starts = (at: number, prefix: Uint8Array): boolean => prefix.every((b, k) => raw[at + k] === b);
  const lineEnd = (at: number): number => {
    const nl = raw.indexOf(NL, at);
    return nl < 0 || nl >= end ? end : nl + 1;
  };
  let found: { from: number; to: number } | null = null;
  for (let at = 0; at < end; at = lineEnd(at)) {
    if (!starts(at, HEADER)) continue;
    if (found) return "many";
    let to = lineEnd(at);
    while (to < end && raw[to] === SPACE) to = lineEnd(to);
    found = { from: at, to };
  }
  if (!found) return null;
  const lines = dec.decode(raw.subarray(found.from + HEADER.length, found.to)).replace(/\n$/, "").split("\n");
  const armored = `${[lines[0] ?? "", ...lines.slice(1).map((l) => l.slice(1))].join("\n")}\n`;
  const payload = new Uint8Array(raw.length - (found.to - found.from));
  payload.set(raw.subarray(0, found.from), 0);
  payload.set(raw.subarray(found.to), found.from);
  return { payload, armored };
}

/** The fields of an armored SSH signature (PROTOCOL.sshsig) the check needs, or null when it is not one that can be read. */
export function readSshSignature(armored: string): { publicKey: Uint8Array; namespace: string; reserved: string; hash: string; keyType: string; sigType: string; signature: Uint8Array } | null {
  const m = /^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=\n]+)\n-----END SSH SIGNATURE-----\n?$/.exec(armored);
  if (!m) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m[1]!.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const take = (n: number): Uint8Array | null => {
    if (n < 0 || at + n > bytes.length) return null;
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const string = (): Uint8Array | null => {
    if (at + 4 > bytes.length) return null;
    const n = view.getUint32(at);
    at += 4;
    return take(n);
  };
  const magic = take(6);
  if (!magic || dec.decode(magic) !== "SSHSIG" || at + 4 > bytes.length || view.getUint32(at) !== 1) return null;
  at += 4;
  const keyBlob = string();
  const namespace = string();
  const reserved = string();
  const hash = string();
  const sigBlob = string();
  if (!keyBlob || !namespace || !reserved || !hash || !sigBlob || at !== bytes.length) return null;
  const pair = (blob: Uint8Array): [string, Uint8Array] | null => {
    const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    if (blob.length < 4) return null;
    const n = v.getUint32(0);
    if (4 + n + 4 > blob.length) return null;
    const m2 = v.getUint32(4 + n);
    if (8 + n + m2 !== blob.length) return null;
    return [dec.decode(blob.subarray(4, 4 + n)), blob.subarray(8 + n, 8 + n + m2)];
  };
  const key = pair(keyBlob);
  const sig = pair(sigBlob);
  if (!key || !sig) return null;
  return { keyType: key[0], publicKey: key[1], namespace: dec.decode(namespace), reserved: dec.decode(reserved), hash: dec.decode(hash), sigType: sig[0], signature: sig[1] };
}

/** The committer time a raw commit object names, in Unix seconds, or null. */
export function committedAt(raw: Uint8Array): number | null {
  const text = dec.decode(raw);
  const head = text.slice(0, Math.max(0, text.indexOf("\n\n")) || text.length);
  const line = head.split("\n").find((l) => l.startsWith("committer "));
  const m = line ? / (\d+) [+-]\d{4}$/.exec(line) : null;
  return m ? Number(m[1]) : null;
}

/**
 * A raw commit object's full-commit signature against the published `keys`. `noteSigned`: the commit's FT-Note-Signature
 * verified, so a bad full-commit signature means its message, author or committer changed after signing.
 */
export async function checkCommitSignature(raw: Uint8Array, keys: readonly PublishedKey[], noteSigned: boolean): Promise<CommitSignatureCheck> {
  const split = splitCommitSignature(raw);
  if (split === null) return { status: noteSigned ? "note-only" : "unsigned" };
  if (split === "many") return { status: "bad-signature", detail: "the commit carries more than one gpgsig header, which the trunk writer never writes" };
  const s = readSshSignature(split.armored);
  if (!s || s.keyType !== "ssh-ed25519" || s.sigType !== "ssh-ed25519" || s.publicKey.length !== 32 || s.signature.length !== 64) {
    return { status: "bad-signature", detail: "the full-commit signature is not an Ed25519 SSH signature in the form the trunk writer writes" };
  }
  if (s.namespace !== GIT_NAMESPACE || s.reserved !== "" || s.hash !== "sha512") return { status: "bad-signature", detail: `the full-commit signature is made in namespace "${s.namespace.slice(0, 40)}" with ${s.hash.slice(0, 20)}, where the trunk writer signs in "git" with sha512` };
  const keyId = await keyIdOf(s.publicKey);
  const key = keys.find((k) => k.id === keyId && sameBytes(fromBase64url(k.publicKey), s.publicKey));
  if (!key) return { status: "bad-signature", keyId, detail: `the full-commit signature is by key ${keyId}, which this deployment does not publish` };
  if (!(await verifies(s.publicKey, s.signature, await sshSignedData(split.payload)))) {
    return {
      status: "bad-signature",
      keyId,
      detail: noteSigned
        ? `the full-commit signature does not verify with key ${keyId}, while the note signature over its tree, parents and note digest does: the commit's message, author or committer changed after it was signed`
        : `the full-commit signature does not verify with key ${keyId}: the commit changed after it was signed`,
    };
  }
  const outside = windowProblem(key, committedAt(raw));
  return outside ? { status: "bad-signature", keyId, detail: `full-commit signature: ${outside}` } : { status: "signed", keyId };
}

/**
 * Signatures that stopped (fail-open signing before 2026-10-18, or a commit replaced by one without them): in `checks`,
 * newest first, a commit with no full-commit signature newer than a landing whose full-commit signature verifies, and an
 * unsigned commit newer than a landing whose note signature verifies, become bad signatures that say so. For a deployment
 * that signs now (`signing`); the checks otherwise come back as they are.
 */
export function flagLateSignatures(checks: NoteCheck[], signing: boolean): NoteCheck[] {
  if (!signing) return checks;
  const out = [...checks];
  let full: string | null = null;
  let note: string | null = null;
  for (let i = out.length - 1; i >= 0; i--) {
    const c = out[i]!;
    let next = c;
    const cs = c.commitSignature?.status;
    if (cs === "signed") full ??= c.landingId;
    else if ((cs === "note-only" || cs === "unsigned") && full !== null) {
      next = { ...next, commitSignature: { status: "bad-signature", detail: `this commit has no full-commit signature, though ${full}, an older landing, has one: it was built while signing failed, or replaced` } };
    }
    const ns = c.signature?.status;
    if (ns === "signed") note ??= c.landingId;
    else if (ns === "unsigned" && note !== null) {
      next = { ...next, signature: { status: "bad-signature", detail: `this commit is unsigned, though ${note}, an older landing, is signed: it was built while signing failed, or replaced` } };
    }
    out[i] = next;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function verifies(publicKey: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, signature, data);
  } catch {
    return false;
  }
}

function fromBase64url(text: string): Uint8Array {
  try {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}
