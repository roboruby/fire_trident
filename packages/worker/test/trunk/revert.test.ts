import { describe, expect, it } from "vitest";
import type { Path, Sha } from "@fire_trident/core";
import { movedText, planRevert, type LandedPath } from "../../src/trunk/revert.ts";

const sha = (c: string): Sha => c.repeat(40).slice(0, 40);

describe("planRevert", () => {
  // The landing edited src/a.ts, created src/new.ts and deleted src/old.ts.
  const landed: LandedPath[] = [
    { path: "src/a.ts", before: sha("1"), after: sha("2") },
    { path: "src/new.ts", before: null, after: sha("3") },
    { path: "src/old.ts", before: sha("4"), after: null },
  ];
  const later = (by: Record<Path, string>) => (path: Path) => by[path] ?? null;

  it("puts every path back while trunk still holds what the landing produced", () => {
    const trunk: Record<Path, Sha | null> = { "src/a.ts": sha("2"), "src/new.ts": sha("3") };
    expect(planRevert(landed, (p) => trunk[p] ?? null, later({}))).toEqual({
      ok: true,
      restore: [
        { path: "src/a.ts", blob: sha("1"), expect: sha("2") },
        { path: "src/new.ts", blob: null, expect: sha("3") },
        { path: "src/old.ts", blob: sha("4"), expect: null },
      ],
    });
  });

  it("refuses when work landed on top, naming each path and the landing that moved it", () => {
    const trunk: Record<Path, Sha | null> = { "src/a.ts": sha("5"), "src/old.ts": sha("6") };
    const plan = planRevert(landed, (p) => trunk[p] ?? null, later({ "src/a.ts": "lnd_b", "src/new.ts": "lnd_c", "src/old.ts": "lnd_d" }));
    expect(plan).toEqual({
      ok: false,
      moved: [
        { path: "src/a.ts", now: sha("5"), by: "lnd_b" },
        { path: "src/new.ts", now: null, by: "lnd_c" },
        { path: "src/old.ts", now: sha("6"), by: "lnd_d" },
      ],
    });
    if (plan.ok) throw new Error("expected a refusal");
    expect(movedText(plan.moved)).toBe("src/a.ts changed since by lnd_b; src/new.ts deleted since by lnd_c; src/old.ts changed since by lnd_d");
    expect(movedText(plan.moved, 1)).toBe("src/a.ts changed since by lnd_b; and 2 more");
  });

  it("skips paths the landing left as they were", () => {
    const same: LandedPath[] = [{ path: "src/a.ts", before: sha("1"), after: sha("1") }];
    expect(planRevert(same, () => sha("1"), later({}))).toEqual({ ok: true, restore: [] });
  });
});
