import { createHash, createPublicKey, verify } from "node:crypto";
import type { Git } from "./clonecheck.ts";

/**
 * Two clone checks of `ft verify` beyond the note (clonecheck.ts), which scripts/verify_note.mjs repeats line for line:
 *
 * - Main: a landing counts only while the clone's origin/main (refs/remotes/origin/main, main as the trunk repository
 *   advertised it at the last fetch) still reaches its commit. One commit is checked with `git merge-base --is-ancestor`;
 *   --all lists every commit the notes ref names that origin/main no longer reaches (dropped from main, or main
 *   rewritten), the clue a force-push leaves, since the notes still name the commits main lost.
 * - The full-commit signature: with --keys, the gpgsig header of a landing whose note signature verifies is checked too
 *   (an SSH signature in the git namespace, sha512, over the commit object without that header, by a key the keys
 *   document lists, inside its window): it covers the message, author and committer the note signature leaves out, so a
 *   commit whose note signature verifies and whose full-commit signature does not had those changed after signing. A
 *   commit without one was signed before full-commit signatures (2026-10-17), unless an older landing has one.
 */

/** The ref a clone keeps main's last fetched position in, and its name in the lines. */
const MAIN_REF = "refs/remotes/origin/main";
const MAIN_NAME = "origin/main";
/** Commits looked back along the first-parent chain for an older landing with a full-commit signature (one commit checked). */
const LOOK_BACK = 64;

const short = (sha: string): string => sha.slice(0, 12);

