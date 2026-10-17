import { describe, expect, it } from "vitest";
import type { Path, Sha } from "@fire_trident/core";
import { compile, type Compiled } from "../../src/certify/compile.ts";
import {
  GREEN_SLACK_MS,
  SUSPECT_FILES,
  afterGreen,
  capSuspects,
  changedSince,
  culpritsEnabled,
  findSuspects,
  firstAfterGreen,
  markFirstRed,
  mergeSuspects,
  publicSuspect,
  reachOf,
  sinceGreen,
  type GreenCommit,
  type LandedOn,
  type SinceGreen,
  type SuspectSearch,
} from "../../src/certify/culprit.ts";
import { repairIntent } from "../../src/certify/repair.ts";

/** Culprit finding's pure parts: what a failing test file loads, what changed since green, which landings count. */

const modulesOf = (files: Record<Path, string>): Map<Path, Compiled> => new Map(Object.entries(files).map(([path, text]) => [path, compile(path, text)]));

const TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';
const MATH = 'import { minus } from "./util.ts";\nexport const sub = (a: number, b: number): number => minus(a, b);\n';
const UTIL = "export const minus = (a: number, b: number): number => a - b;\n";
const GREEN = "a".repeat(40);
const RED = "b".repeat(40);

/** A landing as the colony's index answers it. */
function landed(id: string, at: number, paths: Path[], extra: Partial<LandedOn> = {}): LandedOn {
  return { landingId: id, at, title: `intent of ${id}`, why: `why of ${id}`, paths, ...extra };
}

/** A search over one red commit (`red` blobs) and one green commit (`green` blobs), recording the lookups. */
function search(over: Partial<SuspectSearch> & { redBlobs: Record<Path, Sha>; greenBlobs?: Record<Path, Sha> | null; found?: LandedOn[] }) {
  const calls = { blobsAt: [] as Array<{ sha: Sha; paths: Path[] }>, landedOn: [] as Path[][], landedSince: [] as Array<{ paths: Path[]; since: SinceGreen }> };
  const greenBlobs = over.greenBlobs === undefined ? {} : over.greenBlobs;
  const s: SuspectSearch = {
    files: ["test/math.test.ts"],
    modules: modulesOf({ "test/math.test.ts": TEST, "src/math.ts": MATH, "src/util.ts": UTIL }),
    red: (p) => over.redBlobs[p] ?? null,
    green: greenBlobs === null ? null : { sha: GREEN, landing: null, startedAt: null },
    blobsAt: async (sha, paths) => {
      calls.blobsAt.push({ sha, paths });
      return paths.map((path) => ({ path, blob: greenBlobs?.[path] ?? null }));
    },
    // As the colony's index answers: the newest three landings that changed any of the paths, with the ones they changed.
    landedOn: async (paths) => {
      calls.landedOn.push(paths);
      return (over.found ?? [])
        .filter((l) => l.paths.some((p) => paths.includes(p)))
        .map((l) => ({ ...l, paths: l.paths.filter((p) => paths.includes(p)) }))
        .slice(0, 3);
    },
    ...over,
  };
  return { s, calls };
}

describe("culprit finding: what a failing test file loads", () => {
  it("is the file, then its relative imports nearest first, with a file an import names that is not there", () => {
    const modules = modulesOf({ "test/math.test.ts": TEST, "src/math.ts": `${MATH}import { gone } from "./gone.ts";\n`, "src/util.ts": UTIL });
    expect(reachOf("test/math.test.ts", modules)).toEqual(["test/math.test.ts", "src/math.ts", "src/util.ts", "src/gone.ts"]);
    expect(reachOf("test/math.test.ts", modules, 2)).toEqual(["test/math.test.ts", "src/math.ts"]);
    // A file the run did not read (deleted, or never loaded) is only itself.
    expect(reachOf("test/deleted.test.ts", modules)).toEqual(["test/deleted.test.ts"]);
    expect(reachOf("test/x.test.ts", null)).toEqual(["test/x.test.ts"]);
  });

  it("keeps the paths whose blob differs from the green commit's, and only paths looked up there", () => {
    const red = (p: Path): Sha | null => ({ a: "1", b: "2", c: "3" })[p] ?? null;
    expect(changedSince(["a", "b", "c", "d"], red, new Map([["a", "1"], ["b", "9"], ["d", "4"]]))).toEqual(["b", "d"]);
  });

  it("is on per colony like the other flags", () => {
    expect(culpritsEnabled(undefined, "web")).toBe(false);
    expect(culpritsEnabled("off", "web")).toBe(false);
    expect(culpritsEnabled("on", "web")).toBe(true);
    expect(culpritsEnabled("api, web", "web")).toBe(true);
    expect(culpritsEnabled("api", "web")).toBe(false);
  });
});

