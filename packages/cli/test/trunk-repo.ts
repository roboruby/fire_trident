import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landingMessage, type LineageNote, type Proposal } from "@fire_trident/core";
import { sealNote, withNoteDigest } from "../../worker/src/trunk/digest.ts";

/** The trunk writer's signer (trunk/signature.ts): its published key, and the signature of a text. */
export interface NoteSigner {
  key: { id: string; alg: "Ed25519"; publicKey: string; since: string | null };
  sign(text: string): Promise<string>;
}

/**
 * The trunk writer's own signing code (trunk/signature.ts), loaded at run time: its module names the Worker's Env type,
 * which this package's typecheck (Node types only) cannot read, so it is imported by a path the compiler does not follow.
 */
const signatures = (await import(new URL("../../worker/src/trunk/signature.ts", import.meta.url).href)) as {
  noteSigner(secret: string): Promise<NoteSigner | null>;
  keyIdOf(publicKey: Uint8Array): Promise<string>;
  withSignature(message: string, signer: NoteSigner | null, p: { digest: string; tree: string; parents: readonly string[] }): Promise<string>;
};
const { keyIdOf, noteSigner, withSignature } = signatures;

/**
 * A tiny trunk repository built with stock git the way the trunk writer builds one (trunk/TrunkDO.ts): each landing
 * commit's message is landingMessage's, signed (withSignature) when a signer is given and sealed (withNoteDigest) with
 * the digest of its note (sealNote), and the note is written under refs/notes/firetrident byte for byte. For the clone
 * checks (clonecheck.ts, scripts/verify_note.mjs).
 */

/** The identity and time every commit is made with, so a repository is the same each run. */
const ENV = {
  GIT_AUTHOR_NAME: "FireTrident",
  GIT_AUTHOR_EMAIL: "trunk@firetrident.invalid",
  GIT_COMMITTER_NAME: "FireTrident",
  GIT_COMMITTER_EMAIL: "trunk@firetrident.invalid",
  GIT_AUTHOR_DATE: "2026-10-16T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-16T12:00:00Z",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** A file change: its new text, or null to delete it. */
export type Files = Record<string, string | null>;

/** A repository under construction. */
export interface TrunkRepo {
  dir: string;
  git(args: string[], input?: string): string;
  /** The blob id of a text. */
  blob(text: string): string;
  /** A commit with no trailers (the import, an outside push). */
  plain(files: Files, message: string): string;
  /** A landing commit, sealed (and signed with `signer`), and its note on refs/notes/firetrident. */
  landing(files: Files, note: Omit<LineageNote, "schema" | "colonyId"> & Record<string, unknown>, p?: { signer?: NoteSigner | null; system?: string }): Promise<string>;
  /** Replace a commit's note with these bytes (as anyone with write access to the repository could). */
  rewriteNote(commit: string, text: string): void;
  /** Point a branch at a commit. */
  branch(name: string, at: string): void;
}

/** Every temporary directory and file made here, for removeAll. */
const made: string[] = [];

/** Remove every repository and keys file made so far. */
export function removeAll(): void {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

/** A new repository in a temporary directory, on branch main. */
export function trunkRepo(colonyId = "demo"): TrunkRepo {
  const dir = mkdtempSync(join(tmpdir(), "ft-trunk-"));
  made.push(dir);
  const git = (args: string[], input?: string): string => execFileSync("git", args, { cwd: dir, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...ENV } }).trim();
  git(["init", "-q", "-b", "main"]);
  const blob = (text: string): string => git(["hash-object", "-w", "--stdin"], text);
  let head: string | null = null;
  const stage = (files: Files): string => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) git(["update-index", "--force-remove", "--", path]);
      else git(["update-index", "--add", "--cacheinfo", `100644,${blob(text)},${path}`]);
    }
    return git(["write-tree"]);
  };
  const commit = (tree: string, message: string): string => {
    const sha = git(["commit-tree", tree, ...(head ? ["-p", head] : [])], message);
    git(["update-ref", "refs/heads/main", sha]);
    head = sha;
    return sha;
  };
  return {
    dir,
    git,
    blob,
    plain: (files, message) => commit(stage(files), message),
    async landing(files, note, p = {}) {
      const tree = stage(files);
      const full = { schema: "firetrident.lineage/v1", colonyId, ...note } as LineageNote;
      const sealed = await sealNote(full);
      const proposals = full.proposals.map((x) => ({ id: x.id, intentId: x.intent.id, agentId: x.agentId })) as unknown as Proposal[];
      const message = p.system ? `${p.system}\nFT-Landing: ${full.landingId}` : landingMessage({ id: full.landingId, intentIds: proposals.map((x) => x.intentId) }, proposals, {});
      const signed = await withSignature(message, p.signer ?? null, { digest: sealed.digest, tree, parents: head ? [head] : [] });
      const sha = commit(tree, withNoteDigest(signed, sealed.digest));
      git(["notes", "--ref=firetrident", "add", "-C", blob(sealed.text), sha]);
      return sha;
    },
    rewriteNote(commit, text) {
      git(["notes", "--ref=firetrident", "add", "-f", "-C", blob(text), commit]);
    },
    branch(name, at) {
      git(["update-ref", `refs/heads/${name}`, at]);
    },
  };
}

/** A fresh Ed25519 signing key as the trunk writer loads it (FT_NOTE_KEY), and a keys file listing its public half. */
export async function signingKey(dir: string): Promise<{ signer: NoteSigner; keyId: string; keysFile: string }> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const signer = await noteSigner(JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }));
  if (!signer) throw new Error("the test key did not load");
  const keyId = await keyIdOf(Buffer.from(jwk.x as string, "base64url"));
  const keysFile = join(dir, "..", `${keyId}-keys.json`);
  writeFileSync(keysFile, `${JSON.stringify({ keys: [signer.key] }, null, 2)}\n`);
  made.push(keysFile);
  return { signer, keyId, keysFile };
}

/** One proposal of a note, with the fields the trunk writer always writes. */
export function proposal(p: { id: string; writeSet: Array<{ path: string; blob: string | null }>; readSet?: Array<{ path: string; blob: string | null }>; decisions?: LineageNote["proposals"][number]["decisions"]; intent?: string }): LineageNote["proposals"][number] {
  return {
    id: p.id,
    agentId: `agt_${p.id}`,
    agentKind: "internal",
    model: "test-model",
    intent: { id: `int_${p.id}`, title: p.intent ?? `Change for ${p.id}`, why: "a test landing" },
    writeSet: p.writeSet,
    readSet: p.readSet ?? [],
    decisions: p.decisions ?? [],
    evidence: { checks: [{ name: "danger patterns", ok: true, ms: 1 }] },
  };
}
