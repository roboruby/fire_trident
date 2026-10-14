import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import { serializeNote } from "@fire_trident/core";
import type { LineageNote } from "@fire_trident/core";
import { buildTree, ensureRepo, memoryFs, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { sealNote, withNoteDigest } from "../../src/trunk/digest.ts";
import { addNotes } from "../../src/trunk/notes.ts";
import { noteSigner, withSignature, type NoteSigner, type PublishedKey } from "../../src/trunk/signature.ts";
import { bindingSource, checkLandings, localSource, type LandingRow } from "../../src/trunk/verify.ts";

/**
 * Signed lineage notes, checked: by the trunk writer's note check with the deployment's published keys, and by
 * scripts/verify_note.mjs --keys over a clone, with stock git.
 */

const REF = "refs/notes/firetrident";
const AT = 1_760_000_000_000;

/** A fresh Ed25519 key as FT_NOTE_KEY holds it (generated here: no private key is part of the repository). */
async function newSigner(): Promise<{ secret: string; signer: NoteSigner }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x });
  return { secret, signer: (await noteSigner(secret))! };
}

const noteFor = (id: string): LineageNote => ({ schema: "firetrident.lineage/v1", landingId: id, colonyId: "c", proposals: [] });

/** A landing commit as the trunk writer builds it: sealed (unless `sealed` is false) and signed by `signer` when given. */
async function landing(r: GitRepo, id: string, p: { signer?: NoteSigner | null; parents?: string[]; sealed?: boolean } = {}): Promise<{ row: LandingRow; text: string; tree: string; message: string }> {
  const { text, digest } = await sealNote(noteFor(id));
  const blob = await writeLocalBlob(r, new TextEncoder().encode(id));
  const tree = await buildTree(r, new Map([[`${id}.txt`, { blob, mode: "100644" }]]));
  const parents = p.parents ?? [];
  const base = `Land 1 change: ${id}\n\nFT-Landing: ${id}`;
  const message = p.sealed === false ? base : withNoteDigest(await withSignature(base, p.signer ?? null, { digest, tree, parents }), digest);
  const sha = await writeCommitObject(r, { tree, parents, message, at: AT });
  return { row: { landingId: id, trunkSha: sha, at: 1, note: text, waiting: false }, text, tree, message };
}

async function memoryRepo(): Promise<GitRepo> {
  const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
  await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
  return r;
}

describe("the note check with the deployment's keys", () => {
  it("says whether each commit is signed, beside whether its note is intact", async () => {
    const r = await memoryRepo();
    const old = await newSigner();
    const now = await newSigner();
    const unsealed = await landing(r, "lnd_0", { sealed: false });
    const unsigned = await landing(r, "lnd_1", { parents: [unsealed.row.trunkSha] });
    const byOld = await landing(r, "lnd_2", { signer: old.signer, parents: [unsigned.row.trunkSha] });
    const signed = await landing(r, "lnd_3", { signer: now.signer, parents: [byOld.row.trunkSha] });
    const edited = await landing(r, "lnd_4", { signer: now.signer, parents: [signed.row.trunkSha] });
    await addNotes(r, { ref: REF, notes: [unsigned, byOld, signed, edited].map((x) => ({ oid: x.row.trunkSha, note: x.text })), at: AT, migrate: 0 });
    // Someone with write access rewrites one note; its commit is still the one the trunk writer signed.
    await addNotes(r, { ref: REF, notes: [{ oid: edited.row.trunkSha, note: serializeNote({ ...noteFor("lnd_4"), colonyId: "elsewhere" }) }], at: AT + 1, migrate: 0 });
    const tip = (await git.resolveRef({ fs: r.fs, dir: r.dir, ref: REF })) as string;
    const keys: PublishedKey[] = [now.signer.key];
    const checks = await checkLandings([unsealed, unsigned, byOld, signed, edited].map((x) => x.row), { src: localSource(r), tip, keys });
    expect(checks.map((c) => [c.landingId, c.status, c.signature?.status])).toEqual([
      ["lnd_0", "no-trailer", "unsigned"],
      ["lnd_1", "intact", "unsigned"],
      // Signed by a key the deployment no longer publishes.
      ["lnd_2", "intact", "bad-signature"],
      ["lnd_3", "intact", "signed"],
      ["lnd_4", "altered", "signed"],
    ]);
    expect(checks[2]?.signature).toEqual({ status: "bad-signature", keyId: old.signer.key.id, detail: `the signature names key ${old.signer.key.id}, which this deployment does not publish` });
    expect(checks[3]?.signature).toEqual({ status: "signed", keyId: now.signer.key.id });

    // Without keys (a deployment that does not sign), the checks say nothing about signatures, as before.
    const plain = await checkLandings([signed.row], { src: localSource(r), tip });
    expect(plain[0]).toMatchObject({ status: "intact" });
    expect(plain[0]).not.toHaveProperty("signature");
    expect((await checkLandings([signed.row], { src: localSource(r), tip, keys: [] }))[0]).not.toHaveProperty("signature");
  });

  it("checks a signature read through the binding, which says the commit's parents", async () => {
    const r = await memoryRepo();
    const k = await newSigner();
    const base = await landing(r, "lnd_0", { sealed: false });
    const signed = await landing(r, "lnd_1", { signer: k.signer, parents: [base.row.trunkSha] });
    await addNotes(r, { ref: REF, notes: [{ oid: signed.row.trunkSha, note: signed.text }], at: AT, migrate: 0 });
    const tip = (await git.resolveRef({ fs: r.fs, dir: r.dir, ref: REF })) as string;
    const local = localSource(r);
    // The Artifacts binding's answers over this repository's objects.
    const binding = bindingSource(async () =>
      ({
        readCommit: async (hash: string) => {
          const c = await git.readCommit({ fs: r.fs, dir: r.dir, oid: hash });
          return { hash, treeHash: c.commit.tree, message: c.commit.message.replace(/\n$/, ""), parents: c.commit.parent };
        },
        readTree: async (hash: string) => (await local.tree(hash))?.map((e) => ({ name: e.name, hash: e.oid, mode: e.type === "tree" ? "40000" : "100644", type: e.type })) ?? null,
        readBlob: async (hash: string) => {
          const b = await local.blob(hash);
          return b ? new Blob([b]) : null;
        },
      }) as unknown as ArtifactsRepo,
    );
    const [check] = await checkLandings([signed.row], { src: binding, tip, keys: [k.signer.key] });
    expect(check).toMatchObject({ status: "intact", signature: { status: "signed", keyId: k.signer.key.id } });
  });
});

