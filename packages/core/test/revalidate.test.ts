import { describe, expect, it } from "vitest";
import { onlyGrew, revalidate, revalidationCandidate, revalidationEnabled, validateProposal } from "../src/occ.ts";
import type { ExportSurface, ExportedNames, GrewOnly, Growth, OccResult, TopStatements } from "../src/occ.ts";
import type { FileVersion, NameAssumption, Path, Sha } from "../src/types.ts";

const sha = (c: string): Sha => c.repeat(40);
const OLD = sha("a");
const NEW = sha("b");
const MINE = sha("f");

const fv = (path: string, blob: Sha | null): FileVersion => ({ path, blob });

/** A reader: writes its own new file, read the shared file at OLD, imports `names` from it. */
function reader(names: string[] | null, extra: { reads?: FileVersion[]; writes?: FileVersion[]; assumptions?: NameAssumption[] } = {}) {
  return {
    readSet: [fv("src/s.ts", OLD), ...(extra.reads ?? [])],
    writeSet: [fv("src/r.ts", MINE), ...(extra.writes ?? [])],
    nameAssumptions: extra.assumptions ?? (names === null ? [] : [{ path: "src/s.ts", names }]),
  };
}

/** The OCC result of `p` against a trunk where src/s.ts moved from OLD to `now`. */
function staleOn(p: { readSet: FileVersion[]; writeSet: FileVersion[] }, now: Sha | null, extra: Record<Path, Sha | null> = {}): OccResult["stale"] {
  const trunk: Record<Path, Sha | null> = { "src/s.ts": now, ...extra };
  return validateProposal(p, (path) => (path in trunk ? trunk[path] : null), []).stale;
}

const surface = (names: string[], open = false): ExportSurface => ({ names: new Set(names), open });
const exportsOf = (by: Record<Sha, ExportSurface | null>): ExportedNames => (_path, blob) => by[blob] ?? null;
/** The growth check as the worker supplies it: every file only grew unless `by` says otherwise for its path. */
const grewBy = (by: Record<Path, Growth> = {}): GrewOnly => (path) => (path in by ? by[path]! : { grew: true });
const GREW: GrewOnly = grewBy();

/** A statement list: each entry a statement's hash, with its line (1 + its index unless given) and whether it declares (yes unless listed in `runs`). */
function statements(hashes: string[], extra: { lines?: number[]; runs?: number[]; prologue?: number; mode?: string } = {}): TopStatements {
  return {
    mode: extra.mode ?? "ts",
    hashes,
    lines: extra.lines ?? hashes.map((_, i) => i + 1),
    declares: hashes.map((_, i) => !(extra.runs ?? []).includes(i)),
    prologue: extra.prologue ?? 0,
  };
}

describe("revalidationEnabled (FT_REVALIDATE)", () => {
  it("is off when absent, empty or off", () => {
    expect(revalidationEnabled(undefined, "colony-a")).toBe(false);
    expect(revalidationEnabled("", "colony-a")).toBe(false);
    expect(revalidationEnabled(" off ", "colony-a")).toBe(false);
    expect(revalidationEnabled("OFF", "colony-a")).toBe(false);
  });

  it("is on everywhere with on, and per colony with a list", () => {
    expect(revalidationEnabled("on", "colony-a")).toBe(true);
    expect(revalidationEnabled(" On ", "anything")).toBe(true);
    expect(revalidationEnabled("colony-b, colony-a", "colony-a")).toBe(true);
    expect(revalidationEnabled("colony-b,colony-a", "colony-b")).toBe(true);
    expect(revalidationEnabled("colony-b,colony-a", "colony-c")).toBe(false);
    expect(revalidationEnabled("colony-a2", "colony-a")).toBe(false);
    expect(revalidationEnabled(",,", "")).toBe(false);
  });
});

