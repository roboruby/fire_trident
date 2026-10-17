import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import git from "isomorphic-git";
import { landingMessage, type LineageNote, type Proposal } from "@fire_trident/core";
import { LANDING_IDENTITY, ensureRepo, memoryFs, writeCommitObject, type GitRepo } from "../../src/artifacts/git.ts";
import { sealNote, withNoteDigest } from "../../src/trunk/digest.ts";
import { ALLOWED_SIGNERS_PATH, SIGNER_PRINCIPAL, allowedSignerLine, allowedSigners, allowedSignersResponse, signCommit, sshPublicKey, writeTrunkCommit } from "../../src/trunk/gitsig.ts";
import { commitContent, objectId } from "../../src/trunk/objects.ts";
import { checkSignature, noteSigner, publishedKeys, withSignature, type NoteSigner } from "../../src/trunk/signature.ts";
import { gitSignatureGood, readSshSignature, splitSigned } from "./sshsig-check.ts";

/**
 * Stock git signatures on the trunk writer's commits (trunk/gitsig.ts): the gpgsig header, the allowed signers, and
 * `git verify-commit` itself, run on commits built by the trunk writer's own code (objects.ts commitContent, then
 * signCommit, as TrunkDO.buildChain does; writeTrunkCommit, as TrunkDO.systemCommitNow does).
 */

/** A fresh Ed25519 key as FT_NOTE_KEY holds it (generated here: no private key is part of the repository). */
async function newKey(extra: Record<string, unknown> = {}): Promise<{ secret: string; x: string; signer: NoteSigner }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, ...extra });
  return { secret, x: jwk.x!, signer: (await noteSigner(secret))! };
}

const bytesOf = (b64url: string): Uint8Array => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PARENT = "2".repeat(40);
const AT = Date.parse("2026-10-16T12:00:00Z");
const proposal = { id: "prp_1", intentId: "int_1", agentId: "agt_1" } as Proposal;
const note: LineageNote = { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals: [] };

