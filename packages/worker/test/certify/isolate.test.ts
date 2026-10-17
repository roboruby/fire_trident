import { describe, expect, it } from "vitest";
import type { FirstRed, FirstRedIsolation, Path, Sha, Suspect } from "@fire_trident/core";
import { withFirstRed, type ProbeOutcome, type Target } from "../../src/certify/bisect.ts";
import { HALF_RUNS, ISOLATE_RUNS, WITHOUT_MAX, isolateLanding, isolationLines, judgeRevert, judgeWithout, markIsolated, type IsolateInput } from "../../src/certify/isolate.ts";
import type { RangeLanding } from "../../src/certify/range.ts";

/**
 * Proposal isolation's parts in Node, over a model landing: proposals p0..pN-1 each write src/pI.ts, and the failing
 * test fails while the culprits' files are as the landing wrote them (all of them, or any one). The runs, reads and
 * clock are stand-ins the tests control, so the bounds can be counted exactly.
 */

const TEST: Path = "test/a.test.ts";
const BREAKS = `${TEST}\u0000breaks`;
const OTHER = `${TEST}\u0000other`;
const targets: Target[] = [{ file: TEST, name: "breaks" }];
const LANDING: RangeLanding = { landingId: "lnd_9", trunkSha: "1".repeat(40), at: 9 };
const RED: RangeLanding = { landingId: "lnd_12", trunkSha: "2".repeat(40), at: 12 };
const PARENT: Sha = "0".repeat(40);

interface Model {
  input: IsolateInput;
  /** Each run: the proposals whose files were put back, and its time-out. */
  calls: Array<{ commit: Sha; back: string[]; ms: number }>;
}

/**
 * A landing of `n` proposals; the failing test fails while `culprits` are all on the tree (`any`: while one is), and the
 * other test passes unless `other` says otherwise for the tree. `over` replaces any input.
 */
function model(n: number, culprits: number[], opts: { any?: boolean; other?: (back: Set<string>) => string; over?: Partial<IsolateInput> } = {}): Model {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const calls: Model["calls"] = [];
  const note = { proposals: ids.map((id, i) => ({ id, agentId: `agt_${i}`, intent: { id: `int_${i}`, title: `Change ${i}` }, writeSet: [{ path: `src/${id}.ts`, blob: `L:src/${id}.ts` }] })) };
  const input: IsolateInput = {
    landing: LANDING,
    parent: { trunkSha: PARENT },
    red: RED,
    note,
    closure: new Set([TEST, ...ids.map((id) => `src/${id}.ts`)]),
    targets,
    first: { red: true, files: [TEST], reach: [TEST], tests: { [BREAKS]: "fail", [OTHER]: "pass" } },
    read: async (sha, paths) => paths.map((path) => ({ path, blob: path === TEST ? "T" : sha === PARENT ? `P:${path}` : `L:${path}` })),
    probe: async (commit, over, _targets, ms): Promise<ProbeOutcome> => {
      const back = new Set([...over.keys()].map((p) => p.replace(/^src\/(.*)\.ts$/, "$1")));
      calls.push({ commit: commit.trunkSha, back: [...back].sort(), ms });
      const on = culprits.filter((c) => !back.has(`p${c}`)).length;
      const red = opts.any ? on > 0 : on === culprits.length;
      return { red, files: red ? [TEST] : [], reach: [TEST], tests: { [BREAKS]: red ? "fail" : "pass", [OTHER]: opts.other ? opts.other(back) : "pass" } };
    },
    ...opts.over,
  };
  return { input, calls };
}

