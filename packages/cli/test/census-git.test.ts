import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { landingMessage, type LineageNote, type Proposal } from "@fire_trident/core";
import { sealNote, withNoteDigest } from "../../worker/src/trunk/digest.ts";
import { helpText } from "../src/args.ts";
import { BLAME_FILES, BLAME_MS, readCensus } from "../src/censusgit.ts";
import type { CensusReport, OwnerRow } from "../src/census.ts";
import { main, type Io } from "../src/run.ts";

/**
 * `ft census` end to end on a repository built with stock git: a person's commits, one that quotes a co-author line in
 * prose and in a code fence (neither counts), one with a real co-author trailer naming a model, a bot's commit, a
 * person's commit whose co-author trailer names a bot (still theirs), a FireTrident landing with two changes and an
 * intact lineage note, a landing whose note was rewritten, and an agent's branch merged by a pull request merge.
 */

/**
 * The trunk writer's credit trailers (worker trunk/credits.ts), loaded at run time like trunk-repo.ts loads the signer:
 * its module reaches worker code this package's typecheck does not follow.
 */
const credits = (await import(new URL("../../worker/src/trunk/credits.ts", import.meta.url).href)) as {
  creditLines(note: Pick<LineageNote, "colonyId" | "proposals">, nameOf: (agentId: string) => string | undefined): string[];
  withCredits(message: string, lines: readonly string[]): string;
};

type Who = { name: string; email: string };
const ADA: Who = { name: "Ada Lovelace", email: "ada@example.com" };
const DEPENDABOT: Who = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };
const WRITER: Who = { name: "FireTrident", email: "lanes@firetrident.dev" };
const START = Date.parse("2026-10-01T00:00:00Z") / 1000;

