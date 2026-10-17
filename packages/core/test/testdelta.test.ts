import { describe, expect, it } from "vitest";
import { authorsText, changeRung, proofPath, reachText, reachWarns, testDelta, testsLines, testsRow, type FileOutcomes } from "../src/testdelta.ts";
import type { CheckResult, LandingTests, LineageNote, NoteDecision, TestReach } from "../src/types.ts";

/** A landing's test row: what landed it, the per-test delta between two commits, and the words every card shows. */

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const CLEF = "@cf/cloudflare/clef";
const gate = (detail: string): CheckResult => ({ name: "gate", ok: true, ms: 0, detail });
const PROOF = gate("D3 innate+proof → land by deterministic at head 9a7220a8f2f2 (confirmations: innate + deterministic): proven");
const LLM = gate("L1 innate+llm → land by llm at head 9a7220a8f2f2 (confirmations: innate + llm): approved");
const AUTONOMY = gate("R3 innate+autonomy → land by reflex at head 9a7220a8f2f2 (confirmations: innate + autonomy): reflex clear");
const llmLand: NoteDecision = { kind: "triage", layer: "llm", p: 0.9, action: "land", by: GEMMA };

const change = (checks: CheckResult[], decisions: NoteDecision[] = [], id = "prp_1") => ({
  id,
  agentId: "agt_1",
  agentKind: "internal",
  intent: { id: `int_${id}`, title: "t", why: "w" },
  writeSet: [{ path: "src/a.ts", blob: "b".repeat(40) }],
  readSet: [],
  decisions,
  evidence: { checks },
});
const note = (...proposals: unknown[]): LineageNote => ({ schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals }) as unknown as LineageNote;

describe("what landed it", () => {
  it("names each rung: deterministic proof, a model's approval, earned autonomy, a person, no review", () => {
    expect(changeRung(change([PROOF]))).toEqual({ rung: "deterministic" });
    expect(changeRung(change([{ name: `llm: ${GEMMA}`, ok: true, ms: 1 }, LLM], [llmLand]))).toEqual({ rung: "model", by: GEMMA });
    expect(changeRung(change([{ name: `reflex: ${CLEF}`, ok: true, ms: 1 }, AUTONOMY]))).toEqual({ rung: "autonomy", by: CLEF });
    const human: NoteDecision = { kind: "triage", layer: "human", p: 1, action: "approve", by: "Lee" };
    expect(changeRung(change([gate("R5 escalate → escalate by reflex at head 9a7220a8f2f2: needs a human")], [human]))).toEqual({ rung: "person", by: "Lee" });
    expect(changeRung(change([], [{ ...human, by: "api" }]))).toEqual({ rung: "person" });
    expect(changeRung(change([]))).toEqual({ rung: "unreviewed" });
  });

  it("reads one phrase for a landing, grouping its changes by rung", () => {
    expect(proofPath(note(change([PROOF])))).toMatchObject({ text: "deterministic", rungs: [{ rung: "deterministic", count: 1 }] });
    expect(proofPath(note(change([PROOF], [], "p1"), change([PROOF], [], "p2"))).text).toBe("deterministic");
    expect(proofPath(note(change([PROOF], [], "p1"), change([PROOF], [], "p2"), change([LLM], [llmLand], "p3"))).text).toBe("deterministic ×2, model approval (gemma-4-26b-a4b-it)");
    expect(proofPath({ revert: { by: "Matt", of: "lnd_0" }, proposals: [] }).text).toBe("a person's revert (Matt)");
    expect(proofPath({ system: { kind: "protect" }, proposals: [] }).text).toBe("FireTrident's own commit");
    expect(proofPath(null).text).toBe("unknown: the note lists no change");
  });
});

const file = (key: string, tests: Array<[string, string]> | null): FileOutcomes => ({ key, tests: tests ? tests.map(([name, status]) => ({ name, status })) : null });

describe("the delta between the base and the certified commit", () => {
  it("counts nothing for files that reached the same code", () => {
    const same = new Map([["a.test.ts", file("k1", [["adds", "pass"]])]]);
    expect(testDelta(same, new Map(same))).toEqual({ lost: 0, lostTests: [], added: 0, unknownFiles: 0 });
  });

  it("finds lost tests by name: gone, failing, or a duplicate that passes fewer times", () => {
    const base = new Map([
      ["a.test.ts", file("k1", [["adds", "pass"], ["subtracts", "pass"], ["twice", "pass"], ["twice", "pass"], ["was red", "fail"]])],
      ["gone.test.ts", file("k2", [["one", "pass"], ["two", "skipped"]])],
    ]);
    const after = new Map([["a.test.ts", file("k3", [["adds", "pass"], ["subtracts", "fail"], ["twice", "pass"], ["was red", "pass"], ["brand new", "pass"]])]]);
    const d = testDelta(base, after);
    expect(d.lost).toBe(3);
    expect(d.lostTests).toEqual([
      { file: "a.test.ts", name: "subtracts" },
      { file: "a.test.ts", name: "twice" },
      { file: "gone.test.ts", name: "one" },
    ]);
    // "was red" passes now and "brand new" is new: both count as new passing tests.
    expect(d.added).toBe(2);
  });

  it("counts a new test file's passing tests as new", () => {
    const d = testDelta(new Map(), new Map([["b.test.ts", file("k9", [["x", "pass"], ["y", "todo"]])]]));
    expect(d).toMatchObject({ lost: 0, added: 1 });
  });

  it("leaves out files whose results are no longer kept, and says how many", () => {
    const base = new Map([["a.test.ts", file("k1", null)], ["b.test.ts", file("k2", [["x", "pass"]])]]);
    const after = new Map([["a.test.ts", file("k5", [["x", "pass"]])], ["b.test.ts", file("k6", null)]]);
    expect(testDelta(base, after)).toEqual({ lost: 0, lostTests: [], added: 0, unknownFiles: 2 });
  });

  it("names at most the cap", () => {
    const base = new Map([["a.test.ts", file("k1", Array.from({ length: 30 }, (_, i): [string, string] => [`t${i}`, "pass"]))]]);
    const d = testDelta(base, new Map());
    expect(d.lost).toBe(30);
    expect(d.lostTests).toHaveLength(20);
  });
});