describe("isolateLanding", () => {
  it("halves before excluding anyone, then leaves one out, then proves the culprit causal on the red commit, within its runs", async () => {
    const m = model(26, [7]);
    const out = await isolateLanding(m.input);
    expect(out).toMatchObject({ status: "isolated", culprit: { id: "p7", intentId: "int_7", title: "Change 7", agentId: "agt_7", paths: ["src/p7.ts"] }, candidates: 26, revert: { causal: true, trunkSha: RED.trunkSha } });
    expect(out.runs.map((r) => [r.kind, r.proposals.length, r.outcome])).toEqual([
      ["half", 13, "red"],
      ["half", 13, "pass"],
      ["half", 7, "pass"],
      ["without", 1, "green"],
      ["without", 1, "red"],
      ["without", 1, "red"],
      ["without", 1, "red"],
      ["without", 1, "red"],
      ["without", 1, "red"],
      ["revert", 1, "green"],
    ]);
    expect(out.halves).toEqual([Array.from({ length: 13 }, (_, i) => `p${i}`), Array.from({ length: 13 }, (_, i) => `p${i + 13}`)]);
    expect(out.probes).toBe(ISOLATE_RUNS);
    expect(m.calls).toHaveLength(ISOLATE_RUNS);
    // The halves run on the landing with the other proposals put back; the revert probe on the red commit, without the culprit.
    expect(m.calls[0]).toMatchObject({ commit: LANDING.trunkSha, back: Array.from({ length: 13 }, (_, i) => `p${i + 13}`).sort() });
    expect(m.calls[3]).toMatchObject({ commit: LANDING.trunkSha, back: ["p7"] });
    expect(m.calls.at(-1)).toMatchObject({ commit: RED.trunkSha, back: ["p7"] });
    expect(out.reason).toBe(
      `Proposal p7 is the one inside the landing: without it the failing tests pass and every other test in their files keeps its outcome (run 4, and without each of the other 5 candidates they did not); causal: reverting it alone turns these tests green (on the red commit ${RED.trunkSha.slice(0, 7)}). The first part of the failing half passed alone, so the rest was tried (an interaction across them would look the same).`,
    );
  });

  it("respects its bounds: at most three halvings, six left out, the runs in all, and its time", async () => {
    // Forty candidates: the failing half is halved again, and of the ten left only six are tried one at a time.
    const wide = model(40, [7]);
    const out = await isolateLanding(wide.input);
    expect(out.runs.filter((r) => r.kind === "half")).toHaveLength(HALF_RUNS);
    expect(out.runs.filter((r) => r.kind === "without")).toHaveLength(WITHOUT_MAX);
    expect(out).toMatchObject({ status: "none", untried: ["p6", "p7", "p8", "p9"], probes: 9 });
    expect(out.reason).toBe("No single proposal: without each of p0, p1, p2, p3 +2 the failing tests still failed or another test changed its outcome. p6, p7, p8, p9 were not tried (at most 6 are tried one at a time).");

    // Fewer runs allowed: no run is spent one at a time when none would be left for the revert probe.
    const few = model(26, [7], { over: { maxRuns: 4 } });
    const cut = await isolateLanding(few.input);
    expect(cut).toMatchObject({ status: "inconclusive", probes: 3, reason: "Isolating a proposal stopped: its 4 runs allow no more. The landing-level answer stands." });
    expect(few.calls).toHaveLength(3);

    // Time: each run takes 25 s of a 60 s budget; no run starts once less than a second is left, and none gets more than is left.
    let clock = 0;
    const slow = model(26, [7], { over: { now: () => clock, budgetMs: 60_000, runMs: 20_000 } });
    const probe = slow.input.probe;
    slow.input.probe = async (...args) => {
      const r = await probe(...args);
      clock += 25_000;
      return r;
    };
    const timed = await isolateLanding(slow.input);
    expect(timed).toMatchObject({ status: "inconclusive", probes: 3, reason: "Isolating a proposal stopped: its 60 s ran out after 3 runs. The landing-level answer stands." });
    expect(slow.calls.map((c) => c.ms)).toEqual([20_000, 20_000, 10_000]);
  });

  it("fails open: a run that hangs or throws, or a read that fails, ends inconclusive with the reason, and nothing escapes", async () => {
    const hang = model(4, [1], { over: { runMs: 200, probe: () => new Promise<never>(() => undefined) } });
    expect(await isolateLanding(hang.input)).toMatchObject({ status: "inconclusive", probes: 1, runs: [], reason: "Isolating a proposal stopped: a run took longer than 0.2 s. The landing-level answer stands." });

    const throws = model(4, [1], {
      over: {
        probe: () => {
          throw new Error("the test Worker could not start");
        },
      },
    });
    expect(await isolateLanding(throws.input)).toMatchObject({ status: "inconclusive", probes: 1, reason: "Isolating a proposal stopped: a run failed: the test Worker could not start. The landing-level answer stands." });

    const unread = model(4, [1], { over: { read: async () => Promise.reject(new Error("the trunk writer is busy")) } });
    expect(await isolateLanding(unread.input)).toMatchObject({ status: "inconclusive", probes: 0, reason: "Isolating a proposal stopped: the trunk writer is busy. The landing-level answer stands." });

    // A parent that reads as nothing (the files no proposal wrote differ from the landing's) is never taken for one.
    const blank = model(4, [1]);
    const read = blank.input.read;
    blank.input.read = async (sha, paths) => (sha === PARENT ? paths.map((path) => ({ path, blob: null })) : read(sha, paths));
    expect(await isolateLanding(blank.input)).toMatchObject({ status: "inconclusive", probes: 0, reason: `Isolating a proposal stopped: the landing's parent commit ${PARENT.slice(0, 7)} could not be read. The landing-level answer stands.` });

    // The landing's witness read back as another blob: the landing was not read.
    const witnessed = model(4, [1], { over: { landing: { ...LANDING, witness: { path: "src/p0.ts", blob: "other" } } } });
    expect(await isolateLanding(witnessed.input)).toMatchObject({ status: "inconclusive", probes: 0, reason: `Isolating a proposal stopped: could not read the commit ${LANDING.trunkSha.slice(0, 7)}. The landing-level answer stands.` });
    // So is a parent that is a landing of the range whose witness reads back as another blob.
    const parent = model(4, [1], { over: { parent: { trunkSha: PARENT, witness: { path: "src/p0.ts", blob: "other" } } } });
    expect(await isolateLanding(parent.input)).toMatchObject({ status: "inconclusive", probes: 0, reason: `Isolating a proposal stopped: could not read the commit ${PARENT.slice(0, 7)}. The landing-level answer stands.` });
  });

  it("says no single proposal when the culprits only break the tests together, or each half breaks them on its own", async () => {
    // Both in one half: without either one the tests pass, so they break them together.
    const pair = await isolateLanding(model(4, [0, 1]).input);
    expect(pair).toMatchObject({ status: "interaction", together: ["p0", "p1"], probes: 4 });
    expect(pair.reason).toBe("Without any one of p0, p1 the failing tests pass: those proposals break them together, so no single proposal is the cause.");
    // One in each half: each half passes alone.
    expect(await isolateLanding(model(4, [1, 3]).input)).toMatchObject({ status: "interaction", halves: [["p0", "p1"], ["p2", "p3"]], probes: 2 });
    // Either one breaks them: each half fails alone.
    const both = await isolateLanding(model(4, [1, 3], { any: true }).input);
    expect(both).toMatchObject({ status: "none", probes: 2 });
    expect(both.reason).toBe("Each half of the 4 proposals that changed what the failing tests load fails them on its own (p0, p1; p2, p3): more than one proposal breaks them, so no single proposal is the cause.");
  });

  it("accepts a culprit only when every other test keeps its outcome, and runs nothing for a landing whose proposals changed nothing the tests load", async () => {
    // Without p1 the failing test passes, but the other one now fails: not the culprit.
    const shifted = await isolateLanding(model(2, [1], { other: (back) => (back.has("p1") ? "fail" : "pass") }).input);
    expect(shifted).toMatchObject({ status: "none" });
    expect(shifted.runs.at(-1)).toEqual({ kind: "without", proposals: ["p1"], outcome: "changed", detail: "the failing tests passed, but 1 other test changed its outcome or a file did not load" });

    const none = model(3, [1], { over: { closure: new Set([TEST]) } });
    expect(await isolateLanding(none.input)).toMatchObject({ status: "none", probes: 0, candidates: 0, reason: "None of its 3 proposals changed a file the failing tests load, so leaving one out changes nothing they run." });
    expect(none.calls).toHaveLength(0);
  });

  it("does not try the revert where work landed on the culprit's file since (ft revert would refuse it): not shown causal", async () => {
    const moved = model(2, [1]);
    const read = moved.input.read;
    moved.input.read = async (sha, paths) => (sha === RED.trunkSha ? paths.map((path) => ({ path, blob: `R:${path}` })) : read(sha, paths));
    const out = await isolateLanding(moved.input);
    expect(out).toMatchObject({ status: "isolated", culprit: { id: "p1" }, revert: { causal: false, reason: "not shown causal: src/p1.ts changed again after the landing, so reverting it alone was not tried (ft revert would refuse it).", trunkSha: RED.trunkSha } });
    expect(out.runs.some((r) => r.kind === "revert")).toBe(false);
  });
});

