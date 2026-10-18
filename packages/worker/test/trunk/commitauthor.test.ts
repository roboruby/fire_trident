import { afterAll, describe, expect, it } from "vitest";
import { landingMessage, type LineageNote, type Proposal } from "@fire_trident/core";
import { LANDING_IDENTITY } from "../../src/artifacts/git.ts";
import type { SqlRunner } from "../../src/colony/inline.ts";
import { CommitAuthors, commitAuthorProblem, parseCommitAuthorRecord } from "../../src/colony/commitauthor.ts";
import { AUTHOR_META, cycleAuthor, keepAuthor, personCredits, storedAuthor } from "../../src/trunk/commitauthor.ts";
import { creditLines } from "../../src/trunk/credits.ts";
import { sealNote, withNoteDigest } from "../../src/trunk/digest.ts";
import { allowedSigners, signCommit } from "../../src/trunk/gitsig.ts";
import { commitContent, objectId } from "../../src/trunk/objects.ts";
import { noteSigner, publishedKeys, withSignature } from "../../src/trunk/signature.ts";

/** People as commit authors (colony/commitauthor.ts, trunk/commitauthor.ts): the setting, the writer's copy, and the commit. */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlite(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...(b as never[]));
      return { toArray: () => rows };
    },
  };
}

/** A trunk writer's meta table. */
function writer(): SqlRunner {
  const sql = sqlite();
  sql.exec("CREATE TABLE ft_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return sql;
}

const DANA = { name: "Dana Reviewer", email: "dana@example.com" };

describe("the colony's commit author setting", () => {
  it("names a person, reads back, clears, and orders each change after the last", () => {
    const a = new CommitAuthors(sqlite());
    expect(a.get()).toBeNull();
    expect(a.record()).toBeUndefined();
    expect(a.set({ ...DANA, by: "matt" }, 1_000)).toEqual({ ...DANA, by: "matt", at: 1_000 });
    expect(a.get()).toEqual({ ...DANA, by: "matt", at: 1_000 });
    expect(a.record()).toEqual({ ...DANA, at: 1_000 });
    // A clock that went back still moves the record forward.
    expect(a.clear("matt", 500)).toBe(true);
    expect(a.get()).toBeNull();
    expect(a.record()).toEqual({ name: null, email: null, at: 1_001 });
    expect(a.clear("matt", 2_000)).toBe(false);
  });

  it("refuses what cannot be a git identity, saying what to send", () => {
    const a = new CommitAuthors(sqlite());
    expect(() => a.set({ name: "Dana <x@y.z>", email: "dana@example.com", by: "m" }, 1)).toThrow(/angle brackets.*Send \{ "name"/);
    expect(() => a.set({ name: "Dana", email: "dana@example.com>\nauthor Mallory", by: "m" }, 1)).toThrow(/is not one email address/);
    expect(() => a.set({ name: "Dana", by: "m" }, 1)).toThrow(/give the person's email address/);
    expect(() => a.set({ name: " Dana", email: "dana@example.com", by: "m" }, 1)).toThrow(/spaces at its ends/);
    expect(commitAuthorProblem("Dana\u0000", "dana@example.com")).toMatch(/control characters/);
    expect(commitAuthorProblem("Dana Reviewer", "dana@example.com")).toBeNull();
    expect(a.get()).toBeNull();
  });
});

describe("the trunk writer's copy", () => {
  it("keeps the newest record a lane passes, and keeps it for a batch whose lane passed none", () => {
    const sql = writer();
    expect(cycleAuthor(sql, [undefined, {}])).toBeNull();
    expect(cycleAuthor(sql, [{ author: { ...DANA, at: 10 } }, undefined])).toEqual(DANA);
    expect(storedAuthor(sql)).toEqual({ ...DANA, at: 10 });
    // A batch with no context, and an older record a lane passed late: the setting holds.
    expect(cycleAuthor(sql, [undefined])).toEqual(DANA);
    expect(cycleAuthor(sql, [{ author: { name: null, email: null, at: 5 } }])).toEqual(DANA);
    // Cleared later: FireTrident again.
    expect(cycleAuthor(sql, [{ author: { name: null, email: null, at: 20 } }, { author: { ...DANA, at: 15 } }])).toBeNull();
    expect(cycleAuthor(sql, [])).toBeNull();
  });

  it("checks a record again and ignores one that is not a git identity", () => {
    const sql = writer();
    expect(parseCommitAuthorRecord({ name: "Dana", email: "dana@example.com>\ncommitter x", at: 1 })).toBeUndefined();
    expect(cycleAuthor(sql, [{ author: { name: "Eve <eve@x.io>", email: "eve@x.io", at: 9 } }])).toBeNull();
    sql.exec("INSERT INTO ft_meta (key, value) VALUES (?, ?)", AUTHOR_META, "{not json");
    expect(storedAuthor(sql)).toBeUndefined();
    expect(keepAuthor(sql, { ...DANA, at: 3 })).toEqual({ ...DANA, at: 3 });
  });

  it("drops agents' Co-authored-by lines with a person as author and keeps Approved-by", () => {
    const note = {
      colonyId: "web",
      proposals: [{ agentId: "agt_1", decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Lee" }], evidence: { checks: [] }, intent: { id: "i", title: "t", why: "w" } }],
    } as unknown as LineageNote;
    const lines = creditLines(note, () => "scout");
    expect(lines).toEqual(["Co-authored-by: scout <agt_1@web.noreply.firetrident.dev>", "Approved-by: Lee"]);
    expect(personCredits(lines, DANA)).toEqual(["Approved-by: Lee"]);
    expect(personCredits(lines, null)).toEqual(lines);
  });
});

describe("a landing commit with a person as its author", () => {
  it("is authored by the person and committed by FireTrident; without one it is as before", () => {
    const base = { tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", parents: ["2".repeat(40)], message: "Land 1 change\n", name: LANDING_IDENTITY.name, email: LANDING_IDENTITY.email, timestamp: 1_800_000_000 };
    const text = (b: Uint8Array): string => new TextDecoder().decode(b);
    expect(text(commitContent({ ...base, author: DANA }))).toContain("author Dana Reviewer <dana@example.com> 1800000000 +0000\ncommitter FireTrident <lanes@firetrident.dev> 1800000000 +0000\n");
    expect(commitContent({ ...base, author: null })).toEqual(commitContent(base));
    expect(text(commitContent(base))).toContain("author FireTrident <lanes@firetrident.dev> 1800000000 +0000\ncommitter FireTrident <lanes@firetrident.dev>");
  });
});

/** Node built-ins for stock git (the worker compiles against workers types, so they are typed here). */
interface NodeBits {
  spawnSync(cmd: string, args: string[], opts: { cwd?: string; input?: Uint8Array | string; env?: Record<string, string | undefined>; encoding?: "utf8" }): { status: number | null; stdout: string; stderr: string; error?: Error };
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, text: string): void;
  tmpdir(): string;
  join(...parts: string[]): string;
  env: Record<string, string | undefined>;
}
const NODE: NodeBits = await (async () => {
  const [cp, fs, os, path] = (await Promise.all(["node:child_process", "node:fs", "node:os", "node:path"].map((m) => import(m)))) as [
    Pick<NodeBits, "spawnSync">,
    Pick<NodeBits, "mkdtempSync" | "rmSync" | "writeFileSync">,
    Pick<NodeBits, "tmpdir">,
    Pick<NodeBits, "join">,
  ];
  const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
  return { spawnSync: cp.spawnSync, mkdtempSync: fs.mkdtempSync, rmSync: fs.rmSync, writeFileSync: fs.writeFileSync, tmpdir: os.tmpdir, join: path.join, env: proc.env };
})();
const found = (cmd: string, args: string[]): boolean => {
  const r = NODE.spawnSync(cmd, args, { encoding: "utf8" });
  return !r.error && r.status !== null;
};
const WHY = !found("git", ["--version"]) ? " (skipped: git is not on PATH)" : !found("ssh-keygen", ["-?"]) ? " (skipped: ssh-keygen is not on PATH)" : "";
const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) NODE.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(WHY !== "")(`stock git on a person-authored landing commit${WHY}`, () => {
  it("shows the person and FireTrident in git log, and git verify-commit still says Good for the trunk writer's key", async () => {
    const dir = NODE.mkdtempSync(NODE.join(NODE.tmpdir(), "ft-author-"));
    made.push(dir);
    const env = { ...NODE.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: dir, TZ: "UTC" };
    const git = (args: string[], input?: Uint8Array | string): { status: number | null; out: string; err: string } => {
      const r = NODE.spawnSync("git", args, { cwd: dir, env, encoding: "utf8", ...(input !== undefined ? { input } : {}) });
      return { status: r.status, out: String(r.stdout ?? "").trim(), err: String(r.stderr ?? "").trim() };
    };
    const ok = (args: string[], input?: Uint8Array | string): string => {
      const r = git(args, input);
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.err}`);
      return r.out;
    };
    ok(["init", "-q", "-b", "main"]);
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x });
    const signer = (await noteSigner(secret))!;
    const allowed = NODE.join(dir, "allowed_signers");
    NODE.writeFileSync(allowed, allowedSigners(await publishedKeys(secret)));

    // A landing commit as TrunkDO.buildChain builds it with a person named: sealed, signed, then signed the git way.
    const tree = ok(["mktree"], `100644 blob ${ok(["hash-object", "-w", "--stdin"], "export const a = 1;\n")}\ta.ts\n`);
    const note: LineageNote = { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "web", proposals: [] };
    const { digest } = await sealNote(note);
    const message = withNoteDigest(await withSignature(landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [{ id: "prp_1", intentId: "int_1", agentId: "agt_1" } as Proposal], { int_1: "Add a" }), signer, { digest, tree, parents: [] }), digest);
    const content = await signCommit(commitContent({ tree, parents: [], message, name: LANDING_IDENTITY.name, email: LANDING_IDENTITY.email, timestamp: 1_800_000_000, author: DANA }), signer);
    const sha = ok(["hash-object", "-t", "commit", "-w", "--stdin"], content);
    expect(sha).toBe(objectId("commit", content));
    ok(["update-ref", "refs/heads/main", sha]);
    expect(ok(["log", "--format=%an %cn", "main"])).toBe("Dana Reviewer FireTrident");
    expect(ok(["log", "--format=%ae %ce", "main"])).toBe("dana@example.com lanes@firetrident.dev");
    const v = git(["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", sha]);
    expect(v.status, v.err).toBe(0);
    expect(v.err).toMatch(/^Good "git" signature for lanes@firetrident\.dev with ED25519 key SHA256:/);
  }, 30_000);
});