describe("culprit finding: which landings came after the green commit", () => {
  const blobs = new Map<Path, Sha | null>([["src/util.ts", "u-green"]]);
  const l3 = landed("lnd_3", 300, ["src/util.ts"], { proposalId: "prp_3", wrote: { "src/util.ts": "u-3" } });
  const l2 = landed("lnd_2", 200, ["src/util.ts"], { proposalId: "prp_2", wrote: { "src/util.ts": "u-green" } });
  const l1 = landed("lnd_1", 100, ["src/util.ts"], { proposalId: "prp_1", wrote: { "src/util.ts": "u-1" } });
  const unknown: GreenCommit = { sha: GREEN, landing: null, startedAt: null };

  it("leaves out the landing that wrote the green version of a path, and every older one on that path", () => {
    expect(afterGreen([l3, l2, l1], unknown, blobs).map((l) => l.landingId)).toEqual(["lnd_3"]);
  });

  it("leaves out the green commit's own landing and older ones, when the colony has it", () => {
    const noBlobs = [l3, landed("lnd_2", 200, ["src/util.ts"]), landed("lnd_1", 100, ["src/util.ts"])];
    expect(afterGreen(noBlobs, { ...unknown, landing: { landingId: "lnd_2", at: 200 } }, new Map()).map((l) => l.landingId)).toEqual(["lnd_3"]);
  });

  it("without the green landing, leaves out landings older than the green run by more than the slack", () => {
    const start = 1_000_000;
    const old = landed("lnd_old", start - GREEN_SLACK_MS - 1, ["src/util.ts"]);
    // Timed before its push, so it can look a little older than the run that saw the commit before it.
    const late = landed("lnd_late", start - 5_000, ["src/util.ts"]);
    expect(afterGreen([late, old], { ...unknown, startedAt: start }, new Map()).map((l) => l.landingId)).toEqual(["lnd_late"]);
  });

  it("keeps a landing when one of its paths changed after green, even if another one holds the green version", () => {
    const both = landed("lnd_4", 400, ["src/math.ts", "src/util.ts"], { proposalId: "prp_4", wrote: { "src/math.ts": "m-4", "src/util.ts": "u-green" } });
    const twoBlobs = new Map<Path, Sha | null>([...blobs, ["src/math.ts", "m-green"]]);
    expect(afterGreen([both], unknown, twoBlobs).map((l) => l.landingId)).toEqual(["lnd_4"]);
    expect(afterGreen([{ ...both, wrote: { "src/math.ts": "m-green", "src/util.ts": "u-green" } }], unknown, twoBlobs)).toEqual([]);
  });
});