/** Node built-ins for the stock-git check (the worker compiles against workers types, so they are typed here). */
interface NodeBits {
  execFile(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }, done: (err: { code?: unknown } | null, stdout: string, stderr: string) => void): void;
  execFileSync(cmd: string, args: string[], opts?: { stdio?: "ignore" }): unknown;
  fs: unknown;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, text: string): void;
  tmpdir(): string;
  join(...parts: string[]): string;
  fileURLToPath(url: URL): string;
  createServer(handler: (req: { url?: string }, res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }) => void): {
    listen(port: number, host: string, done: () => void): void;
    address(): { port: number };
    close(): void;
  };
  process: { execPath: string; env: Record<string, string | undefined> };
}
const NODE: NodeBits = await (async () => {
  const [cp, fs, os, path, url, http] = (await Promise.all(["node:child_process", "node:fs", "node:os", "node:path", "node:url", "node:http"].map((m) => import(m)))) as [
    Pick<NodeBits, "execFile" | "execFileSync">,
    Pick<NodeBits, "mkdtempSync" | "rmSync" | "writeFileSync">,
    Pick<NodeBits, "tmpdir">,
    Pick<NodeBits, "join">,
    Pick<NodeBits, "fileURLToPath">,
    Pick<NodeBits, "createServer">,
  ];
  return {
    execFile: cp.execFile,
    execFileSync: cp.execFileSync,
    fs,
    mkdtempSync: fs.mkdtempSync,
    rmSync: fs.rmSync,
    writeFileSync: fs.writeFileSync,
    tmpdir: os.tmpdir,
    join: path.join,
    fileURLToPath: url.fileURLToPath,
    createServer: http.createServer,
    process: (globalThis as unknown as { process: NodeBits["process"] }).process,
  };
})();
// The tests run in Node, where a module knows its own URL (the workers types leave it out).
const HERE = (import.meta as ImportMeta & { url: string }).url;
const SCRIPT = NODE.fileURLToPath(new URL("../../../../scripts/verify_note.mjs", HERE));