/** A landing commit object as TrunkDO.buildChain builds it: sealed and signed message, then the object, then its git signature. */
async function landingObject(signer: NoteSigner | null, p: { tree?: string; parents?: string[]; at?: number; id?: string } = {}): Promise<{ unsigned: Uint8Array; signed: Uint8Array; message: string; tree: string; parents: string[] }> {
  const tree = p.tree ?? TREE;
  const parents = p.parents ?? [PARENT];
  const id = p.id ?? "lnd_1";
  const { digest } = await sealNote({ ...note, landingId: id });
  const message = withNoteDigest(await withSignature(landingMessage({ id, intentIds: ["int_1"] }, [proposal], { int_1: "Add a thing" }), signer, { digest, tree, parents }), digest);
  const unsigned = commitContent({ tree, parents, message, name: LANDING_IDENTITY.name, email: LANDING_IDENTITY.email, timestamp: Math.floor((p.at ?? AT) / 1000) });
  return { unsigned, signed: await signCommit(unsigned, signer), message, tree, parents };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the git signature of a trunk commit", () => {
  it("is a gpgsig header after the committer line, an SSH signature in the git namespace over the commit without it", async () => {
    const k = await newKey();
    const c = await landingObject(k.signer);
    const lines = text(c.signed).split("\n");
    expect(lines.slice(0, 4).map((l) => l.split(" ")[0])).toEqual(["tree", "parent", "author", "committer"]);
    expect(lines[4]).toBe("gpgsig -----BEGIN SSH SIGNATURE-----");
    const end = lines.indexOf(" -----END SSH SIGNATURE-----");
    expect(end).toBeGreaterThan(5);
    // Each line after the first is indented by one space, base64 at most 70 columns, then the blank line and the message.
    for (const l of lines.slice(5, end)) expect(l).toMatch(/^ [A-Za-z0-9+/=]{1,70}$/);
    expect(lines[end + 1]).toBe("");
    expect(lines.slice(end + 2).join("\n")).toBe(`${c.message}\n`);

    // What git verifies is the commit without the header: exactly the object the writer built before signing.
    const split = splitSigned(c.signed)!;
    expect(text(split.payload)).toBe(text(c.unsigned));
    const s = readSshSignature(split.armored);
    expect(s).toMatchObject({ magic: "SSHSIG", version: 1, keyType: "ssh-ed25519", namespace: "git", reserved: "", hash: "sha512", sigType: "ssh-ed25519" });
    expect(s.publicKey).toEqual(bytesOf(k.x));
    expect(s.signature.length).toBe(64);
    expect(await gitSignatureGood(c.signed, bytesOf(k.x))).toBe(true);
    // The FT-Note-Signature trailer is untouched: the message is the same, so the note check reads the same.
    expect(await checkSignature({ tree: c.tree, parents: c.parents, message: c.message }, [k.signer.key])).toEqual({ status: "signed", keyId: k.signer.key.id });
  });

  it("changes nothing without a signer, and leaves a commit unsigned (said once) when signing fails", async () => {
    const plain = await landingObject(null);
    expect(plain.signed).toBe(plain.unsigned);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const k = await newKey();
    const failing = { key: k.signer.key, signBytes: async () => Promise.reject(new TypeError("no")) };
    const content = commitContent({ tree: TREE, parents: [], message: "x", name: "n", email: "e@x.invalid", timestamp: 1 });
    expect(await signCommit(content, failing)).toBe(content);
    expect(await signCommit(content, failing)).toBe(content);
    expect(log.mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of log.mock.calls) expect(String(call[0])).not.toContain(JSON.parse(k.secret).d);
  });

  it("is written by writeTrunkCommit for a system commit, which without a signer is the commit writeCommitObject writes", async () => {
    const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
    await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
    const p = { tree: TREE, parents: [] as string[], message: "Antibody ab_1\nFT-Landing: lnd_9", at: AT };
    expect(await writeTrunkCommit(r, p, null)).toBe(await writeCommitObject(r, p));
    const k = await newKey();
    const sha = await writeTrunkCommit(r, p, k.signer);
    const raw = (await git.readObject({ fs: r.fs, dir: r.dir, oid: sha, format: "content" })).object as Uint8Array;
    expect(objectId("commit", raw)).toBe(sha);
    expect(text(splitSigned(raw)!.payload)).toBe(text(commitContent({ tree: TREE, parents: [], message: p.message, name: LANDING_IDENTITY.name, email: LANDING_IDENTITY.email, timestamp: Math.floor(AT / 1000) })));
    expect(await gitSignatureGood(raw, bytesOf(k.x))).toBe(true);
    // isomorphic-git reads it back as an ordinary commit with its message and the signature apart.
    const read = (await git.readCommit({ fs: r.fs, dir: r.dir, oid: sha })).commit;
    expect(read.message).toBe(`${p.message}\n`);
    expect(read.gpgsig).toMatch(/^-----BEGIN SSH SIGNATURE-----\n[\s\S]+\n-----END SSH SIGNATURE-----\n?$/);
  });
});