/** `n` lines of text, each naming `tag`. */
const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}\n`).join("");

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new directory under the system's temporary directory, removed after the tests. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/** A repository with a work tree, every commit an hour after the last, by the identity given. */
function repository() {
  const dir = scratch("ft-census-");
  let clock = START;
  const git = (args: string[], p: { input?: string; who?: Who } = {}): string => {
    const who = p.who ?? ADA;
    const at = `${clock} +0000`;
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
    return execFileSync("git", args, { cwd: dir, input: p.input, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] }).trim();
  };
  git(["init", "-q", "-b", "main"]);
  const commit = (who: Who, message: string, files: Record<string, string>): string => {
    clock += 3600;
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    git(["add", "-A"]);
    git(["commit", "-q", "--cleanup=verbatim", "-F", "-"], { input: message, who });
    return git(["rev-parse", "HEAD"]);
  };
  const merge = (branch: string, message: string): string => {
    clock += 3600;
    git(["merge", "-q", "--no-ff", "-m", message, branch]);
    return git(["rev-parse", "HEAD"]);
  };
  return { dir, git, commit, merge };
}

/** One change of a landing: its entry in the note, as the trunk writer records it, and the files it writes. */
type Change = { proposal: LineageNote["proposals"][number]; files: Record<string, string> };

/** A change by agent `agt_<agent>`, with the model the trunk writer recorded (`model`) beside another the change named. */
function change(r: ReturnType<typeof repository>, p: { agent: string; kind: "internal" | "external"; model: string; files: Record<string, string> }): Change {
  const provenance = p.kind === "internal" ? { author: "platform" as const, auth: "platform" as const, model: { evidence: "observed" as const, name: p.model } } : { author: "external" as const, model: { evidence: "declared" as const, name: p.model } };
  const proposal = {
    id: `prp_${p.agent}`,
    agentId: `agt_${p.agent}`,
    agentKind: p.kind,
    model: `${p.model}-as-named`,
    intent: { id: `int_${p.agent}`, title: `Change by ${p.agent}`, why: "a census fixture" },
    writeSet: Object.entries(p.files).map(([path, text]) => ({ path, blob: r.git(["hash-object", "--stdin"], { input: text }) })),
    readSet: [],
    decisions: [],
    evidence: { checks: [{ name: "danger patterns", ok: true, ms: 1 }] },
    provenance,
  };
  return { proposal, files: p.files };
}

/** A landing the way the trunk writer makes one: its message with credit trailers, sealed with its note's digest, and the note under refs/notes/firetrident. */
async function landing(r: ReturnType<typeof repository>, landingId: string, changes: Change[]): Promise<string> {
  const proposals = changes.map((c) => c.proposal);
  const note = { schema: "firetrident.lineage/v1", landingId, colonyId: "demo", proposals } as LineageNote;
  const sealed = await sealNote(note);
  const message = landingMessage({ id: landingId, intentIds: proposals.map((p) => p.intent.id) }, proposals.map((p) => ({ id: p.id, intentId: p.intent.id, agentId: p.agentId })) as unknown as Proposal[], {});
  const named = credits.withCredits(message, credits.creditLines(note, (id) => id.replace(/^agt_/, "")));
  const sha = r.commit(WRITER, withNoteDigest(named, sealed.digest), Object.assign({}, ...changes.map((c) => c.files)) as Record<string, string>);
  const blob = r.git(["hash-object", "-w", "--stdin"], { input: sealed.text });
  r.git(["notes", "--ref=firetrident", "add", "-C", blob, sha]);
  return sha;
}

const CLAUDE_TRAILER = "Co-authored-by: Claude Opus 4.5 <noreply@anthropic.com>";

let repo: ReturnType<typeof repository>;
const sha: Record<string, string> = {};

beforeAll(async () => {
  repo = repository();
  const r = repo;
  sha.start = r.commit(ADA, "Add the app\n", { "app.ts": lines(10, "app"), "README.md": lines(3, "readme") });
  // The co-author line quoted in prose and in a fence at the end: neither is a trailer.
  sha.prose = r.commit(ADA, `Explain how tools credit themselves\n\nA tool adds a line like\nCo-authored-by: Claude <noreply@anthropic.com>\nat the end of a message.\n\n\`\`\`\n${CLAUDE_TRAILER}\n\`\`\`\n`, { "docs.md": lines(4, "docs") });
  sha.claude = r.commit(ADA, `Add the parser\n\nIt reads one record at a time.\n\n${CLAUDE_TRAILER}\n`, { "parser.ts": lines(6, "parser") });
  // The bot also adds a line to the README a person wrote: one of its four lines is the bot's.
  sha.bot = r.commit(DEPENDABOT, "Bump left-pad from 1.0.0 to 1.0.1\n", { "package.json": lines(2, "package"), "README.md": `${lines(3, "readme")}left-pad 1.0.1\n` });
  // A bot named only as a co-author pushed a fix to a person's branch: the commit stays the person's.
  sha.botTrailer = r.commit(ADA, "Style the page\n\nCo-authored-by: autofix-ci[bot] <114827586+autofix-ci[bot]@users.noreply.github.com>\n", { "style.css": lines(2, "style") });
  sha.sealed = await landing(r, "lnd_sealed", [
    change(r, { agent: "scout", kind: "external", model: "model-a", files: { "ft.ts": lines(4, "ft") } }),
    change(r, { agent: "mason", kind: "internal", model: "model-b", files: { "util.ts": lines(3, "util") } }),
  ]);
  sha.altered = await landing(r, "lnd_altered", [change(r, { agent: "scout", kind: "external", model: "model-a", files: { "ft2.ts": lines(2, "ft2") } })]);
  // Anyone who can push could rewrite a note: the commit's trailer no longer matches, so only its trailers count.
  const rewritten = r.git(["notes", "--ref=firetrident", "show", sha.altered]).replace("model-a", "model-z");
  r.git(["notes", "--ref=firetrident", "add", "-f", "-C", r.git(["hash-object", "-w", "--stdin"], { input: `${rewritten}\n` }), sha.altered]);
  r.git(["checkout", "-q", "-b", "claude/fix-sort"]);
  sha.branch1 = r.commit(ADA, "Sort the list\n", { "sort.ts": lines(5, "sort") });
  sha.branch2 = r.commit(ADA, "Sort it stably\n", { "sort.ts": lines(6, "sort") });
  r.git(["checkout", "-q", "main"]);
  sha.other = r.commit(ADA, "Add another file\n", { "other.ts": lines(1, "other") });
  sha.merge = r.merge("claude/fix-sort", "Merge pull request #7 from ada/claude/fix-sort");
  // A person renames the agent's file: blame at HEAD follows it back, so its lines stay the agent's.
  r.git(["mv", "sort.ts", "sorter.ts"]);
  sha.rename = r.commit(ADA, "Rename the sorter\n", {});
  // Three of the parser's six lines go: three are still alive.
  sha.trim = r.commit(ADA, "Trim the parser\n", { "parser.ts": lines(3, "parser") });
});

