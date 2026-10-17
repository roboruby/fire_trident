import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { Sha } from "@fire_trident/core";
import { CUT, HUNK_LINES } from "../../src/colony/hunks.ts";
import { QUOTE_MAX_MS, quoteReturns, type QuoteSource } from "../../src/trunk/quote.ts";

/**
 * The trunk writer's part of return hunks (FT_RETURN_HUNKS): each asked landing's diff of each asked file, and each
 * text merge conflict's contested regions, read from the landing log and the blob store, cut and masked, within the
 * budget the colony gives.
 */

const sha = (c: string): string => c.repeat(40);

function lines(n: number, changes: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => `${changes[i + 1] ?? `line ${i + 1}`}\n`).join("");
}

/** A source over texts in memory: `landings[id][path]` = [before, after] (null: absent); `clock` moves time on each read. */
function source(landings: Record<string, Record<string, [string | null, string | null]>>, extra: Record<Sha, string | Uint8Array> = {}, clock?: { now: number; step: number }): QuoteSource & { reads: Sha[] } {
  const blobs = new Map<Sha, string | Uint8Array>(Object.entries(extra));
  const id = (t: string | null): Sha | null => {
    if (t === null) return null;
    const b = blobId(t);
    blobs.set(b, t);
    return b;
  };
  const table = new Map<string, { before: Sha | null; after: Sha | null }>();
  for (const [lid, files] of Object.entries(landings)) for (const [path, [before, after]] of Object.entries(files)) table.set(`${lid} ${path}`, { before: id(before), after: id(after) });
  const reads: Sha[] = [];
  return {
    reads,
    landingPath: (landingId, path) => {
      const row = table.get(`${landingId} ${path}`);
      return row ? { trunkSha: sha("2"), ...row } : null;
    },
    read: async (blob) => {
      reads.push(blob);
      if (clock) clock.now += clock.step;
      return blobs.get(blob) ?? null;
    },
    now: () => clock?.now ?? Date.now(),
  };
}

describe("the trunk writer quotes what beat a return", () => {
  it("gives each landing's unified diff of a file, with its commit; an added file shows its lines added", async () => {
    const src = source({ lnd_a: { "src/a.ts": [lines(4), lines(4, { 2: "two" })], "src/new.ts": [null, "export const n = 1;\n"] } });
    const answer = await quoteReturns(src, {
      diffs: [
        { landingId: "lnd_a", path: "src/a.ts" },
        { landingId: "lnd_a", path: "src/new.ts" },
        { landingId: "lnd_a", path: "src/untouched.ts" },
        { landingId: "lnd_gone", path: "src/a.ts" },
      ],
      conflicts: [],
      budgetMs: 500,
    });
    expect(answer.diffs).toEqual([
      { landingId: "lnd_a", path: "src/a.ts", trunkSha: sha("2"), diff: "@@ -1,4 +1,4 @@\n line 1\n-line 2\n+two\n line 3\n line 4", truncated: false },
      { landingId: "lnd_a", path: "src/new.ts", trunkSha: sha("2"), diff: "@@ -1,0 +1,1 @@\n+export const n = 1;", truncated: false },
    ]);
    expect(answer.conflicts).toEqual([]);
  });

  it("cuts a long diff to HUNK_LINES lines with the marker, and leaves out a binary or unreadable version", async () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x0a]);
    const src = source({ lnd_a: { "src/big.ts": [lines(500), lines(500, Object.fromEntries(Array.from({ length: 500 }, (_, i) => [i + 1, `new ${i}`])))] } });
    const answer = await quoteReturns(src, { diffs: [{ landingId: "lnd_a", path: "src/big.ts" }], conflicts: [], budgetMs: 500 });
    const d = answer.diffs[0]!;
    expect(d.truncated).toBe(true);
    expect(d.diff.split("\n")).toHaveLength(HUNK_LINES + 1);
    expect(d.diff.endsWith(`\n${CUT}`)).toBe(true);

    const bin = source({}, { [sha("b")]: binary });
    const blobSrc: QuoteSource = { ...bin, landingPath: () => ({ trunkSha: sha("2"), before: sha("b"), after: sha("c") }) };
    expect((await quoteReturns(blobSrc, { diffs: [{ landingId: "lnd_a", path: "x.bin" }], conflicts: [], budgetMs: 500 })).diffs).toEqual([]);
  });

  it("splits a conflicting merge into its contested regions, keeping the ones the conflict named", async () => {
    const base = lines(10);
    const ours = lines(10, { 2: "trunk two", 8: "trunk eight" });
    const theirs = lines(10, { 2: "own two", 8: "own eight" });
    const extra = { [blobId(base)]: base, [blobId(ours)]: ours, [blobId(theirs)]: theirs };
    const conflict = { path: "src/a.ts", base: blobId(base), trunk: blobId(ours), theirs: blobId(theirs), lines: [8] };
    const answer = await quoteReturns(source({}, extra), { diffs: [], conflicts: [conflict], budgetMs: 500 });
    const { lines: _named, ...asked } = conflict;
    expect(answer.conflicts).toEqual([{ ...asked, regions: [{ path: "src/a.ts", line: 8, base: ["line 8"], trunk: ["trunk eight"], own: ["own eight"] }] }]);
    // Without named lines, every region.
    const all = await quoteReturns(source({}, extra), { diffs: [], conflicts: [{ ...conflict, lines: [] }], budgetMs: 500 });
    expect(all.conflicts[0]!.regions.map((r) => r.line)).toEqual([2, 8]);
    // A merge that is clean after all, or a version that cannot be read, quotes nothing.
    expect((await quoteReturns(source({}, extra), { diffs: [], conflicts: [{ ...conflict, theirs: blobId(base) }], budgetMs: 500 })).conflicts).toEqual([]);
    expect((await quoteReturns(source({}, extra), { diffs: [], conflicts: [{ ...conflict, trunk: sha("d") }], budgetMs: 500 })).conflicts).toEqual([]);
  });

  it("stops at the budget and answers what it has", async () => {
    const files: Record<string, [string, string]> = {};
    for (let i = 0; i < 10; i++) files[`src/f${i}.ts`] = [lines(3, { 3: `was ${i}` }), lines(3, { 1: `v${i}` })];
    const clock = { now: 0, step: 100 };
    const src = source({ lnd_a: files }, {}, clock);
    const answer = await quoteReturns(src, { diffs: Object.keys(files).map((path) => ({ landingId: "lnd_a", path })), conflicts: [], budgetMs: 450 });
    // Two reads a file at 100 ms each: two files fit in 450 ms, and the third's second read is past it.
    expect(answer.diffs.map((d) => d.path)).toEqual(["src/f0.ts", "src/f1.ts"]);
    expect(src.reads.length).toBeLessThanOrEqual(6);
    // Whatever the colony asks, the writer spends at most QUOTE_MAX_MS.
    const capped = { now: 0, step: QUOTE_MAX_MS / 2 };
    const greedy = await quoteReturns(source({ lnd_a: files }, {}, capped), { diffs: Object.keys(files).map((path) => ({ landingId: "lnd_a", path })), conflicts: [], budgetMs: 60_000 });
    expect(greedy.diffs).toHaveLength(1);
  });
});
