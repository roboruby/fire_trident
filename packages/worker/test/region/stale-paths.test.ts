import { describe, expect, it } from "vitest";
import { STALE_PATHS_SENT, stalePaths } from "../../src/region/logic.ts";

/** The structured stale paths a lane's return carries to the colony, which names the landings that moved them (movedBy). */
describe("stalePaths", () => {
  const sha = (c: string): string => c.repeat(40);

  it("keeps each path once with its blobs, and nothing when there is nothing", () => {
    expect(
      stalePaths([
        { path: "src/a.ts", expected: sha("1"), actual: sha("2") },
        { path: "src/a.ts", expected: sha("1"), actual: sha("3") },
        { path: "src/b.ts", expected: null, actual: sha("4") },
      ]),
    ).toEqual([
      { path: "src/a.ts", expected: sha("1"), actual: sha("2") },
      { path: "src/b.ts", expected: null, actual: sha("4") },
    ]);
    expect(stalePaths([])).toBeNull();
    expect(stalePaths(null)).toBeNull();
    expect(stalePaths(undefined)).toBeNull();
  });

  it("caps how many it sends", () => {
    const many = Array.from({ length: STALE_PATHS_SENT + 10 }, (_, i) => ({ path: `src/f${i}.ts`, expected: sha("1"), actual: sha("2") }));
    expect(stalePaths(many)).toHaveLength(STALE_PATHS_SENT);
    expect(stalePaths(many, 3)!.map((s) => s.path)).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts"]);
  });
});