describe("revalidationCandidate (the lane's pre-check)", () => {
  it("accepts a change stale only through a read file covered by a name assumption", () => {
    const p = reader(["config"]);
    expect(revalidationCandidate(p, staleOn(p, NEW))).toBe(true);
  });

  it("refuses a change that is not stale, or has no assumption for the stale file", () => {
    const p = reader(["config"]);
    expect(revalidationCandidate(p, [])).toBe(false);
    const bare = reader(null);
    expect(revalidationCandidate(bare, staleOn(bare, NEW))).toBe(false);
    const other = reader(null, { assumptions: [{ path: "src/other.ts", names: ["x"] }] });
    expect(revalidationCandidate(other, staleOn(other, NEW))).toBe(false);
  });

  it("refuses a change stale on a file it writes (write/write), even one it also read", () => {
    const p = reader(["config"], { writes: [fv("src/s.ts", MINE)] });
    const stale = validateProposal(p, (path) => (path === "src/s.ts" ? NEW : null), [fv("src/s.ts", OLD), fv("src/r.ts", null)]).stale;
    expect(revalidationCandidate(p, stale)).toBe(false);
  });

  it("refuses when another stale read file is uncovered", () => {
    const p = reader(["config"], { reads: [fv("src/t.ts", OLD)] });
    expect(revalidationCandidate(p, staleOn(p, NEW, { "src/t.ts": NEW }))).toBe(false);
  });

  it("refuses a read file deleted on trunk, and one that was absent when read", () => {
    const p = reader(["config"]);
    expect(revalidationCandidate(p, staleOn(p, null))).toBe(false);
    const absent = { ...reader(["config"]), readSet: [fv("src/s.ts", null)] };
    expect(revalidationCandidate(absent, staleOn(absent, NEW))).toBe(false);
  });

  it("treats malformed stored assumptions as no assumption, and unions repeated ones", () => {
    const odd = reader(null, { assumptions: [{ path: "src/s.ts", names: [] }] });
    expect(revalidationCandidate(odd, staleOn(odd, NEW))).toBe(false);
    const mixed = reader(null, { assumptions: [{ path: "src/s.ts", names: ["a"] }, { path: "src/s.ts", names: [7 as unknown as string] }] });
    expect(revalidationCandidate(mixed, staleOn(mixed, NEW))).toBe(false);
    const junk = { ...reader(["config"]), nameAssumptions: "nope" as unknown as NameAssumption[] };
    expect(revalidationCandidate(junk, staleOn(junk, NEW))).toBe(false);
    const twice = reader(null, { assumptions: [{ path: "src/s.ts", names: ["a"] }, { path: "src/s.ts", names: ["b"] }] });
    expect(revalidate(twice, staleOn(twice, NEW), exportsOf({ [NEW]: surface(["a"]) }), GREW)).toEqual({ ok: false, broken: { path: "src/s.ts", names: ["b"] } });
  });
});

describe("revalidate (the trunk writer, with the exported names and the growth check)", () => {
  it("lands when every imported name is still exported and the file only grew, recording the blobs, names and growth", () => {
    const p = reader(["default", "config"]);
    const r = revalidate(p, staleOn(p, NEW), exportsOf({ [NEW]: surface(["config", "default", "added"]) }), GREW);
    expect(r).toEqual({ ok: true, revalidated: [{ path: "src/s.ts", read: OLD, landedOn: NEW, names: ["config", "default"], grew: true }] });
  });

  it("goes back naming the names that are gone (a removed or renamed export), before the growth check", () => {
    const p = reader(["config", "load"]);
    let asked = 0;
    const counting: GrewOnly = () => {
      asked++;
      return { grew: true };
    };
    expect(revalidate(p, staleOn(p, NEW), exportsOf({ [NEW]: surface(["config", "loadConfig"]) }), counting)).toEqual({ ok: false, broken: { path: "src/s.ts", names: ["load"] } });
    expect(asked).toBe(0);
  });

  it("goes back naming the file and the line when the file did more than grow", () => {
    const p = reader(["config"]);
    const exported = exportsOf({ [NEW]: surface(["config"]) });
    expect(revalidate(p, staleOn(p, NEW), exported, grewBy({ "src/s.ts": { grew: false, line: 12, why: "edited" } }))).toEqual({ ok: false, changed: { path: "src/s.ts", line: 12, why: "edited" } });
    expect(revalidate(p, staleOn(p, NEW), exported, grewBy({ "src/s.ts": { grew: false, line: 3, why: "added" } }))).toEqual({ ok: false, changed: { path: "src/s.ts", line: 3, why: "added" } });
  });

  it("goes back without blame when the growth cannot be known, and asks it about the blobs read and landed on", () => {
    const p = reader(["config"]);
    const asked: Array<[Path, Sha, Sha]> = [];
    const unknown: GrewOnly = (path, read, landedOn) => {
      asked.push([path, read, landedOn]);
      return null;
    };
    expect(revalidate(p, staleOn(p, NEW), exportsOf({ [NEW]: surface(["config"]) }), unknown)).toEqual({ ok: false });
    expect(asked).toEqual([["src/s.ts", OLD, NEW]]);
  });

  it("goes back without blaming a name when the version's exports are unknown or re-exported wholesale", () => {
    const p = reader(["load"]);
    expect(revalidate(p, staleOn(p, NEW), exportsOf({}), GREW)).toEqual({ ok: false });
    expect(revalidate(p, staleOn(p, NEW), exportsOf({ [NEW]: surface(["config"], true) }), GREW)).toEqual({ ok: false });
    expect(revalidate(p, staleOn(p, NEW), exportsOf({ [NEW]: surface(["load"], true) }), GREW).ok).toBe(true);
  });

  it("never revalidates a non-candidate, whatever the exports say", () => {
    const p = reader(["config"], { writes: [fv("src/s.ts", MINE)] });
    const stale = validateProposal(p, (path) => (path === "src/s.ts" ? NEW : null), [fv("src/s.ts", OLD), fv("src/r.ts", null)]).stale;
    expect(revalidate(p, stale, exportsOf({ [NEW]: surface(["config"]) }), GREW)).toEqual({ ok: false });
  });

  it("checks every stale read file, names and growth", () => {
    const p = { ...reader(null, { reads: [fv("src/t.ts", OLD)] }), nameAssumptions: [{ path: "src/s.ts", names: ["a"] }, { path: "src/t.ts", names: ["b"] }] };
    const T2 = sha("c");
    const stale = staleOn(p, NEW, { "src/t.ts": T2 });
    expect(revalidate(p, stale, exportsOf({ [NEW]: surface(["a"]), [T2]: surface(["b"]) }), GREW).ok).toBe(true);
    expect(revalidate(p, stale, exportsOf({ [NEW]: surface(["a"]), [T2]: surface(["c"]) }), GREW)).toEqual({ ok: false, broken: { path: "src/t.ts", names: ["b"] } });
    const second = grewBy({ "src/t.ts": { grew: false, line: 7, why: "edited" } });
    expect(revalidate(p, stale, exportsOf({ [NEW]: surface(["a"]), [T2]: surface(["b"]) }), second)).toEqual({ ok: false, changed: { path: "src/t.ts", line: 7, why: "edited" } });
  });
});

