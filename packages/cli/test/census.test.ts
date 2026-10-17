import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/args.ts";
import {
  LogReader,
  SIGNATURES,
  aliveLine,
  branchCredit,
  broughtIn,
  claimedCredit,
  generations,
  identityCredit,
  mergedBranch,
  messageTrailers,
  notices,
  parseCensusCommand,
  sealedCredits,
  sinceSeconds,
  tally,
  type Attributed,
  type Credit,
} from "../src/census.ts";

/**
 * `ft census` without git (census.ts): which lines of a message are trailers, what an identity or a merged branch says,
 * what an intact note credits, which commits a merge brought in, how git log's stream is read, and how rows add up.
 */

const ID = { authorName: "Ada Lovelace", authorEmail: "ada@example.com", committerName: "Ada Lovelace", committerEmail: "ada@example.com" };
const CLAUDE = "Co-authored-by: Claude Opus 4.5 <noreply@anthropic.com>";

describe("messageTrailers", () => {
  it("reads the last paragraph when every line is a trailer", () => {
    expect(messageTrailers(`Fix the parser\n\nA longer body.\n\n${CLAUDE}\nSigned-off-by: Ada <ada@example.com>\n`)).toEqual([
      { key: "Co-authored-by", value: "Claude Opus 4.5 <noreply@anthropic.com>" },
      { key: "Signed-off-by", value: "Ada <ada@example.com>" },
    ]);
  });

  it("ignores the same line in prose, in the subject, in a code fence and indented", () => {
    expect(messageTrailers(`Fix\n\nTools add a line like\n${CLAUDE}\nat the end.`)).toEqual([]);
    expect(messageTrailers(`Fix\n\n${CLAUDE}\n\nThe last paragraph is prose.`)).toEqual([]);
    expect(messageTrailers(CLAUDE)).toEqual([]);
    expect(messageTrailers(`Fix\n${CLAUDE}`)).toEqual([]);
    expect(messageTrailers(`Fix\n\n\`\`\`\n${CLAUDE}\n\`\`\``)).toEqual([]);
    // A fence left open above the last paragraph: the paragraph is quoted code.
    expect(messageTrailers(`Fix\n\n\`\`\`text\nexample\n\n${CLAUDE}`)).toEqual([]);
    expect(messageTrailers(`Fix\n\n    ${CLAUDE}`)).toEqual([]);
    expect(messageTrailers(`Fix\n\n> ${CLAUDE}`)).toEqual([]);
  });

  it("follows a closed fence, folded lines, git's cherry-pick line and CRLF", () => {
    expect(messageTrailers(`Fix\n\n\`\`\`\ncode\n\`\`\`\n\n${CLAUDE}`)).toHaveLength(1);
    expect(messageTrailers(`Fix\r\n\r\nReviewed-by: Ada\r\n  Lovelace\r\n(cherry picked from commit 0123456789abcdef)\r\n`)).toEqual([{ key: "Reviewed-by", value: "Ada Lovelace" }]);
  });
});

describe("identityCredit and the signature table", () => {
  it("knows each owner once, and every login, address and branch prefix is lowercase", () => {
    const owners = SIGNATURES.map((s) => s.owner);
    expect(new Set(owners).size).toBe(owners.length);
    for (const s of SIGNATURES) for (const v of [...(s.logins ?? []), ...(s.addresses ?? []), ...(s.branches ?? []), s.nameSuffix ?? ""]) expect(v).toBe(v.toLowerCase());
  });

  it("names an agent tool by its address or login, with the model its name carries", () => {
    expect(identityCredit("Claude", "noreply@anthropic.com")).toEqual({ owner: "Claude Code", identity: null, kind: "agent", model: null, confidence: "claimed" });
    expect(identityCredit("Claude Opus 4.7 (1M context)", "NoReply@Anthropic.com")?.model).toBe("Claude Opus 4.7 (1M context)");
    // GitHub's no-reply address carries the login after any account number.
    expect(identityCredit("Copilot", "223556219+Copilot@users.noreply.github.com")?.owner).toBe("GitHub Copilot");
    expect(identityCredit("copilot-swe-agent[bot]", "198982749+Copilot@users.noreply.github.com")?.owner).toBe("GitHub Copilot");
    expect(identityCredit("aider (openai/gpt-4o)", "noreply@aider.chat")).toMatchObject({ owner: "Aider", model: "openai/gpt-4o" });
    expect(identityCredit("Ada Lovelace (aider)", "ada@example.com")?.owner).toBe("Aider");
  });

  it("gives a FireTrident credit trailer's agent id as the identity", () => {
    expect(identityCredit("scout", "agt_0abc12@order-backend.noreply.firetrident.dev")).toMatchObject({ owner: "FireTrident", identity: "agt_0abc12", kind: "agent" });
  });

  it("counts bots apart, any other [bot] login under its own name, and never a person whose login looks like a tool", () => {
    expect(identityCredit("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")).toMatchObject({ owner: "dependabot[bot]", kind: "bot" });
    expect(identityCredit("autofix-ci[bot]", "114827586+autofix-ci[bot]@users.noreply.github.com")).toMatchObject({ owner: "autofix-ci[bot]", kind: "bot" });
    expect(identityCredit("FireTrident", "lanes@firetrident.dev")).toMatchObject({ owner: "FireTrident trunk writer", kind: "bot" });
    expect(identityCredit("JulesVerner", "49474517+JulesVerner@users.noreply.github.com")).toBeNull();
    expect(identityCredit("Claude Shannon", "claude@example.com")).toBeNull();
    expect(identityCredit("GitHub", "noreply@github.com")).toBeNull();
  });
});

