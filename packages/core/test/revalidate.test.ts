import { describe, expect, it } from "vitest";
import { revalidate, revalidationCandidate, revalidationEnabled, validateProposal } from "../src/occ.ts";
import type { ExportSurface, ExportedNames, OccResult } from "../src/occ.ts";
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
    expect(revalidate(twice, staleOn(twice, NEW), exportsOf({ [NEW]: surface(["a"]) }))).toEqual({ ok: false, broken: { path: "src/s.ts", names: ["b"] } });
  });
});

describe("revalidate (the trunk writer, with the exported names)", () => {
  it("lands when every imported name is still exported, recording the blobs and names", () => {
    const p = reader(["default", "config"]);
    const r = revalidate(p, staleOn(p, NEW), exportsOf({ [NEW]: surface(["config", "default", "added"]) }));
    expect(r).toEqual({ ok: true, revalidated: [{ path: "src/s.ts", read: OLD, landedOn: NEW, names: ["config", "default"] }] });
  });

  it("goes back naming the names that are gone (a removed or renamed export)", () => {
    const p = reader(["config", "load"]);
    expect(revalidate(p, staleOn(p, NEW), exportsOf({ [NEW]: surface(["config", "loadConfig"]) }))).toEqual({ ok: false, broken: { path: "src/s.ts", names: ["load"] } });
  });

  it("goes back without blaming a name when the version's exports are unknown or re-exported wholesale", () => {
    const p = reader(["load"]);
    expect(revalidate(p, staleOn(p, NEW), exportsOf({}))).toEqual({ ok: false });
    expect(revalidate(p, staleOn(p, NEW), exportsOf({ [NEW]: surface(["config"], true) }))).toEqual({ ok: false });
    expect(revalidate(p, staleOn(p, NEW), exportsOf({ [NEW]: surface(["load"], true) })).ok).toBe(true);
  });

  it("never revalidates a non-candidate, whatever the exports say", () => {
    const p = reader(["config"], { writes: [fv("src/s.ts", MINE)] });
    const stale = validateProposal(p, (path) => (path === "src/s.ts" ? NEW : null), [fv("src/s.ts", OLD), fv("src/r.ts", null)]).stale;
    expect(revalidate(p, stale, exportsOf({ [NEW]: surface(["config"]) }))).toEqual({ ok: false });
  });

  it("checks every stale read file", () => {
    const p = { ...reader(null, { reads: [fv("src/t.ts", OLD)] }), nameAssumptions: [{ path: "src/s.ts", names: ["a"] }, { path: "src/t.ts", names: ["b"] }] };
    const T2 = sha("c");
    const stale = staleOn(p, NEW, { "src/t.ts": T2 });
    expect(revalidate(p, stale, exportsOf({ [NEW]: surface(["a"]), [T2]: surface(["b"]) })).ok).toBe(true);
    expect(revalidate(p, stale, exportsOf({ [NEW]: surface(["a"]), [T2]: surface(["c"]) }))).toEqual({ ok: false, broken: { path: "src/t.ts", names: ["b"] } });
  });
});