const hasGit = (() => {
  try {
    NODE.execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("scripts/verify_note.mjs with stock git", () => {
  it("prints intact as before without --keys, and with them intact and signed, unsigned, or a bad signature", async () => {
    const dir = NODE.mkdtempSync(NODE.join(NODE.tmpdir(), "ft-signed-"));
    const keysDir = NODE.mkdtempSync(NODE.join(NODE.tmpdir(), "ft-keys-"));
    const env = { ...NODE.process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
    /** The script run in the clone: its exit code and what it printed. */
    const run = (...args: string[]): Promise<{ code: number; out: string; err: string }> =>
      new Promise((resolve) =>
        NODE.execFile(NODE.process.execPath, [SCRIPT, ...args], { cwd: dir, env }, (e, stdout, stderr) =>
          resolve({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(stdout).trim(), err: String(stderr).trim() }),
        ),
      );
    try {
      const r: GitRepo = { fs: NODE.fs as GitRepo["fs"], dir, cache: {} };
      await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
      const k = await newSigner();
      const other = await newSigner();
      const keysFile = NODE.join(keysDir, "firetrident-keys.json");
      const otherFile = NODE.join(keysDir, "other-keys.json");
      NODE.writeFileSync(keysFile, JSON.stringify({ keys: [k.signer.key] }));
      NODE.writeFileSync(otherFile, JSON.stringify({ keys: [other.signer.key] }));
      // A key listed under an id that is not its own counts for nothing.
      const misnamedFile = NODE.join(keysDir, "misnamed-keys.json");
      NODE.writeFileSync(misnamedFile, JSON.stringify({ keys: [{ ...other.signer.key, id: k.signer.key.id }] }));

      const init = await landing(r, "lnd_0", { sealed: false });
      const unsigned = await landing(r, "lnd_1", { parents: [init.row.trunkSha] });
      const signed = await landing(r, "lnd_2", { signer: k.signer, parents: [unsigned.row.trunkSha] });
      await addNotes(r, { ref: REF, notes: [unsigned, signed].map((x) => ({ oid: x.row.trunkSha, note: x.text })), at: AT, migrate: 0 });
      const [c0, c1, c2] = [init, unsigned, signed].map((x) => x.row.trunkSha) as [string, string, string];

      // Without --keys, exactly as before.
      expect(await run(c2)).toMatchObject({ code: 0, out: "intact" });
      expect(await run(c1)).toMatchObject({ code: 0, out: "intact" });
      expect(await run(c0)).toMatchObject({ code: 1, out: "no FT-Note trailer" });
      // With --keys, before or after the commit.
      expect(await run(c2, "--keys", keysFile)).toMatchObject({ code: 0, out: `intact, signed by ${k.signer.key.id}` });
      expect(await run("--keys", keysFile, c2)).toMatchObject({ code: 0, out: `intact, signed by ${k.signer.key.id}` });
      expect(await run(c1, "--keys", keysFile)).toMatchObject({ code: 1, out: "unsigned (landed before signing)" });
      expect(await run(c0, "--keys", keysFile)).toMatchObject({ code: 1, out: "no FT-Note trailer" });
      expect(await run(c2, "--keys", otherFile)).toMatchObject({ code: 1, out: "bad signature" });
      expect(await run(c2, "--keys", misnamedFile)).toMatchObject({ code: 1, out: "bad signature" });

      // The published keys over HTTP, as a deployment serves them.
      const server = NODE.createServer((req, res) => {
        if (req.url === "/.well-known/firetrident-keys.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ keys: [k.signer.key] }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((go) => server.listen(0, "127.0.0.1", go));
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        expect(await run(c2, "--keys", `${base}/.well-known/firetrident-keys.json`)).toMatchObject({ code: 0, out: `intact, signed by ${k.signer.key.id}` });
        const gone = await run(c2, "--keys", `${base}/nothing.json`);
        expect(gone).toMatchObject({ code: 2, out: "" });
        expect(gone.err).toMatch(/^the keys at .* could not be read: HTTP 404$/);
      } finally {
        server.close();
      }

      // The note edited in the clone: altered, with or without keys.
      const forged = serializeNote({ ...noteFor("lnd_2"), colonyId: "elsewhere" });
      await addNotes(r, { ref: REF, notes: [{ oid: c2, note: forged }], at: AT + 1, migrate: 0 });
      expect(await run(c2)).toMatchObject({ code: 1, out: "altered" });
      expect(await run(c2, "--keys", keysFile)).toMatchObject({ code: 1, out: "altered" });

      // History rewritten to match: the same tree and parent, the trailer recomputed for the forged note. The digest
      // alone is fooled; the signature is not.
      const { digest } = await sealNote(JSON.parse(forged) as LineageNote);
      const message = signed.message.replace(/FT-Note: sha256:[0-9a-f]{64}$/, `FT-Note: sha256:${digest}`);
      const rewritten = await writeCommitObject(r, { tree: signed.tree, parents: [c1], message, at: AT });
      await addNotes(r, { ref: REF, notes: [{ oid: rewritten, note: forged }], at: AT + 2, migrate: 0 });
      expect(await run(rewritten)).toMatchObject({ code: 0, out: "intact" });
      expect(await run(rewritten, "--keys", keysFile)).toMatchObject({ code: 1, out: "bad signature" });

      // Asked wrongly: says how to ask.
      expect(await run("--keys", keysFile)).toMatchObject({ code: 2, err: expect.stringMatching(/^usage: node verify_note\.mjs <commit>/) });
      expect(await run(c2, "--keys")).toMatchObject({ code: 2 });
    } finally {
      NODE.rmSync(dir, { recursive: true, force: true });
      NODE.rmSync(keysDir, { recursive: true, force: true });
    }
  });
});