describe("claimedCredit", () => {
  it("takes the first agent of the author, the committer and the trailers, with a model any of them names", () => {
    const both = claimedCredit({ ...ID, message: `Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>\n${CLAUDE}\nCo-authored-by: Copilot <1+Copilot@users.noreply.github.com>` });
    expect(both).toEqual({ owner: "Claude Code", identity: null, kind: "agent", model: "Claude Opus 4.5", confidence: "claimed" });
    const bot = { authorName: "dependabot[bot]", authorEmail: "49699333+dependabot[bot]@users.noreply.github.com" };
    expect(claimedCredit({ ...ID, ...bot, message: `Bump\n\n${CLAUDE}` })?.owner).toBe("Claude Code");
    expect(claimedCredit({ ...ID, ...bot, message: "Bump" })).toMatchObject({ owner: "dependabot[bot]", kind: "bot" });
  });

  it("does not move a person's commit for a bot named only in a co-author trailer", () => {
    expect(claimedCredit({ ...ID, message: "Fix\n\nCo-authored-by: autofix-ci[bot] <114827586+autofix-ci[bot]@users.noreply.github.com>" })).toBeNull();
  });

  it("reads FireTrident's FT-Agent trailer", () => {
    const writer = { authorName: "FireTrident", authorEmail: "lanes@firetrident.dev", committerName: "FireTrident", committerEmail: "lanes@firetrident.dev" };
    expect(claimedCredit({ ...writer, message: "Land 1 change: x\n\n- x\n\nFT-Landing: lnd_1\nFT-Agent: agt_a\nFT-Note: sha256:00" })).toMatchObject({ owner: "FireTrident", identity: "agt_a", kind: "agent" });
    expect(claimedCredit({ ...writer, message: "Antibody\nFT-Landing: lnd_2" })).toMatchObject({ owner: "FireTrident trunk writer", kind: "bot" });
  });
});

describe("merged branches", () => {
  it("reads the merged branch from GitHub's and git's merge subjects, and the tool from its prefix", () => {
    expect(mergedBranch("Merge pull request #12 from ada/claude/fix-sort")).toBe("claude/fix-sort");
    expect(mergedBranch("Merge branch 'codex/add-tests' into main")).toBe("codex/add-tests");
    expect(mergedBranch("Merge remote-tracking branch 'origin/copilot/fix-7'")).toBe("copilot/fix-7");
    expect(mergedBranch("Merge branch 'main' into claude/fix-sort")).toBe("main");
    expect(mergedBranch("Fix the merge of claude/x")).toBeNull();
    expect(branchCredit("claude/fix-sort")).toEqual({ owner: "Claude Code", identity: null, kind: "agent", model: null, confidence: "inferred" });
    expect(branchCredit("dependabot/npm_and_yarn/x")?.kind).toBe("bot");
    expect(branchCredit("claude/")).toBeNull();
    expect(branchCredit("claudette/x")).toBeNull();
  });

  it("finds the commits a merge brought in, not those its first parent reaches, nor past the graph's edge", () => {
    // main: a - b - c - M2 ; branch: b - x - y(merges c) - z ; M2 merges z. M1 = y merges c into the branch.
    const graph = new Map<string, string[]>([
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
      ["x", ["b"]],
      ["y", ["x", "c"]],
      ["z", ["y"]],
      ["M2", ["c", "z"]],
    ]);
    const gen = generations(graph);
    expect(gen.get("a")).toBe(1);
    expect(gen.get("y")).toBe(4);
    expect(gen.get("M2")).toBe(6);
    expect(broughtIn(graph, gen, "M2").sort()).toEqual(["x", "y", "z"]);
    expect(broughtIn(graph, gen, "y")).toEqual(["c"]);
    expect(broughtIn(graph, gen, "c")).toEqual([]);
    // A --since window: b is outside, so the walk ends at x and c.
    const cut = new Map([...graph].filter(([sha]) => sha !== "a" && sha !== "b"));
    expect(broughtIn(cut, generations(cut), "M2").sort()).toEqual(["x", "y", "z"]);
  });
});