describe("culprit finding: one result's suspects", () => {
  it("merges the landings of every failing file: one entry per proposal, the files it is a suspect for, newest first", () => {
    const shared = landed("lnd_2", 200, ["src/util.ts"], { proposalId: "prp_2", intentId: "int_2", trunkSha: RED });
    const merged = mergeSuspects([
      { file: "test/a.test.ts", found: [shared, landed("lnd_1", 100, ["src/a.ts"], { proposalId: "prp_1" })] },
      { file: "test/b.test.ts", found: [{ ...shared, paths: ["src/b.ts", "src/util.ts"] }] },
    ]);
    expect(merged).toEqual([
      { landingId: "lnd_2", trunkSha: RED, proposalId: "prp_2", intentId: "int_2", title: "intent of lnd_2", why: "why of lnd_2", at: 200, paths: ["src/b.ts", "src/util.ts"], files: ["test/a.test.ts", "test/b.test.ts"], labels: ["latest"] },
      { landingId: "lnd_1", proposalId: "prp_1", title: "intent of lnd_1", why: "why of lnd_1", at: 100, paths: ["src/a.ts"], files: ["test/a.test.ts"], labels: ["latest"] },
    ]);
    // At most three per failing file, and at most `max` in all.
    const many = [4, 3, 2, 1].map((n) => landed(`lnd_${n}`, n, ["src/a.ts"]));
    expect(mergeSuspects([{ file: "test/a.test.ts", found: many }]).map((s) => s.landingId)).toEqual(["lnd_4", "lnd_3", "lnd_2"]);
    expect(mergeSuspects([{ file: "test/a.test.ts", found: many }], 2)).toHaveLength(2);
  });

  it("names the landings since green that changed a file in the failing file's closure", async () => {
    const after = landed("lnd_2", 200, ["src/util.ts"], { proposalId: "prp_2", intentId: "int_2", wrote: { "src/util.ts": "u-red" } });
    const before = landed("lnd_1", 100, ["src/util.ts"], { proposalId: "prp_1", intentId: "int_1", wrote: { "src/util.ts": "u-green" } });
    const { s, calls } = search({
      redBlobs: { "test/math.test.ts": "t", "src/math.ts": "m", "src/util.ts": "u-red" },
      greenBlobs: { "test/math.test.ts": "t", "src/math.ts": "m", "src/util.ts": "u-green" },
      found: [after, before],
    });
    const found = await findSuspects(s);
    expect(found).toEqual([{ landingId: "lnd_2", proposalId: "prp_2", intentId: "int_2", title: "intent of lnd_2", why: "why of lnd_2", at: 200, paths: ["src/util.ts"], files: ["test/math.test.ts"], labels: ["latest"] }]);
    // One read of the green commit (the failing file first), one index lookup with only what changed.
    expect(calls.blobsAt).toEqual([{ sha: GREEN, paths: ["test/math.test.ts", "src/math.ts", "src/util.ts"] }]);
    expect(calls.landedOn).toEqual([["src/util.ts"]]);
  });

  it("for a test file new since green, names the landings that added or last changed it and what it loads", async () => {
    const added = landed("lnd_5", 500, ["test/math.test.ts"], { proposalId: "prp_5" });
    const old = landed("lnd_0", 10, ["src/util.ts"], { proposalId: "prp_0", wrote: { "src/util.ts": "u" } });
    const { s, calls } = search({ redBlobs: { "test/math.test.ts": "t", "src/math.ts": "m", "src/util.ts": "u" }, greenBlobs: { "src/math.ts": "m", "src/util.ts": "u" }, found: [added, old] });
    expect((await findSuspects(s)).map((x) => x.proposalId)).toEqual(["prp_5", "prp_0"]);
    // The file itself, then what it loads.
    expect(calls.landedOn).toEqual([["test/math.test.ts"], ["src/math.ts", "src/util.ts"]]);
  });

  it("keeps a place for the failing file's own change when newer landings changed what it loads", async () => {
    const added = landed("lnd_1", 100, ["test/math.test.ts"], { proposalId: "prp_1" });
    const churn = [4, 3, 2].map((n) => landed(`lnd_${n}`, n * 100, ["src/util.ts"], { proposalId: `prp_${n}` }));
    const { s } = search({ redBlobs: { "test/math.test.ts": "t", "src/math.ts": "m", "src/util.ts": "u" }, greenBlobs: null, found: [...churn, added] });
    expect((await findSuspects(s)).map((x) => x.proposalId)).toEqual(["prp_4", "prp_3", "prp_1"]);
  });

  it("before the first green run, asks for everything the failing file loads and reads no green commit", async () => {
    const { s, calls } = search({ redBlobs: { "test/math.test.ts": "t" }, greenBlobs: null, found: [landed("lnd_1", 1, ["test/math.test.ts", "src/math.ts"])] });
    // One landing that wrote the test and the code is one suspect, with both files.
    expect(await findSuspects(s)).toEqual([{ landingId: "lnd_1", at: 1, title: "intent of lnd_1", why: "why of lnd_1", paths: ["src/math.ts", "test/math.test.ts"], files: ["test/math.test.ts"], labels: ["latest"] }]);
    expect(calls.blobsAt).toEqual([]);
    expect(calls.landedOn).toEqual([["test/math.test.ts"], ["src/math.ts", "src/util.ts"]]);
  });

  it("names none when nothing the failing file loads changed since green, without asking the index", async () => {
    const same = { "test/math.test.ts": "t", "src/math.ts": "m", "src/util.ts": "u" };
    const { s, calls } = search({ redBlobs: same, greenBlobs: same, found: [landed("lnd_1", 1, ["src/util.ts"])] });
    expect(await findSuspects(s)).toEqual([]);
    expect(calls.landedOn).toEqual([]);
  });

  it("follows an import of a file deleted since green, and a deleted test file, to the landing that deleted it", async () => {
    const modules = modulesOf({ "test/math.test.ts": TEST, "src/math.ts": 'export { minus as sub } from "./util.ts";\n' });
    const deleted = landed("lnd_3", 300, ["src/util.ts"], { proposalId: "prp_3", wrote: { "src/util.ts": null } });
    const { s, calls } = search({
      modules,
      redBlobs: { "test/math.test.ts": "t", "src/math.ts": "m" },
      greenBlobs: { "test/math.test.ts": "t", "src/math.ts": "m", "src/util.ts": "u" },
      found: [deleted],
    });
    expect((await findSuspects(s)).map((x) => x.proposalId)).toEqual(["prp_3"]);
    expect(calls.landedOn).toEqual([["src/util.ts"]]);
    const gone = search({ files: ["test/gone.test.ts"], modules: null, redBlobs: {}, greenBlobs: { "test/gone.test.ts": "g" }, found: [landed("lnd_4", 400, ["test/gone.test.ts"], { proposalId: "prp_4", wrote: { "test/gone.test.ts": null } })] });
    expect((await findSuspects(gone.s)).map((x) => x.proposalId)).toEqual(["prp_4"]);
    expect(gone.calls.landedOn).toEqual([["test/gone.test.ts"]]);
  });

  it("looks at a bounded number of failing files", async () => {
    const files = Array.from({ length: SUSPECT_FILES + 5 }, (_, i) => `test/t${String(i).padStart(2, "0")}.test.ts`);
    const { s, calls } = search({ files, modules: null, redBlobs: {}, greenBlobs: null });
    await findSuspects(s);
    expect(calls.landedOn).toHaveLength(SUSPECT_FILES);
  });
});

