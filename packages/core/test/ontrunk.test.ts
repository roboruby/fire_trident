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

  it("finds a change from an older base that wrote what landed meanwhile, when it did not read the file or read trunk's version", () => {
    const blind = { readSet: [], writeSet: [fv("src/a.ts", FIX)] };
    const trunk = trunkOf({ "src/a.ts": FIX });
    // Stale against trunk (its base moved), and a text merge candidate: merging gives trunk's text back, an empty commit.
    const occ = validateProposal(blind, trunk, [fv("src/a.ts", BASE)]);
    expect(occ.eligible).toBe(false);
    expect(textMergeCandidate(blind, occ.stale)).toBe(true);
    expect(mergeText("one\n", "fix\n", "fix\n")).toEqual({ clean: true, text: "fix\n" });
    expect(changesNothing(blind, trunk)).toBe(true);
    // Read at the version trunk has now (the agent read again after the fix landed): nothing left to land either.
    expect(changesNothing({ readSet: [fv("src/a.ts", FIX)], writeSet: [fv("src/a.ts", FIX)] }, trunk)).toBe(true);
  });

  it("does not close a change that read the file it writes at a version trunk moved past: the same edit may be its own to make", () => {
    // Two increments of one counter from one read both write 6; the first landed. The second is not done: it goes back.
    const p = { readSet: [fv("src/a.ts", BASE)], writeSet: [fv("src/a.ts", FIX)] };
    const trunk = trunkOf({ "src/a.ts": FIX });
    expect(changesNothing(p, trunk)).toBe(false);
    expect(mergeText("one\n", "fix\n", "fix\n", undefined, { staleRead: true })).toEqual({ clean: false, conflicts: 0, lines: [], repeated: [1] });
    // One stale read of one written file is enough; a stale read of a file it only reads does not count.
    expect(changesNothing({ readSet: [fv("src/a.ts", FIX), fv("src/b.ts", BASE)], writeSet: [fv("src/a.ts", FIX), fv("src/b.ts", OTHER)] }, trunkOf({ "src/a.ts": FIX, "src/b.ts": OTHER }))).toBe(false);
    expect(changesNothing({ readSet: [fv("src/a.ts", FIX), fv("src/c.ts", BASE)], writeSet: [fv("src/a.ts", FIX)] }, trunkOf({ "src/a.ts": FIX, "src/c.ts": OTHER }))).toBe(true);
    // A deletion of a file it read before another change deleted it, and a file it read as absent that another added.
    expect(changesNothing({ readSet: [fv("src/gone.ts", BASE)], writeSet: [fv("src/gone.ts", null)] }, trunkOf({}))).toBe(false);
    expect(changesNothing({ readSet: [fv("src/new.ts", null)], writeSet: [fv("src/new.ts", FIX)] }, trunkOf({ "src/new.ts": FIX }))).toBe(false);
    // Old or odd stored read sets read as no reads.
    expect(changesNothing({ readSet: undefined as unknown as FileVersion[], writeSet: [fv("src/a.ts", FIX)] }, trunk)).toBe(true);
    expect(changesNothing({ readSet: [null as unknown as FileVersion], writeSet: [fv("src/a.ts", FIX)] }, trunk)).toBe(true);
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