describe("the allowed signers", () => {
  it("list each published key under the trunk writer's address, in the git namespace, with the key's window", async () => {
    const old = await newKey();
    const now = await newKey({ since: "2026-10-14T09:30:00Z" });
    const retired = JSON.stringify([{ x: old.x, since: "2026-09-01T00:00:00Z", until: "2026-10-14T09:35:00.900Z" }]);
    const keys = await publishedKeys(now.secret, retired);
    expect(keys.map((k) => k.until)).toEqual([null, "2026-10-14T09:35:00.900Z"]);
    expect(SIGNER_PRINCIPAL).toBe("lanes@firetrident.dev");
    expect(allowedSignerLine(keys[0]!)).toBe(`lanes@firetrident.dev namespaces="git",valid-after="20261014093000Z" ${sshPublicKey(now.x)}`);
    expect(allowedSignerLine(keys[1]!)).toBe(`lanes@firetrident.dev namespaces="git",valid-after="20260901000000Z",valid-before="20261014093500Z" ${sshPublicKey(old.x)}`);
    expect(sshPublicKey(now.x)).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/);
    const file = allowedSigners(keys);
    expect(file.split("\n").filter((l) => l !== "" && !l.startsWith("#"))).toEqual(keys.map(allowedSignerLine));
    expect(file).toContain(`# Key ${now.signer.key.id}: signing now, since 2026-10-14T09:30:00.000Z.`);
    expect(file).toContain(`# Key ${old.signer.key.id}: retired, signed from 2026-09-01T00:00:00.000Z until 2026-10-14T09:35:00.900Z.`);
    // A key with no since needs no window, and so no options past the namespace.
    const plain = await newKey();
    expect(allowedSignerLine(plain.signer.key)).toBe(`lanes@firetrident.dev namespaces="git" ${sshPublicKey(plain.x)}`);
  });

  it("are served as text, public, with only comments on a deployment that does not sign", async () => {
    const k = await newKey();
    const res = await allowedSignersResponse({ FT_NOTE_KEY: k.secret });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.text();
    expect(body).toContain(allowedSignerLine(k.signer.key));
    expect(body).not.toContain(JSON.parse(k.secret).d);
    expect(ALLOWED_SIGNERS_PATH).toBe("/.well-known/firetrident-allowed-signers");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const env of [{}, { FT_NOTE_KEY: "{}" }]) {
      const none = await (await allowedSignersResponse(env)).text();
      expect(none.split("\n").filter((l) => l !== "").every((l) => l.startsWith("#"))).toBe(true);
      expect(none).toContain("does not sign");
    }
  });
});

/** Node built-ins for stock git and ssh-keygen (the worker compiles against workers types, so they are typed here). */
interface NodeBits {
  spawnSync(cmd: string, args: string[], opts: { cwd?: string; input?: Uint8Array | string; env?: Record<string, string | undefined>; encoding?: "utf8" }): { status: number | null; stdout: string; stderr: string; error?: Error };
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, text: string): void;
  tmpdir(): string;
  join(...parts: string[]): string;
  fileURLToPath(url: URL): string;
  process: { execPath: string; env: Record<string, string | undefined> };
}
const NODE: NodeBits = await (async () => {
  const [cp, fs, os, path, url] = (await Promise.all(["node:child_process", "node:fs", "node:os", "node:path", "node:url"].map((m) => import(m)))) as [
    Pick<NodeBits, "spawnSync">,
    Pick<NodeBits, "mkdtempSync" | "rmSync" | "writeFileSync">,
    Pick<NodeBits, "tmpdir">,
    Pick<NodeBits, "join">,
    Pick<NodeBits, "fileURLToPath">,
  ];
  return {
    spawnSync: cp.spawnSync,
    mkdtempSync: fs.mkdtempSync,
    rmSync: fs.rmSync,
    writeFileSync: fs.writeFileSync,
    tmpdir: os.tmpdir,
    join: path.join,
    fileURLToPath: url.fileURLToPath,
    process: (globalThis as unknown as { process: NodeBits["process"] }).process,
  };
})();
const HERE = (import.meta as ImportMeta & { url: string }).url;
const VERIFY_NOTE = NODE.fileURLToPath(new URL("../../../../scripts/verify_note.mjs", HERE));
const found = (cmd: string, args: string[]): boolean => {
  const r = NODE.spawnSync(cmd, args, { encoding: "utf8" });
  return !r.error && r.status !== null;
};
const hasGit = found("git", ["--version"]);
// ssh-keygen -Y verify is what git runs for SSH signatures; `ssh-keygen -?` exits 1 with its usage when it is there.
const hasSshKeygen = found("ssh-keygen", ["-?"]);
const WHY = !hasGit ? " (skipped: git is not on PATH)" : !hasSshKeygen ? " (skipped: ssh-keygen is not on PATH, and git verify-commit needs it for SSH signatures)" : "";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) NODE.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fresh repository with stock git, run in a time zone that is not UTC (git hands ssh-keygen the commit time as a local
 * time) and has no daylight saving time, where ssh-keygen reads such a local time an hour off.
 */