describe("culprit finding: the first landing since green", () => {
  const green: GreenCommit = { sha: GREEN, landing: { landingId: "lnd_0", at: 50 }, startedAt: null };
  /** Landings 1..n since green, each changing src/util.ts, newest first. */
  const churn = (n: number): LandedOn[] =>
    Array.from({ length: n }, (_, i) => n - i).map((k) => landed(`lnd_${k}`, k * 100, ["src/util.ts"], { proposalId: `prp_${k}`, intentId: `int_${k}`, wrote: { "src/util.ts": `u-${k}` } }));
  const labelsOf = (list: ReadonlyArray<{ landingId: string; labels?: string[] }>) => list.map((s) => [s.landingId, s.labels]);
  /** The landing log as the colony answers it: the oldest landings at or after `since` that changed any of the paths, oldest first. */
  const log =
    (all: LandedOn[]) =>
    async (paths: Path[], since: SinceGreen): Promise<LandedOn[]> =>
      all
        .filter((l) => l.at >= since.at && l.paths.some((p) => paths.includes(p)))
        .sort((a, b) => a.at - b.at)
        .slice(0, 4);

  it("keeps the first landing since green beside the newest two of five that touched one failing file, each labeled", () => {
    const [l5, l4, l3, , l1] = churn(5);
    // The index holds only the newest three; the first since green comes from the log.
    expect(labelsOf(mergeSuspects([{ file: "test/math.test.ts", found: [l5!, l4!, l3!], first: l1! }]))).toEqual([
      ["lnd_5", ["latest"]],
      ["lnd_4", ["latest"]],
      ["lnd_1", ["first-since-green"]],
    ]);
  });

  it("labels the only landing since green as both, and the older of two as both", () => {
    const [l1] = churn(1);
    expect(labelsOf(mergeSuspects([{ file: "test/math.test.ts", found: [l1!], first: l1! }]))).toEqual([["lnd_1", ["first-since-green", "latest"]]]);
    const [m2, m1] = churn(2);
    expect(labelsOf(mergeSuspects([{ file: "test/math.test.ts", found: [m2!, m1!], first: m1! }]))).toEqual([
      ["lnd_2", ["latest"]],
      ["lnd_1", ["first-since-green", "latest"]],
    ]);
  });

  it("keeps the failing file's own change among the newest two when the first since green takes a place", () => {
    const [l5, l4, , , l1] = churn(5);
    const own = landed("lnd_3", 300, ["test/math.test.ts"], { proposalId: "prp_3" });
    expect(labelsOf(mergeSuspects([{ file: "test/math.test.ts", found: [l5!, l4!, own], first: l1! }]))).toEqual([
      ["lnd_5", ["latest"]],
      ["lnd_3", ["latest"]],
      ["lnd_1", ["first-since-green"]],
    ]);
  });

  it("never lets the result's cap drop a first landing since green", () => {
    const [l9, l8, l7] = [9, 8, 7].map((k) => landed(`lnd_${k}`, k * 100, ["src/util.ts"], { proposalId: `prp_${k}` }));
    const l1 = landed("lnd_1", 100, ["src/a.ts"], { proposalId: "prp_1" });
    const l2 = landed("lnd_2", 200, ["src/b.ts"], { proposalId: "prp_2" });
    const merged = mergeSuspects(
      [
        { file: "test/a.test.ts", found: [l9!, l8!, l7!], first: l1 },
        { file: "test/b.test.ts", found: [l9!, l8!, l7!], first: l2 },
      ],
      3,
    );
    expect(labelsOf(merged)).toEqual([
      ["lnd_9", ["latest"]],
      ["lnd_2", ["first-since-green"]],
      ["lnd_1", ["first-since-green"]],
    ]);
  });

  it("finds it in the landing log when the index holds only the newest three (end to end)", async () => {
    const all = churn(5);
    const { s, calls } = search({
      green,
      redBlobs: { "test/math.test.ts": "t", "src/math.ts": "m", "src/util.ts": "u-5" },
      greenBlobs: { "test/math.test.ts": "t", "src/math.ts": "m", "src/util.ts": "u-green" },
      found: all,
    });
    s.landedSince = async (paths, since) => {
      calls.landedSince.push({ paths, since });
      return log(all)(paths, since);
    };
    const found = await findSuspects(s);
    expect(labelsOf(found)).toEqual([
      ["lnd_5", ["latest"]],
      ["lnd_4", ["latest"]],
      ["lnd_1", ["first-since-green"]],
    ]);
    expect(found[2]).toMatchObject({ proposalId: "prp_1", intentId: "int_1", why: "why of lnd_1", paths: ["src/util.ts"], files: ["test/math.test.ts"] });
    // One log lookup with what changed under the failing file, from the green commit's landing.
    expect(calls.landedSince).toEqual([{ paths: ["src/util.ts"], since: { at: 50, landingId: "lnd_0" } }]);
    // The result keeps the label without the why.
    expect(publicSuspect(found[2]!)).toEqual({ landingId: "lnd_1", proposalId: "prp_1", intentId: "int_1", title: "intent of lnd_1", at: 100, paths: ["src/util.ts"], files: ["test/math.test.ts"], labels: ["first-since-green"] });
  });

  it("names a single landing since green once, as both", async () => {
    const all = churn(1);
    const { s } = search({ green, redBlobs: { "test/math.test.ts": "t", "src/util.ts": "u-1" }, greenBlobs: { "test/math.test.ts": "t", "src/util.ts": "u-green" }, found: all, landedSince: log(all) });
    expect(labelsOf(await findSuspects(s))).toEqual([["lnd_1", ["first-since-green", "latest"]]]);
  });

  it("skips a log landing that wrote the green version, or one a newer landing wrote the green version back over", () => {
    const blobs = new Map<Path, Sha | null>([["src/util.ts", "u-green"]]);
    const wroteGreen = landed("lnd_g", 60, ["src/util.ts"], { proposalId: "prp_g", wrote: { "src/util.ts": "u-green" } });
    const l2 = landed("lnd_2", 200, ["src/util.ts"], { proposalId: "prp_2", wrote: { "src/util.ts": "u-2" } });
    const l4 = landed("lnd_4", 400, ["src/util.ts"], { proposalId: "prp_4", wrote: { "src/util.ts": "u-4" } });
    expect(firstAfterGreen([wroteGreen, l2, l4], [], green, blobs)?.landingId).toBe("lnd_2");
    // A newer landing put the green version back after lnd_2: what changed since came later.
    const back = landed("lnd_3", 300, ["src/util.ts"], { proposalId: "prp_3", wrote: { "src/util.ts": "u-green" } });
    expect(firstAfterGreen([l2, l4], [back], green, blobs)?.landingId).toBe("lnd_4");
    expect(firstAfterGreen([], [l4], green, blobs)).toBeNull();
  });

  it("goes without one when the log lookup fails, keeping the newest three as before", async () => {
    const { s } = search({ green, redBlobs: { "src/util.ts": "u-5", "test/math.test.ts": "t" }, greenBlobs: { "src/util.ts": "u-green", "test/math.test.ts": "t" }, found: churn(5) });
    s.landedSince = async () => {
      throw new Error("the landing log is unavailable");
    };
    expect(labelsOf(await findSuspects(s))).toEqual([
      ["lnd_5", ["latest"]],
      ["lnd_4", ["latest"]],
      ["lnd_3", ["latest"]],
    ]);
  });

  it("does not look for a test file new since green, before the first green run, or when nothing dates the green commit", async () => {
    let asked = 0;
    const landedSince = async (): Promise<LandedOn[]> => {
      asked++;
      return [];
    };
    const fresh = search({ green, redBlobs: { "test/math.test.ts": "t", "src/util.ts": "u" }, greenBlobs: { "src/util.ts": "u" }, found: [landed("lnd_5", 500, ["test/math.test.ts"])], landedSince });
    await findSuspects(fresh.s);
    const never = search({ redBlobs: { "test/math.test.ts": "t" }, greenBlobs: null, found: [landed("lnd_1", 1, ["test/math.test.ts"])], landedSince });
    await findSuspects(never.s);
    const undated: GreenCommit = { sha: GREEN, landing: null, startedAt: null };
    expect(sinceGreen(undated)).toBeNull();
    expect(sinceGreen({ ...undated, startedAt: 1_000_000 })).toEqual({ at: 1_000_000 - GREEN_SLACK_MS, landingId: null });
    const blind = search({ green: undated, redBlobs: { "test/math.test.ts": "t", "src/util.ts": "u-1" }, greenBlobs: { "test/math.test.ts": "t", "src/util.ts": "u-green" }, found: churn(1), landedSince });
    expect(labelsOf(await findSuspects(blind.s))).toEqual([["lnd_1", ["latest"]]]);
    expect(asked).toBe(0);
  });
});

