import { describe, expect, it } from "vitest";
import type { Landing, LineageNote, NoteAcceptance } from "@fire_trident/core";
import { serializeNote } from "@fire_trident/core";
import { buildTree, ensureRepo, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { noteDecisions, type DecisionRow } from "../../src/colony/direction.ts";
import { whyAnswer } from "../../src/mcp/tools.ts";
import { checkNote, sealNote, withNoteDigest } from "../../src/trunk/digest.ts";
import { MASKED, maskNote } from "../../src/trunk/mask.ts";
import { addNotes } from "../../src/trunk/notes.ts";

/**
 * Quoted acceptance in lineage notes (FT_QUOTED_ACCEPTANCE): the second opinion's decision carries each line with its
 * verdict and quote into the note, masked like the rest of a note's free text, sealed by the commit's FT-Note trailer,
 * and checked by scripts/verify_note.mjs with stock git; the MCP why answer keeps it.
 */

// Built at run time: a token-shaped string the secret detector flags (it is not a real credential).
const TOKEN = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join("_");

const LINES: NoteAcceptance[] = [
  { kind: "intent", line: "slugify lowercases its input", verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
  { kind: "intent", line: 'Keeps "quoted" \\ backslashes and ünïcödé', verdict: "met", path: "src/slug.ts", quote: 'return lower.replace(/\\s+/g, "-"); // ✓ «ok»' },
  { kind: "intent", line: "Reads the deploy token", verdict: "unclear", said: "met", path: "src/env.ts", quote: `const token = "${TOKEN}";`, problem: "its quote is not in the added or unchanged lines of src/env.ts it was shown" },
  { kind: "keep", line: "Returns 404 for an unknown slug", verdict: "not met", landingId: "lnd_7" },
];

/** The decide stage's decisions for one proposal, as the colony stores them. */
function rows(): DecisionRow[] {
  return [
    { id: "dec_1", kind: "triage", subject: "prp_1", layer: "reflex", answers: JSON.stringify({ model: "@cf/cloudflare/clef", reflex: { needsHuman: 0.1, sensitive: 0.02, offIntent: 0.03, risk: 0.5 }, reasons: ["consult"] }), p: 0.6, action: "consult", at: 1 },
    {
      id: "dec_2",
      kind: "triage",
      subject: "prp_1",
      layer: "llm",
      answers: JSON.stringify({ model: "@cf/google/gemma-4-26b-a4b-it", verdict: { verdict: "approve", reason: "ok" }, rule: "L3 innate+llm", reasons: ["ok"], acceptance: LINES }),
      p: 0.95,
      action: "land",
      at: 2,
    },
  ];
}

function noteWith(decisions: LineageNote["proposals"][number]["decisions"]): LineageNote {
  return {
    schema: "firetrident.lineage/v1",
    landingId: "lnd_1",
    colonyId: "col",
    proposals: [
      {
        id: "prp_1",
        agentId: "agt_1",
        agentKind: "external",
        intent: { id: "int_1", title: "Add slugify", why: "Links need readable slugs." },
        writeSet: [{ path: "src/slug.ts", blob: "a".repeat(40) }],
        readSet: [],
        decisions,
        evidence: { checks: [] },
      },
    ],
  };
}

describe("the lineage note keeps each acceptance line with its verdict and quote", () => {
  it("from the recorded decision, with secret-looking quotes masked like any note text", () => {
    const decisions = noteDecisions(rows()).prp_1!;
    expect(decisions[0]).not.toHaveProperty("acceptance");
    expect(decisions[1]!.acceptance).toEqual(LINES);
    const masked = maskNote(noteWith(decisions));
    const kept = masked.proposals[0]!.decisions[1]!.acceptance!;
    expect(kept[0]).toEqual(LINES[0]);
    expect(kept[2]!.quote).toContain(MASKED);
    expect(JSON.stringify(masked)).not.toContain(TOKEN);
  });

  it("a stored decision with odd acceptance data adds nothing, and the rest of the note is as before", () => {
    const odd = rows();
    odd[1] = { ...odd[1]!, answers: JSON.stringify({ model: "m", verdict: { verdict: "approve", reason: "ok" }, acceptance: "not a list" }) };
    const d = noteDecisions(odd).prp_1![1]!;
    expect(d).not.toHaveProperty("acceptance");
    expect(d).toMatchObject({ layer: "llm", answer: "approve: ok", by: "m" });
  });

  it("the MCP why answer passes the lines through", () => {
    const note = maskNote(noteWith(noteDecisions(rows()).prp_1!));
    const landing = { id: "lnd_1", colonyId: "col", trunkSha: "b".repeat(40), parentSha: "c".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/slug.ts"], regions: ["src"], at: 3 } as Landing;
    const answer = whyAnswer("src/slug.ts", undefined, [{ landing, note }]);
    expect(answer.entries[0]!.note.proposals[0]!.decisions[1]!.acceptance).toHaveLength(LINES.length);
  });

  it("is sealed by the commit's trailer like any note", async () => {
    const note = maskNote(noteWith(noteDecisions(rows()).prp_1!));
    const { text, digest } = await sealNote(note);
    expect(text).toBe(serializeNote(note));
    expect(await checkNote(text, digest)).toEqual({ status: "intact" });
  });
});

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
  it("prints intact for a note that keeps acceptance lines, and altered when one of them is edited", async () => {
    const dir = NODE.mkdtempSync(NODE.join(NODE.tmpdir(), "ft-acceptance-"));
    const env = { ...NODE.process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
    const run = (commit: string): Promise<{ code: number; out: string }> =>
      new Promise((resolve) =>
        NODE.execFile(NODE.process.execPath, [SCRIPT, commit], { cwd: dir, env }, (e, stdout) => resolve({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(stdout).trim() })),
      );
    try {
      const r: GitRepo = { fs: NODE.fs as GitRepo["fs"], dir, cache: {} };
      await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
      const note = maskNote(noteWith(noteDecisions(rows()).prp_1!));
      const { text, digest } = await sealNote(note);
      const blob = await writeLocalBlob(r, new TextEncoder().encode("export const slug = 1;\n"));
      const tree = await buildTree(r, new Map([["src/slug.ts", { blob, mode: "100644" }]]));
      const sha = await writeCommitObject(r, { tree, parents: [], message: withNoteDigest("Land 1 change: lnd_1\n\nFT-Landing: lnd_1", digest), at: 1_760_000_000_000 });
      await addNotes(r, { ref: "refs/notes/firetrident", notes: [{ oid: sha, note: text }], at: 1_760_000_000_000, migrate: 0 });
      expect(await run(sha)).toEqual({ code: 0, out: "intact" });

      // Someone rewrites a verdict in the clone: the note no longer matches its commit.
      const edited = JSON.parse(text) as LineageNote;
      edited.proposals[0]!.decisions[1]!.acceptance![3]!.verdict = "met";
      await addNotes(r, { ref: "refs/notes/firetrident", notes: [{ oid: sha, note: serializeNote(edited) }], at: 1_760_000_000_001, migrate: 0 });
      expect(await run(sha)).toEqual({ code: 1, out: "altered" });
    } finally {
      NODE.rmSync(dir, { recursive: true, force: true });
    }
  });
});