/** The commit origin/main names in the clone, or null when the clone has none. */
export function originMain(git: Git): string | null {
  try {
    const sha = git(["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`]).toString("utf8").trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** One commit against origin/main: its line, and whether it fails (null main: not compared, which does not fail). */
export function mainLine(git: Git, sha: string): { text: string; tone: "ok" | "fail" | "skip" } {
  const main = originMain(git);
  if (main === null) return { text: `main not compared: this clone has no ${MAIN_NAME}`, tone: "skip" };
  let reached = true;
  try {
    git(["merge-base", "--is-ancestor", sha, main]);
  } catch {
    // Both commits are in the clone, so a refusal is git's answer: not an ancestor.
    reached = false;
  }
  return reached
    ? { text: `on ${MAIN_NAME}`, tone: "ok" }
    : { text: `not on ${MAIN_NAME}: main no longer reaches this commit (it was dropped from main, or main was rewritten)`, tone: "fail" };
}

/**
 * The lines of --all for the commits the notes name: one for each that origin/main does not reach, in the notes' order
 * (saying when it is not in the clone either), then a summary (commits a shallow clone lacks are not compared), or one
 * line when the clone has no origin/main; `off` counts the failures.
 */
export function notesOffMain(git: Git, notes: ReadonlyMap<string, string>): { lines: Array<{ text: string; tone: "ok" | "fail" | "skip" }>; off: number } {
  const main = originMain(git);
  if (main === null) return { lines: [{ text: `main not compared: this clone has no ${MAIN_NAME}`, tone: "skip" }], off: 0 };
  const reached = new Set(git(["rev-list", main, "--"]).toString("utf8").split("\n").filter(Boolean));
  let shallow = false;
  try {
    shallow = git(["rev-parse", "--is-shallow-repository"]).toString("utf8").trim() === "true";
  } catch {
    // An old git without the flag: treated as a full clone.
  }
  const missing = [...notes.keys()].filter((c) => !reached.has(c));
  const present = new Set(missing.length > 0 ? [...readRawObjects(git, missing).keys()] : []);
  const lines: Array<{ text: string; tone: "ok" | "fail" | "skip" }> = [];
  let off = 0;
  let unknown = 0;
  for (const c of missing) {
    if (!present.has(c) && shallow) {
      unknown++;
      continue;
    }
    off++;
    lines.push({ text: `${short(c)}  not on ${MAIN_NAME}: a note names this commit, and main no longer reaches it (it was dropped from main, or main was rewritten)${present.has(c) ? "" : "; the commit is not in this clone"}`, tone: "fail" });
  }
  const n = (x: number): string => x.toLocaleString("en-US");
  const rest = unknown > 0 ? ` (${n(unknown)} not compared: this clone is shallow)` : "";
  lines.push(
    off === 0
      ? { text: `${MAIN_NAME} reaches every commit the notes name (${n(notes.size - unknown)} note${notes.size - unknown === 1 ? "" : "s"})${rest}`, tone: "ok" }
      : { text: `${MAIN_NAME} does not reach ${n(off)} of the ${n(notes.size - unknown)} commits the notes name${rest}`, tone: "fail" },
  );
  return { lines, off };
}

/** Commit objects by id, their exact bytes, read in one `git cat-file --batch`; an id the clone does not have is left out. */
export function readRawObjects(git: Git, ids: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (ids.length === 0) return out;
  const buf = git(["cat-file", "--batch"], `${ids.join("\n")}\n`);
  let at = 0;
  for (const id of ids) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const head = buf.toString("utf8", at, nl).split(" ");
    at = nl + 1;
    if (head[1] === "missing" || head.length < 3) continue;
    const size = Number(head[2]);
    out.set(id, buf.subarray(at, at + size));
    at += size + 1;
  }
  return out;
}

/** A full-commit signature: good by a key, bad with why, or none. */
export type FullSignature = { status: "signed"; keyId: string } | { status: "bad"; why: string } | { status: "none" };

/** The commit object without its gpgsig header and the armored signature; null without one; "many" with more than one. */
function splitSigned(raw: Buffer): { payload: Buffer; armored: string } | null | "many" {
  const blank = raw.indexOf("\n\n");
  const end = blank < 0 ? raw.length : blank + 1;
  const lineEnd = (at: number): number => {
    const nl = raw.indexOf(10, at);
    return nl < 0 || nl >= end ? end : nl + 1;
  };
  let found: { from: number; to: number } | null = null;
  for (let at = 0; at < end; at = lineEnd(at)) {
    if (raw.toString("latin1", at, at + 7) !== "gpgsig ") continue;
    if (found) return "many";
    let to = lineEnd(at);
    while (to < end && raw[to] === 0x20) to = lineEnd(to);
    found = { from: at, to };
  }
  if (!found) return null;
  const lines = raw.toString("utf8", found.from + 7, found.to).replace(/\n$/, "").split("\n");
  return { payload: Buffer.concat([raw.subarray(0, found.from), raw.subarray(found.to)]), armored: `${[lines[0] ?? "", ...lines.slice(1).map((l) => l.slice(1))].join("\n")}\n` };
}

/** The committer time a raw commit object names, in Unix seconds, or null. */
function committedIn(raw: Buffer): number | null {
  const text = raw.toString("utf8");
  const line = (text.split("\n\n")[0] ?? "").split("\n").find((l) => l.startsWith("committer "));
  const m = line ? / (\d+) [+-]\d{4}$/.exec(line) : null;
  return m ? Number(m[1]) : null;
}

/**
 * A raw commit object's full-commit signature against the keys document (`keys`, firetrident-keys.json). `noteSigned`:
 * its note signature verified, so a full-commit signature that does not had the message, author or committer changed.
 * `windowWhy` is the keys' window rule (clonecheck.ts).
 */
export function fullSignatureState(raw: Buffer, keys: unknown, noteSigned: boolean, windowWhy: (id: string, since: unknown, until: unknown, time: number | null) => string | null): FullSignature {
  const split = splitSigned(raw);
  if (split === null) return { status: "none" };
  if (split === "many") return { status: "bad", why: "the commit carries more than one gpgsig header" };
  const form = "it is not an Ed25519 SSH signature in the form the trunk writer writes";
  const m = /^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=\n]+)\n-----END SSH SIGNATURE-----\n$/.exec(split.armored);
  if (!m) return { status: "bad", why: form };
  const blob = Buffer.from(m[1]!.replace(/\n/g, ""), "base64");
  let at = 0;
  const take = (n: number): Buffer | null => (n < 0 || at + n > blob.length ? null : blob.subarray(at, (at += n)));
  const string = (): Buffer | null => {
    const len = take(4);
    return len ? take(len.readUInt32BE(0)) : null;
  };
  const magic = take(6);
  const version = take(4);
  const keyBlob = string();
  const namespace = string();
  const reserved = string();
  const hash = string();
  const sigBlob = string();
  const pair = (b: Buffer | null): [string, Buffer] | null => {
    if (!b || b.length < 4) return null;
    const n = b.readUInt32BE(0);
    if (8 + n > b.length || 8 + n + b.readUInt32BE(4 + n) !== b.length) return null;
    return [b.toString("latin1", 4, 4 + n), b.subarray(8 + n)];
  };
  const key = pair(keyBlob);
  const sig = pair(sigBlob);
  const ok = magic?.toString("latin1") === "SSHSIG" && version?.readUInt32BE(0) === 1 && at === blob.length && key?.[0] === "ssh-ed25519" && key[1].length === 32 && sig?.[0] === "ssh-ed25519" && sig[1].length === 64;
  if (!ok || namespace?.toString("utf8") !== "git" || reserved?.length !== 0 || hash?.toString("utf8") !== "sha512") return { status: "bad", why: form };
  const publicKey = key![1];
  const keyId = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  const list = keys && typeof keys === "object" && Array.isArray((keys as { keys?: unknown }).keys) ? ((keys as { keys: unknown[] }).keys as Array<Record<string, unknown>>) : [];
  const listed = list.find((k) => k?.alg === "Ed25519" && typeof k.publicKey === "string" && Buffer.from(k.publicKey, "base64url").equals(publicKey));
  if (!listed) return { status: "bad", why: `it is by key ${keyId}, which the keys do not list` };
  const str = (b: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const signed = Buffer.concat([Buffer.from("SSHSIG"), str(Buffer.from("git")), str(Buffer.alloc(0)), str(Buffer.from("sha512")), str(createHash("sha512").update(split.payload).digest())]);
  let good = false;
  try {
    good = verify(null, signed, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey.toString("base64url") }, format: "jwk" }), sig![1]);
  } catch {
    good = false;
  }
  if (!good) return { status: "bad", why: noteSigned ? "the commit's message, author or committer changed after it was signed; its tree, parents and note digest are as signed" : "it does not verify: the commit changed after it was signed" };
  const outside = windowWhy(keyId, listed.since, listed.until, committedIn(raw));
  return outside === null ? { status: "signed", keyId } : { status: "bad", why: outside };
}