describe("culprit finding: suspects where they are shown", () => {
  const suspect = (n: number, labels?: Array<"first-since-green" | "latest" | "first-red">) => ({
    landingId: `lnd_${n}`,
    proposalId: `prp_${n}`,
    paths: [`src/${n}.ts`],
    files: ["test/math.test.ts"],
    at: n,
    ...(labels ? { labels } : {}),
  });

  it("cuts suspects without labels newest first, as before, and keeps first red then first since green before newer ones", () => {
    const old = [5, 4, 3, 2, 1].map((n) => suspect(n));
    expect(capSuspects(old, 3).map((s) => s.landingId)).toEqual(["lnd_5", "lnd_4", "lnd_3"]);
    const labeled = [suspect(5, ["latest"]), suspect(4, ["latest"]), suspect(3, ["first-red"]), suspect(1, ["first-since-green"])];
    expect(capSuspects(labeled, 2).map((s) => s.landingId)).toEqual(["lnd_3", "lnd_1"]);
    expect(capSuspects(labeled, 3).map((s) => s.landingId)).toEqual(["lnd_5", "lnd_3", "lnd_1"]);
    expect(capSuspects(labeled, 10)).toHaveLength(4);
  });

  it("marks the first red landing's suspect once, old suspects without labels included", () => {
    const marked = markFirstRed([suspect(5, ["latest"]), suspect(1), suspect(2, ["first-since-green", "first-red"])], "lnd_1");
    expect(marked.map((s) => [s.landingId, s.labels])).toEqual([
      ["lnd_5", ["latest"]],
      ["lnd_1", ["first-red"]],
      ["lnd_2", ["first-since-green", "first-red"]],
    ]);
    expect(markFirstRed([suspect(2, ["first-red"])], "lnd_2")[0]!.labels).toEqual(["first-red"]);
  });

  it("tags labels in the repair intent and leads its footprint with the first since green; old suspects read as before", () => {
    const cert = { trunkSha: RED, status: "red" as const, startedAt: 0, greenSha: GREEN, failing: [{ name: "subtracts", file: "test/math.test.ts" }] };
    const isTest = (p: string): boolean => p.endsWith(".test.ts");
    const intent = repairIntent({
      cert,
      reach: (f) => [f],
      isTest,
      suspects: [suspect(5, ["latest"]), suspect(4, ["latest"]), suspect(3, ["latest"]), suspect(2, ["latest"]), suspect(1, ["first-since-green"])],
      nonce: "n0nce",
    });
    expect(intent.footprint.slice(0, 3)).toEqual(["src/1.ts", "src/5.ts", "src/4.ts"]);
    const lines = intent.why.split("\n");
    const open = lines.indexOf("<<<SUSPECTS n0nce>>>");
    expect(lines[open - 1]).toContain("A suspect marked first since green is the oldest landing since then that changed what its failing test file loads");
    expect(lines[open + 1]).toBe("- [latest] proposal prp_5 (landing lnd_5) changed src/5.ts; a suspect for test/math.test.ts.");
    expect(lines[open + 5]).toBe("- [first since green] proposal prp_1 (landing lnd_1) changed src/1.ts; a suspect for test/math.test.ts.");
    // Old suspects, recorded without labels: no tag, no sentence about the first since green.
    const old = repairIntent({ cert, reach: (f) => [f], isTest, suspects: [suspect(2), suspect(1)], nonce: "n0nce" });
    expect(old.why).toContain("\n- proposal prp_2 (landing lnd_2) changed src/2.ts; a suspect for test/math.test.ts.\n");
    expect(old.why).not.toContain("first since green");
    expect(old.footprint.slice(0, 2)).toEqual(["src/2.ts", "src/1.ts"]);
  });

  it("keeps the first since green in the repair intent's list when there are more suspects than it lists", () => {
    const cert = { trunkSha: RED, status: "red" as const, startedAt: 0, greenSha: GREEN, failing: [{ name: "subtracts", file: "test/math.test.ts" }] };
    const many = [...[9, 8, 7, 6, 5, 4, 3, 2].map((n) => suspect(n, ["latest"])), suspect(1, ["first-since-green"])];
    const why = repairIntent({ cert, reach: (f) => [f], isTest: (p) => p.endsWith(".test.ts"), suspects: many, nonce: "n0nce" }).why;
    expect(why).toContain("- [first since green] proposal prp_1");
    expect(why).not.toContain("proposal prp_4 ");
    expect(why).toContain("- and 3 more");
  });
});
