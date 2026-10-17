import { describe, expect, it } from "vitest";
import type { Certification, FirstRed } from "@fire_trident/core";
import { colors, formatCertify } from "../src/format.ts";

/** The first red search (FT_BISECT) in `ft certify`: the commit at which the failing tests first failed, under its red result. */
const plain = colors(false);
const HEAD = "a".repeat(40);
const GREEN = "b".repeat(40);
const counts = (pass: number, fail: number) => ({ tests: pass + fail, pass, fail, cancelled: 0, skipped: 0, todo: 0, suites: 0 });
const cert = (over: Partial<Certification>): Certification => ({ trunkSha: HEAD, status: "green", startedAt: 0, ...over });
const failing = [{ name: "subtracts", file: "test/math.test.ts" }];
const found: FirstRed = {
  status: "found",
  trunkSha: "c".repeat(40),
  landingId: "lnd_4",
  intents: [{ id: "int_4", title: "Speed up subtraction" }],
  proposals: [{ id: "prp_4", intentId: "int_4", title: "Speed up subtraction", paths: ["src/math.ts"] }],
  files: ["test/math.test.ts"],
  probes: 3,
  ms: 420,
  landings: 6,
  greenSha: GREEN,
};

function show(results: Certification[]): string[] {
  return formatCertify("web", "show", { on: true, greenSha: GREEN, results }, plain, 0).split("\n");
}

describe("the first failing commit in ft certify", () => {
  it("names the commit, its landing and intent and the likely cause under the red result, with the undo command, once for a run of results with the same answer", () => {
    expect(
      show([
        cert({ status: "red", counts: counts(1, 1), failing, durationMs: 120, firstRed: found }),
        cert({ trunkSha: "d".repeat(40), status: "red", counts: counts(1, 1), failing, durationMs: 90, firstRed: { ...found, reusedFrom: HEAD } }),
        cert({ trunkSha: GREEN, counts: counts(2, 0), durationMs: 80 }),
      ]),
    ).toEqual([
      "web trunk certification on",
      "green      bbbbbbb",
      '  aaaaaaa just now  ✗ 1 of 2 failing "subtracts"  (120 ms)',
      '    first red ccccccc (landing lnd_4, intent "Speed up subtraction"), found in 3 test runs; its change to src/math.ts is the likely cause.',
      "      undo: ft revert web prp_4",
      '  ddddddd just now  ✗ 1 of 2 failing "subtracts"  (90 ms)',
      "  bbbbbbb just now  ✓ 2/2 tests  (80 ms)",
    ]);
  });

  it("says why the search named no commit, and leaves out what it cannot read", () => {
    const inconclusive: FirstRed = { status: "inconclusive", reason: "The failing tests passed when run alone on the red commit aaaaaaa: they may be flaky or depend on other test files.", probes: 1, ms: 90 };
    expect(show([cert({ status: "red", counts: counts(1, 1), failing, firstRed: inconclusive })]).at(-1)).toBe(
      "    first red not found: The failing tests passed when run alone on the red commit aaaaaaa: they may be flaky or depend on other test files.",
    );
    expect(show([cert({ status: "red", counts: counts(1, 1), failing, firstRed: { ...found, proposals: [], intents: [] } })]).at(-1)).toBe(
      "    first red ccccccc (landing lnd_4, a commit FireTrident made itself), found in 3 test runs; none of its proposals changed a file the failing tests load.",
    );
    expect(show([cert({ status: "red", counts: counts(1, 1), failing, firstRed: { status: "odd" } as never })])).toHaveLength(3);
  });
});

describe("the bisect event in ft watch", () => {
  it("says the search ended, with its answer", async () => {
    const { formatEvent } = await import("../src/format.ts");
    expect(formatEvent({ t: "bisect", at: 0, trunkSha: HEAD, firstRed: found }, plain, () => "12:00:00")).toBe(
      '12:00:00 bisect     aaaaaaa first red ccccccc (landing lnd_4, intent "Speed up subtraction"), found in 3 test runs; its change to src/math.ts is the likely cause.',
    );
  });
});

describe("the proposal isolated inside the first failing commit in ft certify", () => {
  const isolated = (causal: boolean): FirstRed["isolated"] => ({
    status: "isolated",
    reason: "Proposal prp_4 is the one inside the landing.",
    culprit: { id: "prp_4", intentId: "int_4", title: "Speed up subtraction", agentId: "agt_b", paths: ["src/math.ts"] },
    revert: causal
      ? { causal: true, reason: "causal: reverting it alone turns these tests green (on the red commit aaaaaaa).", trunkSha: HEAD }
      : { causal: false, reason: "not shown causal: on the red commit aaaaaaa, 1 test of the failing files still fails with it reverted.", trunkSha: HEAD },
    runs: [],
    candidates: 2,
    probes: 4,
    ms: 300,
  });
  const lines = (f: FirstRed): string[] => show([cert({ status: "red", counts: counts(1, 1), failing, durationMs: 120, firstRed: f })]).slice(3);

  it("names the isolated proposal with its intent and agent, and marks its undo proven only when reverting it alone turned the tests green", () => {
    expect(lines({ ...found, isolated: isolated(true) })).toEqual([
      '    first red ccccccc (landing lnd_4, intent "Speed up subtraction"), found in 3 test runs; its change to src/math.ts is the likely cause. Isolated prp_4 (proven).',
      '      inside: prp_4 (intent "Speed up subtraction", agent agt_b): the failing tests pass without it, in 4 more test runs; causal: reverting it alone turns these tests green (on the red commit aaaaaaa).',
      "      undo (proven): ft revert web prp_4",
    ]);
    expect(lines({ ...found, isolated: isolated(false) })).toEqual([
      '    first red ccccccc (landing lnd_4, intent "Speed up subtraction"), found in 3 test runs; its change to src/math.ts is the likely cause. Isolated prp_4 (not shown causal).',
      '      inside: prp_4 (intent "Speed up subtraction", agent agt_b): the failing tests pass without it, in 4 more test runs; not shown causal: on the red commit aaaaaaa, 1 test of the failing files still fails with it reverted.',
      "      undo (not proven): ft revert web prp_4",
    ]);
  });

  it("says when no single proposal was isolated, with the reason, and marks no undo proven", () => {
    const none: FirstRed["isolated"] = { status: "interaction", reason: "Each half passed on its own: they break the tests only together.", runs: [], candidates: 2, probes: 2, ms: 90 };
    expect(lines({ ...found, isolated: none })).toEqual([
      '    first red ccccccc (landing lnd_4, intent "Speed up subtraction"), found in 3 test runs; its change to src/math.ts is the likely cause. No single proposal inside it.',
      "      inside: Each half passed on its own: they break the tests only together.",
      "      undo (not proven): ft revert web prp_4",
    ]);
  });

  it("puts the isolation in the bisect event's line in ft watch", async () => {
    const { formatEvent } = await import("../src/format.ts");
    expect(formatEvent({ t: "bisect", at: 0, trunkSha: HEAD, firstRed: { ...found, isolated: isolated(true) } }, plain, () => "12:00:00")).toBe(
      '12:00:00 bisect     aaaaaaa first red ccccccc (landing lnd_4, intent "Speed up subtraction"), found in 3 test runs; its change to src/math.ts is the likely cause. Isolated prp_4 (proven).',
    );
  });
});