/** What a full-commit signature reads as after the note's verdict; `older`: an older landing that has one, for a commit without. */
export function fullSignatureWords(s: FullSignature, older: string | null): string {
  if (s.status === "signed") return "full commit signed";
  if (s.status === "bad") return `full-commit signature bad (${s.why})`;
  return older ? `no full-commit signature, though ${short(older)}, an older landing, has one` : "signed before full-commit signatures";
}

/** Whether a full-commit signature fails its landing (bad, or none where an older landing has one). */
export function fullSignatureFailed(s: FullSignature, older: string | null): boolean {
  return s.status === "bad" || (s.status === "none" && older !== null);
}

/** The newest landing below `sha` on its first-parent chain (at most LOOK_BACK commits) whose commit carries a gpgsig header, or null. */
export function olderFullSigned(git: Git, parents: string): string | null {
  const parent = parents.split(" ").filter(Boolean)[0];
  if (!parent) return null;
  let ids: string[];
  try {
    ids = git(["rev-list", "--first-parent", `--max-count=${LOOK_BACK}`, parent, "--"]).toString("utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
  const raws = readRawObjects(git, ids);
  for (const id of ids) {
    const raw = raws.get(id);
    if (!raw) continue;
    const text = raw.toString("utf8");
    const head = text.split("\n\n")[0] ?? "";
    if (/(^|\n)gpgsig /.test(head) && /(^|\n)FT-Note: sha256:[0-9a-f]{64}\s*$/.test(text)) return id;
  }
  return null;
}