/** `ft census` through the CLI: its exit code and output, without colors. */
async function ft(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { NO_COLOR: "1", FT_URL: "https://ft.test", FT_TOKEN: "unused" },
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    isTTY: false,
    fetch: (async () => {
      throw new Error("a census calls no server");
    }) as unknown as typeof fetch,
    readFile: (p) => readFile(p, "utf8"),
    sleep: async () => {},
    now: () => 0,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
  };
  const code = await main(["census", ...args], io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** An owner row as [label, kind, commits by confidence, lines added, lines alive]. */
const row = (o: OwnerRow) => [o.owner, o.identity, o.agentKind ?? null, o.kind, [o.commits.sealed, o.commits.claimed, o.commits.inferred], o.linesAdded.total, o.linesAlive.total];

describe("ft census on a repository built with stock git", () => {
  let report: CensusReport;
  beforeAll(async () => {
    report = await readCensus(repo.dir);
  });

  it("counts every commit, merge and added line, and splits them into agents, bots and people", () => {
    expect(report.repository).toEqual({ dir: repo.dir.split("/").pop(), head: sha.trim, branch: "main", shallow: false, since: null });
    expect([report.commits, report.merges, report.linesAdded]).toEqual([13, 1, 44]);
    expect(report.agents).toEqual({ commits: 5, linesAdded: 21, linesAlive: 18 });
    expect(report.bots).toEqual({ commits: 1, linesAdded: 3, linesAlive: 3 });
    expect(report.people).toEqual({ commits: 7, linesAdded: 20, linesAlive: null });
  });

  it("attributes each commit to its owner at its confidence: sealed per change, claimed, inferred, and the bot apart", () => {
    expect(report.byOwner.map(row)).toEqual([
      // The trailer commit (claimed, 6 lines, 3 still alive) and the merged branch's two commits (inferred).
      ["Claude Code", null, null, "agent", [0, 1, 2], 12, 9],
      // The intact note's change (sealed) and the landing whose note was rewritten (claimed by its credit trailer).
      ["FireTrident", "agt_scout", "external", "agent", [1, 1, 0], 6, 6],
      // Equal lines and commits: by name.
      ["dependabot[bot]", null, null, "bot", [0, 1, 0], 3, 3],
      ["FireTrident", "agt_mason", "internal", "agent", [1, 0, 0], 3, 3],
    ]);
    expect(report.byOwner[0]!.linesAdded).toEqual({ sealed: 0, claimed: 6, inferred: 6, total: 12 });
    expect(report.byOwner[0]!.linesAlive).toEqual({ sealed: 0, claimed: 3, inferred: 6, total: 9 });
  });

  it("totals by the model a note or a trailer names, the recorded model over the one a change named", () => {
    expect(report.byModel.map((m) => [m.model, m.owners, [m.commits.sealed, m.commits.claimed, m.commits.inferred], m.linesAdded.total, m.linesAlive.total])).toEqual([
      [null, ["Claude Code", "FireTrident"], [0, 1, 2], 8, 8],
      ["Claude Opus 4.5", ["Claude Code"], [0, 1, 0], 6, 3],
      ["model-a", ["FireTrident"], [1, 0, 0], 4, 4],
      ["model-b", ["FireTrident"], [1, 0, 0], 3, 3],
    ]);
  });

  it("checks the notes the way ft verify does, and says when one did not hold", () => {
    expect(report.notes).toEqual({ ref: true, trailers: 2, sealed: 1, notSealed: 1 });
    expect(report.notices).toEqual(["1 commit carries an FT-Note trailer whose note is missing, altered, or does not name the files the commit changed: it counts by its identities and trailers instead; ft verify --all says which."]);
    expect(report.alive).toMatchObject({ files: 7, blamed: 7, failed: 0, cap: null });
  });

  it("prints the tables, and the same census as JSON", async () => {
    const text = await ft([repo.dir]);
    expect(text.code).toBe(0);
    const out = text.out.split("\n");
    expect(out[0]).toBe(`census of ${report.repository.dir} at ${sha.trim!.slice(0, 12)} (main), all history: 13 commits (1 merge), 44 lines added`);
    expect(out.slice(2, 6)).toEqual([
      "        commits  lines added  lines alive",
      "agents        5           21           18",
      "bots          1            3            3",
      "people        7           20            -",
    ]);
    expect(out.slice(7, 12)).toEqual([
      "by owner                          kind   commits  sealed  claimed  inferred  lines added  lines alive",
      "Claude Code                       agent        3       0        1         2           12            9",
      "FireTrident agt_scout (external)  agent        2       1        1         0            6            6",
      "dependabot[bot]                   bot          1       0        1         0            3            3",
      "FireTrident agt_mason (internal)  agent        1       1        0         0            3            3",
    ]);
    expect(out).toContain("model not named        3       0        1         2            8            8");
    expect(text.out).toMatch(/Lines alive: git blame at HEAD over the 7 files agents and bots touched that HEAD still holds \(\d+\.\d s\); people's lines alive are not counted\./);

    const json = await ft([repo.dir, "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as CensusReport;
    expect({ ...parsed, alive: { ...parsed.alive, ms: 0 } }).toEqual({ ...report, alive: { ...report.alive, ms: 0 } });
  });

  it("says when the file cap stopped lines alive, and counts only the files it blamed", async () => {
    const capped = await readCensus(repo.dir, { limits: { files: 1, ms: BLAME_MS } });
    expect(capped.alive).toMatchObject({ files: 7, blamed: 1, cap: { kind: "files", limit: 1 } });
    // The agents' files go first, the most agent lines first: the parser, whose three alive lines are Claude's.
    expect(capped.agents.linesAlive).toBe(3);
    expect(capped.bots.linesAlive).toBe(0);
    expect(capped.byOwner.map((o) => o.linesAlive.total)).toEqual([3, 0, 0, 0]);
    const text = (await import("../src/census.ts")).censusText(capped, (await import("../src/format.ts")).colors(false));
    expect(text).toContain("Lines alive stopped at the 1-file cap: git blame read 1 of the 7 files agents and bots touched, and the other 6 are not counted, so lines alive read low.");
  });

  it("says when the time cap stopped lines alive", async () => {
    const capped = await readCensus(repo.dir, { limits: { files: BLAME_FILES, ms: 0 } });
    expect(capped.alive.cap).toEqual({ kind: "time", limit: 0 });
    expect(capped.alive.blamed).toBeLessThan(7);
    // The added lines do not depend on blame.
    expect(capped.agents.linesAdded).toBe(21);
  });

  it("counts only commits since --since, with a merged branch whose base is older still inferred", async () => {
    const since = await readCensus(repo.dir, { since: "2026-10-01T07:30:00Z" });
    expect([since.commits, since.merges, since.repository.since]).toEqual([6, 1, "2026-10-01T07:30:00Z"]);
    expect(since.byOwner.map(row)).toEqual([["Claude Code", null, null, "agent", [0, 0, 2], 6, 6]]);
    const none = await ft([repo.dir, "--since", "2030-01-01"]);
    expect(none.out.split("\n")).toEqual([`census of ${report.repository.dir} at ${sha.trim!.slice(0, 12)} (main), since 2030-01-01: 0 commits (0 merges), 0 lines added`, "No commit reachable from HEAD was made since 2030-01-01."]);
  });

  it("in a clone without the notes, counts the landings by their trailers and says how to fetch the notes", async () => {
    const clone = join(scratch("ft-census-clone-"), "demo");
    execFileSync("git", ["clone", "-q", repo.dir, clone], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe" });
    const c = await readCensus(clone);
    expect(c.notes).toEqual({ ref: false, trailers: 2, sealed: 0, notSealed: 2 });
    expect(c.notices[0]).toBe("2 commits carry an FT-Note trailer and this clone has no lineage notes: fetch them with git fetch origin refs/notes/firetrident:refs/notes/firetrident, then run ft census again.");
    // The two-change landing goes to the first agent its credit trailers name.
    expect(c.byOwner.filter((o) => o.owner === "FireTrident").map(row)).toEqual([["FireTrident", "agt_scout", null, "agent", [0, 2, 0], 9, 9]]);
    expect(c.agents).toEqual(report.agents);
  });

  it("reads the same census from a subdirectory of the work tree", async () => {
    const sub = join(repo.dir, "notes-to-self");
    mkdirSync(sub);
    const inside = await readCensus(sub);
    expect({ ...inside, alive: { ...inside.alive, ms: 0 } }).toEqual({ ...report, alive: { ...report.alive, ms: 0 } });
  });

  it("answers in a sentence when the directory is not a repository, or has no commits", async () => {
    const empty = scratch("ft-census-empty-");
    expect(await ft([empty])).toMatchObject({ code: 2, err: `ft: ${empty} is not a git repository: run ft census inside a clone, or give its path` });
    execFileSync("git", ["init", "-q"], { cwd: empty, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(await ft([empty])).toMatchObject({ code: 2, err: `ft: ${empty} has no commits yet: there is nothing to count` });
    expect(await ft([join(empty, "missing")])).toMatchObject({ code: 2, err: expect.stringContaining("is not a directory") });
  });

  it("documents the caps it runs with", () => {
    expect(helpText("census").replace(/\s+/g, " ")).toContain(`at most ${BLAME_FILES.toLocaleString("en-US")} files and ${BLAME_MS / 1000} s`);
    expect(helpText()).toContain("census [<dir>]");
  });
});