describe("LogReader", () => {
  const record = (sha: string, parents: string, message: string, numstat: string) => `\x1e${sha}\x1f${parents}\x1fAda\x1fada@example.com\x1fAda\x1fada@example.com\x1f1700000000\x1f${message}\x1f\0${numstat}`;
  const stream = [
    record("c3", "c2", "Rename\n\nCo-authored-by: X <x@y>\n", "\n2\t1\t\0old name.ts\0new\x1ename.ts\0-\t-\tlogo.png\0"),
    record("c2", "c1 c0", "Merge branch 'claude/x'\n", ""),
    record("c1", "", "Start\n", "\n10\t0\ta.ts\0"),
  ].join("");

  it("reads renames, binary files and merges, the same in one chunk or one character at a time", () => {
    const whole = new LogReader();
    const all = [...whole.push(stream), ...whole.end()];
    expect(all.map((c) => [c.sha, c.parents, c.files, c.binary])).toEqual([
      ["c3", ["c2"], [{ path: "new\x1ename.ts", added: 2 }], ["logo.png"]],
      ["c2", ["c1", "c0"], [], []],
      ["c1", [], [{ path: "a.ts", added: 10 }], []],
    ]);
    expect(all[0]!.message).toBe("Rename\n\nCo-authored-by: X <x@y>\n");
    expect(all[0]!.renames).toEqual([{ from: "old name.ts", to: "new\x1ename.ts" }]);
    const bit = new LogReader();
    const pieces = [...stream].flatMap((ch) => bit.push(ch));
    expect([...pieces, ...bit.end()]).toEqual(all);
  });
});

describe("sealedCredits", () => {
  const proposal = (agentId: string, paths: string[], extra: Record<string, unknown> = {}) => ({ id: `prp_${agentId}`, agentId, agentKind: "internal", model: "named-model", writeSet: paths.map((path) => ({ path, blob: "a".repeat(40) })), ...extra });

  it("gives each path to the change whose write set names it, with the recorded model first", () => {
    const note = { proposals: [proposal("agt_a", ["x.ts", "y.ts"], { provenance: { author: "platform", model: { evidence: "observed", name: "observed-model" } } }), proposal("agt_b", ["y.ts"])] };
    const sealed = sealedCredits(note, ["x.ts", "y.ts"])!;
    expect(sealed.all.map((c) => [c.identity, c.model, c.confidence, c.agentKind])).toEqual([
      ["agt_a", "observed-model", "sealed", "internal"],
      ["agt_b", "named-model", "sealed", "internal"],
    ]);
    expect(sealed.byPath.get("y.ts")?.identity).toBe("agt_b");
    expect(sealed.first.identity).toBe("agt_a");
  });

  it("refuses a note that does not name a file the commit changed, and gives system commits to the trunk writer", () => {
    expect(sealedCredits({ proposals: [proposal("agt_a", ["x.ts"])] }, ["x.ts", "other.ts"])).toBeNull();
    expect(sealedCredits({ proposals: [] }, [])).toBeNull();
    expect(sealedCredits("text", [])).toBeNull();
    expect(sealedCredits({ system: { kind: "antibody", path: "t.test.ts" }, proposals: [proposal("agt_a", ["x.ts"])] }, ["t.test.ts"])?.first).toMatchObject({ owner: "FireTrident trunk writer", identity: "antibody", kind: "bot" });
    expect(sealedCredits({ revert: { commit: "b".repeat(40) }, proposals: [] }, ["x.ts"])?.first.identity).toBe("revert");
  });
});