describe("judging one run", () => {
  const base = { [BREAKS]: "fail", [OTHER]: "pass", "test/b.test.ts\u0000kept": "skipped" };
  const keys = new Set([BREAKS]);
  it("without one proposal: green, red, changed, and a test missing only in a file the proposal wrote", () => {
    expect(judgeWithout(base, { [BREAKS]: "pass", [OTHER]: "pass", "test/b.test.ts\u0000kept": "skipped" }, keys, new Set()).outcome).toBe("green");
    expect(judgeWithout(base, { [BREAKS]: "pass,fail", [OTHER]: "pass", "test/b.test.ts\u0000kept": "skipped" }, keys, new Set()).outcome).toBe("red");
    expect(judgeWithout(base, { [BREAKS]: "pass", [OTHER]: "pass" }, keys, new Set()).outcome).toBe("changed");
    expect(judgeWithout(base, { [BREAKS]: "pass", [OTHER]: "pass" }, keys, new Set(["test/b.test.ts"])).outcome).toBe("green");
    expect(judgeWithout(base, { [BREAKS]: "pass", [OTHER]: "pass", "test/b.test.ts\u0000kept": "skipped", "test/b.test.ts\u0000test/b.test.ts": "load-error" }, keys, new Set()).outcome).toBe("changed");
    // The proposal added the failing test: without it the test is gone, which is fine in its own file only.
    expect(judgeWithout(base, { [OTHER]: "pass", "test/b.test.ts\u0000kept": "skipped" }, keys, new Set([TEST])).outcome).toBe("green");
    expect(judgeWithout(base, { [OTHER]: "pass", "test/b.test.ts\u0000kept": "skipped" }, keys, new Set()).outcome).toBe("changed");
    // A file that did not load now loads.
    const unloaded = { [`${TEST}\u0000${TEST}`]: "load-error" };
    expect(judgeWithout(unloaded, { [BREAKS]: "pass" }, new Set(Object.keys(unloaded)), new Set()).outcome).toBe("green");
  });

  it("the revert probe: green only when every test of the failing files passed", () => {
    expect(judgeRevert({ [BREAKS]: "pass", [OTHER]: "pass,skipped" }).outcome).toBe("green");
    expect(judgeRevert({ [BREAKS]: "pass", [OTHER]: "fail" })).toEqual({ outcome: "red", detail: "1 test of the failing files still fails with it reverted" });
    expect(judgeRevert({})).toEqual({ outcome: "changed", detail: "no test of the failing files ran with it reverted" });
  });
});

