import { describe, expect, it } from "vitest";
import { changesNothing, textMergeCandidate, validateProposal } from "../src/occ.ts";
import type { TrunkIndex } from "../src/occ.ts";
import { mergeText } from "../src/textmerge.ts";
import type { FileVersion, Sha } from "../src/types.ts";

/**
 * Already on trunk (FT_ALREADY_ON_TRUNK): the check that a change would land nothing. The trunk writer and the lanes
 * close such a change instead of landing an empty commit or sending it back stale.
 */

const sha = (c: string): Sha => c.repeat(40);
const BASE = sha("a");
const FIX = sha("b");
const OTHER = sha("c");

const fv = (path: string, blob: Sha | null): FileVersion => ({ path, blob });
/** A trunk index over a plain map; unknown paths return undefined. */
const trunkOf = (files: Record<string, Sha | null>): TrunkIndex => (path) => (Object.hasOwn(files, path) ? files[path] : undefined);

describe("changesNothing", () => {
  it("is true when every file the change writes already holds its blob", () => {
    expect(changesNothing({ writeSet: [fv("src/a.ts", FIX), fv("src/b.ts", OTHER)] }, trunkOf({ "src/a.ts": FIX, "src/b.ts": OTHER, "src/c.ts": BASE }))).toBe(true);
  });

  it("is false when one file differs, even if the others match", () => {
    expect(changesNothing({ writeSet: [fv("src/a.ts", FIX), fv("src/b.ts", OTHER)] }, trunkOf({ "src/a.ts": FIX, "src/b.ts": BASE }))).toBe(false);
  });

  it("counts a deletion of a file trunk no longer has, and only that, as already done", () => {
    expect(changesNothing({ writeSet: [fv("src/gone.ts", null)] }, trunkOf({}))).toBe(true);
    expect(changesNothing({ writeSet: [fv("src/gone.ts", null)] }, trunkOf({ "src/gone.ts": null }))).toBe(true);
    expect(changesNothing({ writeSet: [fv("src/gone.ts", null)] }, trunkOf({ "src/gone.ts": BASE }))).toBe(false);
  });

  it("is false for a new file trunk does not have yet", () => {
    expect(changesNothing({ writeSet: [fv("src/new.ts", FIX)] }, trunkOf({}))).toBe(false);
  });

  it("is false for a change that writes nothing, and for a malformed one", () => {
    expect(changesNothing({ writeSet: [] }, trunkOf({}))).toBe(false);
    expect(changesNothing({ writeSet: undefined as unknown as FileVersion[] }, trunkOf({}))).toBe(false);
  });

  it("finds the case the stale check and text merge miss: a change from an older base that wrote what landed meanwhile", () => {
    const p = { readSet: [fv("src/a.ts", BASE)], writeSet: [fv("src/a.ts", FIX)] };
    const trunk = trunkOf({ "src/a.ts": FIX });
    // Stale against trunk (its base moved), and a text merge candidate: merging gives trunk's text back, an empty commit.
    const occ = validateProposal(p, trunk, [fv("src/a.ts", BASE)]);
    expect(occ.eligible).toBe(false);
    expect(textMergeCandidate(p, occ.stale)).toBe(true);
    expect(mergeText("one\n", "fix\n", "fix\n")).toEqual({ clean: true, text: "fix\n" });
    // It changes nothing, whatever it read.
    expect(changesNothing(p, trunk)).toBe(true);
  });

  it("finds a new file that another change already added with the same content (no text merge applies: no base)", () => {
    const p = { readSet: [], writeSet: [fv("src/new.ts", FIX)] };
    const trunk = trunkOf({ "src/new.ts": FIX });
    const occ = validateProposal(p, trunk, [fv("src/new.ts", null)]);
    expect(occ.eligible).toBe(false);
    expect(textMergeCandidate(p, occ.stale)).toBe(false);
    expect(changesNothing(p, trunk)).toBe(true);
  });
});
