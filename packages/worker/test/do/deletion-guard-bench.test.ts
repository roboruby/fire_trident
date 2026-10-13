import { describe, expect, it } from "vitest";
import type { Path } from "@fire_trident/core";
import { resolveModule } from "../../src/decide/mechanical.ts";
import { importTargets } from "../../src/trunk/imports.ts";
import { SCRIPT_FILE } from "../../src/trunk/revert.ts";
import type { CycleStat } from "../../src/trunk/TrunkDO.ts";
import { landed, withWriter, type Writer } from "./writer.ts";

/**
 * Benchmark (opt-in): what the deletion guard adds to a trunk cycle that deletes one file, on a Hono-sized tree, in
 * the real trunk writer (writer.ts) on local workerd. The tree is the installed hono package's dist (its JavaScript
 * and declaration files, with their real relative imports). Each run makes the same cycles with the guard off and on:
 * the first deletion (the guard builds the import index), then rounds of an ordinary landing followed by a deletion
 * (the guard catches the index up with that landing), and finally a deletion that the guard sends back.
 *
 *   VITE_FT_BENCH=1 npx vitest run --project do test/do/deletion-guard-bench.test.ts
 */

/** Vite's additions to import.meta (the worker's types do not declare them; Vite rewrites the glob call in place). */
type ViteMeta = {
  env?: Record<string, string | undefined>;
  glob(pattern: string, options: { query: string; import: string }): Record<string, () => Promise<string>>;
};
const BENCH = /^(1|on|true)$/i.test((import.meta as unknown as ViteMeta).env?.VITE_FT_BENCH ?? "");
const HONO = (import.meta as unknown as ViteMeta).glob("../../../../node_modules/hono/dist/**/*.{js,ts}", { query: "?raw", import: "default" });
const ROUNDS = 15;

/** The tree, and the script files no other file imports (deleting one lands either way). */
async function honoTree(): Promise<{ files: Record<Path, string>; leaves: Path[]; hub: Path }> {
  const files: Record<Path, string> = {};
  for (const [key, load] of Object.entries(HONO)) files[`hono/${key.slice(key.indexOf("/dist/") + 1)}`] = await load();
  const exists = (p: Path): boolean => Object.hasOwn(files, p);
  const importers = new Map<Path, number>();
  for (const [path, text] of Object.entries(files)) {
    if (!SCRIPT_FILE.test(path)) continue;
    for (const t of importTargets(path, text)) {
      const dst = resolveModule(t, exists);
      if (dst !== null && dst !== path) importers.set(dst, (importers.get(dst) ?? 0) + 1);
    }
  }
  const leaves = Object.keys(files)
    .filter((p) => !importers.has(p))
    .sort();
  const hub = [...importers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  return { files, leaves, hub };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** The same cycles with the guard on or off; the stats of the deletion cycles. */
async function run(tree: Awaited<ReturnType<typeof honoTree>>, guard: string | undefined): Promise<{ cold: CycleStat; warm: CycleStat[]; returned: CycleStat | null }> {
  let out: { cold: CycleStat; warm: CycleStat[]; returned: CycleStat | null } | null = null;
  await withWriter(tree.files, guard, async (w: Writer) => {
    const last = async (): Promise<CycleStat> => (await w.cycles()).at(-1)!;
    landed(await w.land(await w.proposal({ [tree.leaves[0]!]: null })));
    const cold = await last();
    const warm: CycleStat[] = [];
    for (let i = 1; i <= ROUNDS; i++) {
      // An ordinary landing (an edit to the most imported file), then a cycle that deletes one file.
      landed(await w.land(await w.proposal({ [tree.hub]: `${tree.files[tree.hub]}\n// edit ${i}\n` })));
      landed(await w.land(await w.proposal({ [tree.leaves[i]!]: null })));
      warm.push(await last());
    }
    let returned: CycleStat | null = null;
    if (guard) {
      const back = await w.land(await w.proposal({ [tree.hub]: null }));
      expect(back.returned[0]!.reason).toMatch(/^deleting .* breaks the imports of /);
      returned = await last();
    }
    out = { cold, warm, returned };
  });
  return out!;
}

describe.skipIf(!BENCH)("deletion guard cost on a Hono-sized tree (benchmark)", () => {
  it("measures a cycle with one deletion, guard off and on", async () => {
    const tree = await honoTree();
    const scripts = Object.keys(tree.files).filter((p) => SCRIPT_FILE.test(p)).length;
    const bytes = Object.values(tree.files).reduce((n, t) => n + new TextEncoder().encode(t).length, 0);
    expect(tree.leaves.length).toBeGreaterThan(ROUNDS);
    const off = await run(tree, undefined);
    const on = await run(tree, "on");
    const summary = {
      tree: { files: Object.keys(tree.files).length, scripts, bytes, hub: tree.hub },
      cold: { offMs: off.cold.totalMs, onMs: on.cold.totalMs, guardMs: on.cold.ms.deletions ?? 0 },
      warm: {
        rounds: ROUNDS,
        offMedianMs: median(off.warm.map((c) => c.totalMs)),
        onMedianMs: median(on.warm.map((c) => c.totalMs)),
        guardMedianMs: median(on.warm.map((c) => c.ms.deletions ?? 0)),
        guardMaxMs: Math.max(...on.warm.map((c) => c.ms.deletions ?? 0)),
      },
      returned: { totalMs: on.returned?.totalMs ?? null, guardMs: on.returned?.ms.deletions ?? null },
    };
    console.log(JSON.stringify({ ft: "deletion-guard-bench", ...summary }));
    expect(on.warm.every((c) => c.ms.deletions !== undefined)).toBe(true);
    expect(off.warm.every((c) => c.ms.deletions === undefined)).toBe(true);
  }, 300_000);
});
