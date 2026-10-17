import { describe, expect, it } from "vitest";
import type { LandingTests, WhyHolds, WhyWalk } from "../src/index.ts";
import { coverText, entryPath, holdsText, holdsTrunk, walkLines, walkOwnsFirst } from "../src/index.ts";

/** The words of a why answer about today: whether each landing still holds, and how the walk for a line went. */

const SHA = "abc1234def".padEnd(40, "0");
const same: WhyHolds = { wrote: { path: "src/a.ts", state: "same" }, others: { files: 2, changed: 0, list: [] } };
const reach = (earlier: string[], own: string[] = []): Pick<LandingTests, "status" | "reach"> => ({
  status: "certified",
  reach: { earlier: earlier.length, own: own.length, later: 0, earlierFiles: earlier, ownFiles: own, checked: 10 },
});

describe("holds", () => {
  it("says a landing still holds as written, or what changed since and by which landing", () => {
    expect(holdsTrunk(same)).toBe("src/a.ts as it wrote it · the 2 other files it wrote or read unchanged");
    const changed: WhyHolds = {
      wrote: { path: "src/a.ts", state: "changed", by: "lnd_9", landings: 3 },
      others: { files: 4, changed: 3, list: [{ path: "src/b.ts", state: "changed", by: "lnd_7" }, { path: "src/c.ts", state: "deleted", by: "lnd_8" }, { path: "src/d.ts", state: "changed" }] },
    };
    expect(holdsTrunk(changed)).toBe("src/a.ts changed since by lnd_9 and 2 more · 3 of 4 other files it wrote or read changed since: src/b.ts changed by lnd_7, src/c.ts deleted by lnd_8 and 1 more");
    expect(holdsTrunk({ wrote: { path: "src/a.ts", state: "deleted", by: "lnd_5", landings: 1 }, others: { files: 0, changed: 0, list: [] } })).toBe("src/a.ts deleted since by lnd_5");
    expect(holdsTrunk({ wrote: { path: "src/a.ts", state: "changed" }, others: { files: 1, changed: 0, list: [] } })).toBe("src/a.ts changed since, not by a later landing · the other file it wrote or read unchanged");
    expect(holdsTrunk(undefined)).toBeNull();
  });

  it("gives the current certification of the tests that cover it from the closure data", () => {
    expect(coverText(reach(["test/a.test.ts", "test/b.test.ts"]), { trunkSha: SHA, status: "green" })).toBe("covered by 2 test files, green at abc1234");
    const red = { trunkSha: SHA, status: "red" as const, failing: [{ name: "adds", file: "test/a.test.ts" }, { name: "x", file: "test/z.test.ts" }] };
    expect(coverText(reach(["test/a.test.ts"], ["test/new.test.ts"]), red)).toBe("covered by 2 test files, 1 failing at abc1234: test/a.test.ts");
    expect(coverText(reach(["test/b.test.ts"]), red)).toBe("covered by 1 test file, none failing at abc1234 (trunk red on other tests)");
    expect(coverText(reach([]), { trunkSha: SHA, status: "green" })).toBe("no test reaches its files; trunk green at abc1234");
    expect(coverText({ status: "certified", reach: { earlier: 0, own: 0, later: 0, earlierFiles: [], ownFiles: [], checked: 0, none: "no-code" } }, { trunkSha: SHA, status: "green" })).toBe(
      "no test covers it (it wrote no code); trunk green at abc1234",
    );
  });

  it("falls back to the latest certification for the files without closure data", () => {
    expect(coverText(undefined, { trunkSha: SHA, status: "green", counts: { tests: 434, pass: 434, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 1 } })).toBe("trunk tests green at abc1234 (434/434)");
    const red = { trunkSha: SHA, status: "red" as const, failing: [{ name: "adds", file: "test/a.test.ts" }] };
    expect(coverText(undefined, red, ["test/a.test.ts", "src/a.ts"])).toBe("trunk tests red at abc1234, failing in a file it wrote: test/a.test.ts");
    expect(coverText(undefined, red, ["src/a.ts"])).toBe("trunk tests red at abc1234 (1 test file failing)");
    expect(coverText(undefined, { trunkSha: SHA, status: "running" })).toBe("tests running at abc1234");
    expect(coverText({ status: "no-tests", reason: "no test file on trunk" }, null)).toBe("no tests: no test file on trunk");
    expect(coverText(undefined, null)).toBeNull();
  });

  it("joins the two halves into one line", () => {
    expect(holdsText(same, "covered by 2 test files, green at abc1234")).toBe("src/a.ts as it wrote it · the 2 other files it wrote or read unchanged · covered by 2 test files, green at abc1234");
    expect(holdsText(undefined, null)).toBeNull();
  });
});

describe("the walk", () => {
  const asked = { path: "src/a.ts", line: 12 };

  it("names the landing that wrote the line, the formatting-only landings it skipped and the moves it followed", () => {
    const walk: WhyWalk = {
      landingId: "lnd_1",
      path: "src/b.ts",
      line: 40,
      skipped: [{ landingId: "lnd_4", path: "src/a.ts" }, { landingId: "lnd_3", path: "src/a.ts" }],
      moved: [{ landingId: "lnd_2", from: "src/b.ts", to: "src/a.ts", line: 40 }],
    };
    expect(walkLines(walk, asked)).toEqual(["line 12 written by lnd_1 at src/b.ts:40", "moved from src/b.ts:40 by lnd_2", "skipped 2 formatting-only landings: lnd_4, lnd_3"]);
    expect(walkOwnsFirst({ landing: { id: "lnd_1" }, walk })).toBe(true);
    expect(walkOwnsFirst({ landing: { id: "lnd_9" }, walk })).toBe(false);
    expect(walkOwnsFirst({ landing: { id: "lnd_1" } })).toBeNull();
    expect(entryPath({ landing: { id: "lnd_1" }, walk }, "src/a.ts")).toBe("src/b.ts");
    expect(entryPath({ landing: { id: "lnd_2" } }, "src/a.ts")).toBe("src/a.ts");
  });

  it("says when the line came with the files, and when the walk stopped early", () => {
    expect(walkLines({ path: "src/a.ts", line: 12, skipped: [{ landingId: "lnd_3", path: "src/a.ts" }], moved: [] }, asked)).toEqual([
      "line 12 came with the files, before any landing",
      "skipped 1 formatting-only landing: lnd_3",
    ]);
    const bounded: WhyWalk = { landingId: "lnd_7", path: "src/a.ts", line: 9, skipped: [], moved: [], bounded: "it stepped through 200 landings" };
    expect(walkLines(bounded, asked)).toEqual(["line 12: the oldest landing found that changed it is lnd_7 (as line 9 then)", "the walk stopped early: it stepped through 200 landings"]);
    expect(walkLines(undefined, asked)).toEqual([]);
  });
});
