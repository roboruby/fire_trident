import { describe, expect, it } from "vitest";
import type { LineageNote, PrelandRun } from "@fire_trident/core";
import { buildTree, ensureRepo, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { prelandCheck } from "../../src/certify/preland.ts";
import { sealNote, withNoteDigest } from "../../src/trunk/digest.ts";
import { maskNote } from "../../src/trunk/mask.ts";
import { addNotes } from "../../src/trunk/notes.ts";

/**
 * A lineage note whose proposal carries a run of tests before landing (FT_PRELAND: `evidence.preland`, a new optional
 * field) is sealed as every note is, and scripts/verify_note.mjs, with stock git, still finds it intact.
 */

const REF = "refs/notes/firetrident";
const AT = 1_760_000_000_000;

/** Node built-ins for the stock-git check (the worker compiles against workers types, so they are typed here). */
interface NodeBits {
  execFile(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }, done: (err: { code?: unknown } | null, stdout: string, stderr: string) => void): void;
  execFileSync(cmd: string, args: string[], opts?: { stdio?: "ignore" }): unknown;
  fs: unknown;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  tmpdir(): string;
  join(...parts: string[]): string;
  fileURLToPath(url: URL): string;
  process: { execPath: string; env: Record<string, string | undefined> };
}
const NODE: NodeBits = await (async () => {
  const [cp, fs, os, path, url] = (await Promise.all(["node:child_process", "node:fs", "node:os", "node:path", "node:url"].map((m) => import(m)))) as [
    Pick<NodeBits, "execFile" | "execFileSync">,
    Pick<NodeBits, "mkdtempSync" | "rmSync">,
    Pick<NodeBits, "tmpdir">,
    Pick<NodeBits, "join">,
    Pick<NodeBits, "fileURLToPath">,
  ];
  return {
    execFile: cp.execFile,
    execFileSync: cp.execFileSync,
    fs,
    mkdtempSync: fs.mkdtempSync,
    rmSync: fs.rmSync,
    tmpdir: os.tmpdir,
    join: path.join,
    fileURLToPath: url.fileURLToPath,
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

const MATH = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";

const RUN: PrelandRun = {
  status: "passed",
  trunkSha: "a".repeat(40),
  files: ["test/math.test.ts"],
  reached: 7,
  tests: 3,
  passed: 2,
  failed: 1,
  known: 1,
  ms: 182,
};

/** A note as the trunk writer writes it (masked), for one proposal whose evidence carries the run and its check. */
function noteWith(run: PrelandRun): LineageNote {
  return maskNote({
    schema: "firetrident.lineage/v1",
    landingId: "lnd_preland",
    colonyId: "c",
    proposals: [
      {
        id: "prp_1",
        agentId: "agt_1",
        agentKind: "external",
        intent: { id: "int_1", title: "Fix subtraction", why: "The test says so." },
        writeSet: [{ path: "src/math.ts", blob: "b".repeat(40) }],
        readSet: [],
        decisions: [],
        evidence: { checks: [prelandCheck(run)], notVerified: "Not verified: nothing else.", preland: run },
      },
    ],
  });
}

describe.skipIf(!hasGit)("a lineage note with tests before landing, checked with stock git", () => {
  it("is intact under scripts/verify_note.mjs, and altered once its run is edited", async () => {
    const dir = NODE.mkdtempSync(NODE.join(NODE.tmpdir(), "ft-preland-note-"));
    const env = { ...NODE.process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
    const run = (...args: string[]): Promise<{ code: number; out: string }> =>
      new Promise((resolve) =>
        NODE.execFile(NODE.process.execPath, [SCRIPT, ...args], { cwd: dir, env }, (e, stdout) => resolve({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(stdout).trim() })),
      );
    try {
      const r: GitRepo = { fs: NODE.fs as GitRepo["fs"], dir, cache: {} };
      await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
      const note = noteWith(RUN);
      expect(note.proposals[0]!.evidence.preland).toEqual(RUN);
      const { text, digest } = await sealNote(note);
      const blob = await writeLocalBlob(r, new TextEncoder().encode(MATH));
      const tree = await buildTree(r, new Map([["src/math.ts", { blob, mode: "100644" }]]));
      const commit = await writeCommitObject(r, { tree, parents: [], message: withNoteDigest("Land 1 change: lnd_preland\n\nFT-Landing: lnd_preland", digest), at: AT });
      await addNotes(r, { ref: REF, notes: [{ oid: commit, note: text }], at: AT, migrate: 0 });
      expect(await run(commit)).toEqual({ code: 0, out: "intact" });

      // The run rewritten in the clone (a failure turned into a pass): the digest no longer matches.
      const forged = (await sealNote(noteWith({ ...RUN, failed: 0, known: 0, passed: 3 }))).text;
      await addNotes(r, { ref: REF, notes: [{ oid: commit, note: forged }], at: AT + 1, migrate: 0 });
      expect(await run(commit)).toEqual({ code: 1, out: "altered" });
    } finally {
      NODE.rmSync(dir, { recursive: true, force: true });
    }
  });
});