describe("tally", () => {
  const credit = (owner: string, confidence: Credit["confidence"], extra: Partial<Credit> = {}): Credit => ({ owner, identity: null, kind: "agent", model: null, confidence, ...extra });

  it("adds commits, lines added and lines alive per owner, model and class, with each commit once per owner", () => {
    const a = credit("FireTrident", "sealed", { identity: "agt_a", model: "m1" });
    const b = credit("FireTrident", "sealed", { identity: "agt_b", model: "m1" });
    const bot = credit("dependabot[bot]", "claimed", { kind: "bot" });
    const commits: Attributed[] = [
      { sha: "s1", merge: false, files: [{ path: "x", added: 5 }, { path: "y", added: 2 }], credit: a, credits: [a, b], byPath: new Map([["x", a], ["y", b]]) },
      { sha: "s2", merge: false, files: [{ path: "p", added: 4 }], credit: bot, credits: [bot] },
      { sha: "s3", merge: true, files: [], credit: null, credits: [] },
      { sha: "s4", merge: false, files: [{ path: "q", added: 9 }], credit: null, credits: [] },
    ];
    const t = tally(commits, new Map([["s1\0x", 3], ["s1\0y", 2], ["s2", 1], ["s4", 9]]));
    expect([t.commits, t.merges, t.linesAdded]).toEqual([4, 1, 20]);
    expect(t.agents).toEqual({ commits: 1, linesAdded: 7, linesAlive: 5 });
    expect(t.bots).toEqual({ commits: 1, linesAdded: 4, linesAlive: 1 });
    expect(t.people).toEqual({ commits: 2, linesAdded: 9, linesAlive: null });
    expect(t.byOwner.map((r) => [r.owner, r.identity, r.commits.total, r.linesAdded.sealed, r.linesAlive.total])).toEqual([
      ["FireTrident", "agt_a", 1, 5, 3],
      ["dependabot[bot]", null, 1, 0, 1],
      ["FireTrident", "agt_b", 1, 2, 2],
    ]);
    expect(t.byModel).toEqual([{ model: "m1", owners: ["FireTrident"], commits: { sealed: 1, claimed: 0, inferred: 0, total: 1 }, linesAdded: { sealed: 7, claimed: 0, inferred: 0, total: 7 }, linesAlive: { sealed: 5, claimed: 0, inferred: 0, total: 5 } }]);
  });
});

describe("the command and its sentences", () => {
  it("parses ft census [<dir>] [--since <date>] [--json]", () => {
    expect(parseCommand(["census"])).toMatchObject({ ok: true, command: { name: "census" }, flags: { json: false } });
    expect(parseCommand(["census", "../hono", "--since", "2025-01-01", "--json"])).toMatchObject({ ok: true, command: { name: "census", dir: "../hono", since: "2025-01-01" }, flags: { json: true } });
    expect(parseCommand(["census", "a", "b"])).toMatchObject({ ok: false, error: expect.stringContaining('unexpected argument "b"') });
    expect(parseCommand(["census", "--since", "last week"])).toMatchObject({ ok: false, error: expect.stringContaining("--since takes a date such as 2025-01-01") });
    // No rolled-over day, and no time without its zone (it would be read in local time).
    expect(parseCensusCommand({ since: "2025-02-30" }, [])).toContain("--since takes a date");
    expect(parseCensusCommand({ since: "2025-01-01 12:00" }, [])).toContain("--since takes a date");
    expect(parseCensusCommand({ since: "2024-02-29T12:00:00+02:00" }, [])).toEqual({ name: "census", since: "2024-02-29T12:00:00+02:00" });
    expect(sinceSeconds("2025-01-01")).toBe(1_735_689_600);
  });

  it("says when a cap stopped lines alive, and what to fetch when notes are missing", () => {
    expect(aliveLine({ files: 40, blamed: 12, failed: 1, cap: { kind: "time", limit: 60_000 }, ms: 60_010 })).toBe(
      "Lines alive stopped at the 60 s time cap: git blame read 12 of the 40 files agents and bots touched, and the other 27 are not counted, so lines alive read low. 1 file could not be blamed and is not counted.",
    );
    expect(aliveLine({ files: 2_345, blamed: 2_000, failed: 0, cap: { kind: "files", limit: 2_000 }, ms: 9_000 })).toContain("stopped at the 2,000-file cap: git blame read 2,000 of the 2,345 files");
    expect(aliveLine({ files: 3, blamed: 3, failed: 0, cap: null, ms: 250 })).toBe("Lines alive: git blame at HEAD over the 3 files agents and bots touched that HEAD still holds (0.3 s); people's lines alive are not counted.");
    expect(notices({ notes: { ref: false, trailers: 2, sealed: 0, notSealed: 2 }, shallow: true })).toEqual([
      "2 commits carry an FT-Note trailer and this clone has no lineage notes: fetch them with git fetch origin refs/notes/firetrident:refs/notes/firetrident, then run ft census again.",
      "This clone is shallow: its oldest commit counts every file it holds as lines added. Clone without --depth to count the whole history.",
    ]);
    expect(notices({ notes: { ref: true, trailers: 3, sealed: 2, notSealed: 1 }, shallow: false })[0]).toContain("1 commit carries an FT-Note trailer whose note is missing, altered, or does not name the files the commit changed: it counts by its identities");
  });
});