describe("onlyGrew (the growth check over two versions' top-level statements)", () => {
  const read = statements(["imp", "fnA", "fnB", "expC"]);

  it("passes a version that only gained declarations, anywhere between the statements read", () => {
    expect(onlyGrew(read, read)).toEqual({ grew: true });
    expect(onlyGrew(read, statements(["imp", "fnA", "new", "fnB", "expC"]))).toEqual({ grew: true });
    expect(onlyGrew(read, statements(["new0", "imp", "fnA", "fnB", "expC", "new1", "new2"]))).toEqual({ grew: true });
    expect(onlyGrew(statements([]), statements(["new"]))).toEqual({ grew: true });
  });

  it("names the first statement read that is not there as it was: edited, removed or moved, by its line in the version read", () => {
    const lines = [1, 4, 9, 15];
    const was = statements(["imp", "fnA", "fnB", "expC"], { lines });
    expect(onlyGrew(was, statements(["imp", "fnA2", "fnB", "expC"]))).toEqual({ grew: false, line: 4, why: "edited" });
    expect(onlyGrew(was, statements(["imp", "fnA", "expC"]))).toEqual({ grew: false, line: 9, why: "edited" });
    // Re-ordered: fnA is still found after fnB, so fnB is the first statement that is not there in order.
    expect(onlyGrew(was, statements(["imp", "fnB", "fnA", "expC"]))).toEqual({ grew: false, line: 9, why: "edited" });
    expect(onlyGrew(was, statements(["fnA", "fnB", "expC", "imp"]))).toEqual({ grew: false, line: 4, why: "edited" });
    expect(onlyGrew(was, statements([]))).toEqual({ grew: false, line: 1, why: "edited" });
  });

  it("names the first new statement that runs rather than declares, by its line in the version it would land on", () => {
    const now = statements(["imp", "fnA", "call", "fnB", "expC", "call2"], { lines: [1, 2, 3, 4, 5, 6], runs: [2, 5] });
    expect(onlyGrew(read, now)).toEqual({ grew: false, line: 3, why: "added" });
    // Only new statements are judged: a statement read that runs something is matched like any other.
    const ran = statements(["imp", "call", "fnB"], { runs: [1] });
    expect(onlyGrew(ran, statements(["imp", "call", "new", "fnB"]))).toEqual({ grew: true });
  });

  it("keeps the prologue in place: a directive counts only while nothing comes before it", () => {
    const was = statements(["use strict", "imp", "fnA"], { prologue: 1 });
    expect(onlyGrew(was, statements(["use strict", "imp", "new", "fnA"], { prologue: 1 }))).toEqual({ grew: true });
    expect(onlyGrew(was, statements(["new", "use strict", "imp", "fnA"]))).toEqual({ grew: false, line: 1, why: "edited" });
    expect(onlyGrew(was, statements(["imp", "fnA"]))).toEqual({ grew: false, line: 1, why: "edited" });
  });

  it("cannot know when the versions were read in different modes, or a list is malformed", () => {
    expect(onlyGrew(read, statements(["imp", "fnA", "fnB", "expC"], { mode: "tsx" }))).toBeNull();
    expect(onlyGrew(read, { ...statements(["imp"]), lines: [] })).toBeNull();
    expect(onlyGrew({ ...read, declares: [true] }, read)).toBeNull();
    expect(onlyGrew(read, statements(["imp", "fnA", "fnB", "expC"], { prologue: 5 }))).toBeNull();
    expect(onlyGrew(read, statements(["imp"], { prologue: -1 }))).toBeNull();
  });
});