const isolated = (causal: boolean): FirstRedIsolation => ({
  status: "isolated",
  reason: "Proposal prp_bad is the one inside the landing.",
  culprit: { id: "prp_bad", intentId: "int_bad", title: "Speed up\nsubtraction", agentId: "agt_b", paths: ["src/math.ts"] },
  halves: [["prp_docs"], ["prp_bad"]],
  revert: causal ? { causal: true, reason: "causal: reverting it alone turns these tests green (on the red commit 2222222).", trunkSha: RED.trunkSha } : { causal: false, reason: "not shown causal: on the red commit 2222222, 1 test of the failing files still fails with it reverted.", trunkSha: RED.trunkSha },
  runs: [
    { kind: "half", proposals: ["prp_docs"], outcome: "pass" },
    { kind: "half", proposals: ["prp_bad"], outcome: "red" },
    { kind: "without", proposals: ["prp_bad"], outcome: "green" },
    { kind: "revert", proposals: ["prp_bad"], outcome: causal ? "green" : "red" },
  ],
  candidates: 2,
  probes: 4,
  ms: 300,
});

describe("where the isolation shows", () => {
  const found: FirstRed = {
    status: "found",
    trunkSha: LANDING.trunkSha,
    landingId: "lnd_9",
    intents: [{ id: "int_bad", title: "Speed up subtraction" }],
    proposals: [{ id: "prp_bad", intentId: "int_bad", title: "Speed up subtraction", paths: ["src/math.ts"] }],
    files: [TEST],
    probes: 3,
    ms: 400,
  };
  const why = "Trunk tests are red.\nBuilds on: int_bad\nModel: m";

  it("in the repair intent's why: fenced, with the revert suggested only when proven", () => {
    const proven = withFirstRed(why, { ...found, isolated: isolated(true) }, "f00d")!;
    expect(proven).toContain("(found in 3 test runs). Inside that landing, one proposal was isolated by running the failing tests without it, and reverting it alone turns them green (the isolated line below): start there");
    expect(proven).toContain(
      [
        "<<<FIRST RED f00d>>>",
        '- proposal prp_bad for intent int_bad "Speed up subtraction" changed src/math.ts',
        '- isolated: proposal prp_bad for intent int_bad "Speed up subtraction" by agent agt_b changed src/math.ts; the failing tests pass without it and every other test in their files keeps its outcome',
        "- causal: reverting it alone turns these tests green; a person can undo it alone with ft revert <colony> prp_bad (proven)",
        "- runs: half prp_docs: pass; half prp_bad: red; without prp_bad: green; revert prp_bad: green",
        "<<<END FIRST RED f00d>>>",
        "Builds on: int_bad",
      ].join("\n"),
    );
    const unproven = withFirstRed(why, { ...found, isolated: isolated(false) }, "f00d")!;
    expect(unproven).toContain("one proposal was isolated by running the failing tests without it (the isolated line below)");
    expect(unproven).toContain("\n- not shown causal: on the red commit 2222222, 1 test of the failing files still fails with it reverted.\n");
    expect(unproven).not.toContain("ft revert");
    // Replacing the landing-level block: one block, never two.
    const first = withFirstRed(why, found, "f00d")!;
    expect(withFirstRed(first, { ...found, isolated: isolated(true) }, "beef")!.match(/\n<<<FIRST RED /g)).toHaveLength(1);
    // No single proposal: the reason, and no revert.
    const lines = isolationLines({ ...isolated(true), status: "interaction", culprit: undefined, revert: undefined, reason: "Each half passed on its own." } as FirstRedIsolation);
    expect(lines[0]).toBe("- no single proposal inside it: Each half passed on its own.");
    expect(lines.join("\n")).not.toContain("ft revert");
    expect(isolationLines(undefined)).toEqual([]);
  });

  it("in the culprit labels: the isolated proposal's suspect, or a new one beside its landing's", () => {
    const s = (proposalId: string, landingId = "lnd_9"): Suspect => ({ landingId, proposalId, trunkSha: LANDING.trunkSha, paths: ["src/x.ts"], files: [TEST], at: 9, labels: ["first-since-green", "first-red"] });
    const marked = markIsolated([s("prp_late", "lnd_12"), s("prp_bad"), s("prp_docs")], "lnd_9", isolated(true));
    expect(marked.map((x) => [x.proposalId, x.labels])).toEqual([
      ["prp_late", ["first-since-green", "first-red"]],
      ["prp_bad", ["first-since-green", "first-red", "isolated"]],
      ["prp_docs", ["first-since-green", "first-red"]],
    ]);
    const added = markIsolated([s("prp_late", "lnd_12"), s("prp_docs")], "lnd_9", isolated(true));
    expect(added.map((x) => [x.proposalId, x.labels])).toEqual([
      ["prp_late", ["first-since-green", "first-red"]],
      ["prp_bad", ["first-red", "isolated"]],
      ["prp_docs", ["first-since-green", "first-red"]],
    ]);
    expect(added[1]).toMatchObject({ landingId: "lnd_9", intentId: "int_bad", paths: ["src/math.ts"], files: [TEST], at: 9 });
    expect(markIsolated([s("prp_docs")], "lnd_9", { ...isolated(true), status: "none", culprit: undefined })).toEqual([s("prp_docs")]);
    expect(markIsolated([s("prp_late", "lnd_12")], "lnd_9", isolated(true))).toEqual([s("prp_late", "lnd_12")]);
  });
});