const proof = { rungs: [{ rung: "deterministic" as const, count: 1 }], text: "deterministic" };
const row = (t: Partial<LandingTests>): string => testsRow({ status: "certified", proof, ...t } as LandingTests);

describe("the row", () => {
  it("reads base against certified, lost, proof and spend", () => {
    const t = { base: { sha: "a".repeat(40), status: "red" as const, pass: 433, tests: 434, failing: 1, exact: true }, certified: { sha: "b".repeat(40), status: "green" as const, pass: 434, tests: 434, failing: 0 }, lost: 0, spend: { usd: 0.0003, calls: 2, intents: 1 } };
    expect(row(t)).toBe("433/434 at base, 434/434 certified, 0 lost · proof: deterministic · $0.0003 (model calls this platform made)");
    expect(row({ ...t, added: 2, spend: undefined })).toBe("433/434 at base, 434/434 certified, 0 lost, 2 new · proof: deterministic");
  });

  it("names the commit when the base itself was not certified", () => {
    const t = { base: { sha: "c0ffee1234".padEnd(40, "0"), status: "green" as const, pass: 60, tests: 60, failing: 0, exact: false }, certified: { sha: "b".repeat(40), status: "green" as const, pass: 61, tests: 61, failing: 0 }, lost: 1, unknownFiles: 1 };
    expect(row(t)).toBe("60/60 at c0ffee1, before base, 61/61 certified, 1 lost (1 test file not compared) · proof: deterministic");
    expect(row({ certified: t.certified })).toBe("no result at or before base, 61/61 certified · proof: deterministic");
  });

  it("says not certified yet, and no tests this platform can run", () => {
    expect(row({ status: "pending" })).toBe("not certified yet · proof: deterministic");
    expect(row({ status: "pending", reason: "trunk certification is off for this colony" })).toBe("not certified yet: trunk certification is off for this colony · proof: deterministic");
    expect(row({ status: "no-tests", reason: "no test file imports node:test (223 test files)" })).toBe("no tests this platform can run · proof: deterministic");
  });
});

describe("the lines under the row", () => {
  const reach = (r: Partial<TestReach>): TestReach => ({ earlier: 0, own: 0, later: 0, earlierFiles: [], ownFiles: [], checked: 4, ...r });

  it("warns when no earlier test reaches the change", () => {
    expect(reachWarns(reach({ own: 1, ownFiles: ["test/new.test.ts"] }))).toBe(true);
    expect(reachText(reach({ own: 1 }))).toBe("No earlier test reaches this change: only 1 test file it wrote reaches its files.");
    expect(reachText(reach({}))).toBe("No earlier test reaches this change: no test file reaches its files.");
    expect(reachText(reach({ later: 2 }))).toBe("No earlier test reaches this change: only 2 later test files reach its files.");
    expect(reachWarns(reach({ none: "no-code" }))).toBe(false);
    expect(reachText(reach({ none: "no-code" }))).toBe("It changed no file a test can load.");
  });

  it("names the earlier tests that reach it", () => {
    const r = reach({ earlier: 7, earlierFiles: ["a.test.ts", "b.test.ts"], own: 1, bounded: "only the first 300 test files were checked." });
    expect(reachWarns(r)).toBe(false);
    expect(reachText(r)).toBe("7 earlier test files reach its files (a.test.ts, b.test.ts and 5 more), and 1 test file it wrote (only the first 300 test files were checked).");
  });

  it("splits the tests by whose they are", () => {
    const text = authorsText({ inherited: { files: 40, tests: 400 }, agents: { files: 3, tests: 30, by: [GEMMA] }, person: { files: 1, tests: 4, by: ["Lee"] }, uncounted: 1 });
    expect(text).toBe("400 inherited from the repository (40 files) · 30 written or edited by agents (3 files: gemma-4-26b-a4b-it) · 4 in edits a person approved (1 file: Lee) (1 file whose test count is no longer kept)");
  });

  it("says why a colony has no test this platform can run", () => {
    expect(testsLines({ status: "no-tests", reason: "no test file imports node:test (223 test files)" })).toEqual([{ k: "note", text: "No test file imports node:test (223 test files).", warn: false }]);
  });

  it("lists lost tests, a red result first, whose tests, the reach and notes", () => {
    const lines = testsLines({
      status: "certified",
      lost: 6,
      lostTests: [{ file: "a.test.ts", name: "adds" }],
      red: { sha: "d".repeat(40), status: "red", pass: 58, tests: 60, failing: 2 },
      authors: { inherited: { files: 1, tests: 2 }, agents: { files: 0, tests: 0 }, person: { files: 0, tests: 0 } },
      reach: reach({ own: 1 }),
      detail: "The base's results are no longer kept.",
    });
    expect(lines.map((l) => [l.k, l.warn])).toEqual([
      ["lost", true],
      ["red", false],
      ["whose", false],
      ["reach", true],
      ["note", false],
    ]);
    expect(lines[0]!.text).toBe("Passed at base, not at the certified commit: adds (a.test.ts); and 5 more.");
    expect(lines[1]!.text).toBe("Trunk was red at ddddddd after it landed (2 of 60 failing) before a green certification included it.");
  });
});
