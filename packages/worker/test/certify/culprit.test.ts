import { describe, expect, it } from "vitest";
import type { Path, Sha } from "@fire_trident/core";
import { compile, type Compiled } from "../../src/certify/compile.ts";
import {
  GREEN_SLACK_MS,
  SUSPECT_FILES,
  afterGreen,
  changedSince,
  culpritsEnabled,
  findSuspects,
  mergeSuspects,
  reachOf,
  type GreenCommit,
  type LandedOn,
  type SuspectSearch,
} from "../../src/certify/culprit.ts";

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
  const calls = { blobsAt: [] as Array<{ sha: Sha; paths: Path[] }>, landedOn: [] as Path[][] };
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
      { landingId: "lnd_2", trunkSha: RED, proposalId: "prp_2", intentId: "int_2", title: "intent of lnd_2", why: "why of lnd_2", at: 200, paths: ["src/b.ts", "src/util.ts"], files: ["test/a.test.ts", "test/b.test.ts"] },
      { landingId: "lnd_1", proposalId: "prp_1", title: "intent of lnd_1", why: "why of lnd_1", at: 100, paths: ["src/a.ts"], files: ["test/a.test.ts"] },
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
    expect(found).toEqual([{ landingId: "lnd_2", proposalId: "prp_2", intentId: "int_2", title: "intent of lnd_2", why: "why of lnd_2", at: 200, paths: ["src/util.ts"], files: ["test/math.test.ts"] }]);
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
    expect(await findSuspects(s)).toEqual([{ landingId: "lnd_1", at: 1, title: "intent of lnd_1", why: "why of lnd_1", paths: ["src/math.ts", "test/math.test.ts"], files: ["test/math.test.ts"] }]);
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