function stockRepo(): { dir: string; git(args: string[], input?: Uint8Array | string): { status: number | null; out: string; err: string }; ok(args: string[], input?: Uint8Array | string): string; allowed(keys: Parameters<typeof allowedSigners>[0]): string } {
  const dir = NODE.mkdtempSync(NODE.join(NODE.tmpdir(), "ft-gitsig-"));
  made.push(dir);
  const env = { ...NODE.process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: dir, TZ: "Asia/Tokyo", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const run = (args: string[], input?: Uint8Array | string) => {
    const r = NODE.spawnSync("git", args, { cwd: dir, env, encoding: "utf8", ...(input !== undefined ? { input } : {}) });
    return { status: r.status, out: String(r.stdout ?? "").trim(), err: String(r.stderr ?? "").trim() };
  };
  const ok = (args: string[], input?: Uint8Array | string): string => {
    const r = run(args, input);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.err}`);
    return r.out;
  };
  ok(["init", "-q", "-b", "main"]);
  let n = 0;
  return {
    dir,
    git: run,
    ok,
    allowed(keys) {
      const file = NODE.join(dir, `allowed_signers_${++n}`);
      NODE.writeFileSync(file, allowedSigners(keys));
      return file;
    },
  };
}

// Each spawns git and ssh-keygen a dozen times: room for a loaded machine.
const STOCK_MS = 30_000;

describe.skipIf(WHY !== "")(`stock git verify-commit on the trunk writer's commits${WHY}`, () => {
  it("verifies a landing commit and a system commit with the published allowed signers, and fails a tampered one", async () => {
    const repo = stockRepo();
    const k = await newKey();
    const keys = await publishedKeys(k.secret);
    const file = repo.allowed(keys);
    const verify = (sha: string, allowed = file) => repo.git(["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", sha]);
    const status = (sha: string, allowed = file) => repo.ok(["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "log", "-1", "--format=%G?", sha]);
    const tree = repo.ok(["mktree"], `100644 blob ${repo.ok(["hash-object", "-w", "--stdin"], "export const a = 1;\n")}\ta.ts\n`);

    // A landing commit, built and signed by the writer's code, written byte for byte.
    const root = await landingObject(k.signer, { tree, parents: [], id: "lnd_1" });
    const rootSha = repo.ok(["hash-object", "-t", "commit", "-w", "--stdin"], root.signed);
    expect(rootSha).toBe(objectId("commit", root.signed));
    let r = verify(rootSha);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(new RegExp(`^Good "git" signature for ${SIGNER_PRINCIPAL.replace(/\./g, "\\.")} with ED25519 key SHA256:[A-Za-z0-9+/]{43}$`));
    expect(status(rootSha)).toBe("G");

    // One on top of it, then a system commit as writeTrunkCommit writes it (read out of the writer's repository as is).
    const next = await landingObject(k.signer, { tree, parents: [rootSha], id: "lnd_2", at: AT + 1000 });
    const nextSha = repo.ok(["hash-object", "-t", "commit", "-w", "--stdin"], next.signed);
    expect(verify(nextSha).status).toBe(0);
    const mem: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
    await ensureRepo(mem, "https://example.invalid/git/ns/repo.git");
    const sys = await writeTrunkCommit(mem, { tree, parents: [nextSha], message: "Antibody ab_1\nFT-Landing: lnd_3", at: AT + 2000 }, k.signer);
    const sysRaw = (await git.readObject({ fs: mem.fs, dir: mem.dir, oid: sys, format: "content" })).object as Uint8Array;
    expect(repo.ok(["hash-object", "-t", "commit", "-w", "--stdin"], sysRaw)).toBe(sys);
    expect(verify(sys).status).toBe(0);
    repo.ok(["update-ref", "refs/heads/main", sys]);
    expect(repo.ok(["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${file}`, "log", "--format=%G?", "main"]).split("\n")).toEqual(["G", "G", "G"]);

    // Tampered: the message changed under the same signature, so git's check of it fails.
    const forgedBytes = new TextEncoder().encode(text(root.signed).replace("Land 1 change", "Land 2 changes"));
    const forged = repo.ok(["hash-object", "-t", "commit", "-w", "--stdin"], forgedBytes);
    r = verify(forged);
    expect(r.status).not.toBe(0);
    expect(status(forged)).toBe("B");
    // Signed by a key the deployment does not publish: no principal matches it.
    const other = await newKey();
    const stranger = repo.ok(["hash-object", "-t", "commit", "-w", "--stdin"], (await landingObject(other.signer, { tree, parents: [], id: "lnd_x" })).signed);
    expect(verify(stranger).status).not.toBe(0);
    // Without a signer the commit has no signature at all, exactly as before.
    const plain = repo.ok(["hash-object", "-t", "commit", "-w", "--stdin"], (await landingObject(null, { tree, parents: [], id: "lnd_p" })).signed);
    expect(verify(plain).status).not.toBe(0);
    expect(status(plain)).toBe("N");
  }, STOCK_MS);

  it("follows the key ring: a retired key verifies only commits dated inside its window, the current key the rest", async () => {
    const repo = stockRepo();
    const old = await newKey();
    const SWITCH = Date.parse("2026-10-14T09:35:00Z");
    const now = await newKey({ since: new Date(SWITCH).toISOString() });
    const keys = await publishedKeys(now.secret, JSON.stringify([{ x: old.x, since: "2026-09-01T00:00:00Z", until: new Date(SWITCH).toISOString() }]));
    const file = repo.allowed(keys);
    const verify = (sha: string) => repo.git(["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${file}`, "verify-commit", sha]);
    const write = async (signer: NoteSigner, at: number, id: string) => repo.ok(["hash-object", "-t", "commit", "-w", "--stdin"], (await landingObject(signer, { parents: [], at, id })).signed);
    // A minute either side of the switch: the boundary holds to the minute, in a time zone nine hours off UTC.
    expect(verify(await write(old.signer, SWITCH - 60_000, "lnd_a")).status).toBe(0);
    expect(verify(await write(old.signer, SWITCH + 60_000, "lnd_b")).status).not.toBe(0);
    expect(verify(await write(now.signer, SWITCH + 60_000, "lnd_c")).status).toBe(0);
    expect(verify(await write(now.signer, SWITCH - 60_000, "lnd_d")).status).not.toBe(0);
    // Without the retired key listed, the old key's commit no longer verifies: the case the key ring is for.
    const onlyNow = repo.allowed(await publishedKeys(now.secret));
    const early = await write(old.signer, SWITCH - 60_000, "lnd_e");
    expect(repo.git(["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${onlyNow}`, "verify-commit", early]).status).not.toBe(0);
  }, STOCK_MS);

  it("leaves the lineage note checks as they were: verify_note.mjs reads a commit with a gpgsig header as before", async () => {
    const repo = stockRepo();
    const k = await newKey();
    const { text: noteText } = await sealNote({ ...note, landingId: "lnd_1" });
    const c = await landingObject(k.signer, { parents: [], id: "lnd_1" });
    const sha = repo.ok(["hash-object", "-t", "commit", "-w", "--stdin"], c.signed);
    repo.ok(["update-ref", "refs/heads/main", sha]);
    repo.ok(["notes", "--ref=firetrident", "add", "-C", repo.ok(["hash-object", "-w", "--stdin"], noteText), sha]);
    const keysFile = NODE.join(repo.dir, "keys.json");
    NODE.writeFileSync(keysFile, JSON.stringify({ keys: await publishedKeys(k.secret) }));
    const run = (args: string[]) => NODE.spawnSync(NODE.process.execPath, [VERIFY_NOTE, ...args], { cwd: repo.dir, encoding: "utf8", env: { ...NODE.process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(run([sha]).stdout.split("\n")[0]).toBe("intact");
    const signed = run([sha, "--keys", keysFile]);
    expect(signed.stdout.split("\n")[0]).toBe(`intact, signed by ${k.signer.key.id}`);
    expect(signed.status).toBe(0);
  }, STOCK_MS);
});
