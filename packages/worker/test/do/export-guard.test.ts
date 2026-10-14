import { describe, expect, it, vi } from "vitest";
import type { Path, Sha } from "@fire_trident/core";
import { DELETION_WAIT_MS } from "../../src/trunk/imports.ts";
import { landed, withWriter, type Writer } from "./writer.ts";

/**
 * The export guard (FT_EXPORT_GUARD) in the real trunk writer, cycle after cycle (writer.ts: TrunkDO over a Durable
 * Object's storage, with only the network steps stood in for).
 */

const FILES: Record<Path, string> = {
  "src/lib/b.ts": "export function foo() {\n  return 1;\n}\nexport const bar = 2;\n",
  "src/app/a.ts": 'import { foo } from "../lib/b.ts";\nconsole.log(foo());\n',
  "README.md": "# guard\n",
};
const REMOVED = "export const bar = 2;\n";
const BROKEN = "removing export foo from src/lib/b.ts breaks the import in src/app/a.ts: change src/app/a.ts in the same change, or first";

/** Set FT_EXPORT_GUARD on the writer's env (each cycle reads it). */
function exportGuard(w: Writer, value: string | undefined): void {
  (w.trunk as unknown as { env: Record<string, unknown> }).env.FT_EXPORT_GUARD = value;
}

describe("export guard in the trunk writer (FT_EXPORT_GUARD)", () => {
  it("returns a change that removes an export a trunk file imports, and lands it with the importer changed in the same change", async () => {
    await withWriter(FILES, undefined, async (w) => {
      exportGuard(w, "on");
      const head = w.head();
      const removal = await w.proposal({ "src/lib/b.ts": REMOVED });
      expect(await w.land(removal)).toEqual({ returned: [{ proposalId: removal.id, reason: BROKEN }] });
      expect(w.head()).toBe(head);
      const both = landed(await w.land(await w.proposal({ "src/lib/b.ts": REMOVED, "src/app/a.ts": "console.log(2);\n" })));
      expect(both.paths).toEqual(["src/app/a.ts", "src/lib/b.ts"]);
      const cycles = await w.cycles();
      expect(cycles.map((c) => [c.ms.exports !== undefined, c.exportsUncovered])).toEqual([
        [true, 0],
        [true, 0],
      ]);
    });
  });

  it("lands an edit that keeps every export without reading the import index, and finds an importer landed since", async () => {
    await withWriter({ ...FILES, "src/app/a.ts": "console.log(0);\n" }, undefined, async (w) => {
      exportGuard(w, "on");
      landed(await w.land(await w.proposal({ "src/lib/b.ts": `${FILES["src/lib/b.ts"]}export const baz = 3;\n` })));
      expect(w.indexed()).toBe(false);
      // Nothing imports foo yet: removing it lands (the index is built for the check).
      landed(await w.land(await w.proposal({ "src/lib/b.ts": `export function foo() {}\n${REMOVED}` })));
      landed(await w.land(await w.proposal({ "src/app/a.ts": FILES["src/app/a.ts"]! })));
      const removal = await w.proposal({ "src/lib/b.ts": REMOVED });
      expect((await w.land(removal)).returned).toEqual([{ proposalId: removal.id, reason: BROKEN }]);
    });
  });

  it("lets only one of a removal and a new import of the name land in one cycle, naming the first to the second", async () => {
    await withWriter({ ...FILES, "src/app/a.ts": "console.log(0);\n" }, undefined, async (w) => {
      exportGuard(w, (await w.proposal({})).colonyId);
      const adds = await w.proposal({ "src/app/c.ts": 'import { foo } from "../lib/b.ts";\nexport const c = foo();\n' });
      const removal = await w.proposal({ "src/lib/b.ts": REMOVED });
      const r = await w.land(adds, removal);
      expect(r.landing?.proposalIds).toEqual([adds.id]);
      expect(r.returned).toEqual([
        {
          proposalId: removal.id,
          reason: `conflicts with ${adds.id} in this landing: its src/app/c.ts imports foo from src/lib/b.ts, which this change stops exporting: keep the export, or change src/app/c.ts in this change once that change lands`,
        },
      ]);
    });
  });

  it("lands the removal as today when the guard is off, or on for another colony only", async () => {
    for (const guard of [undefined, "off", "col_other"]) {
      await withWriter(FILES, undefined, async (w) => {
        exportGuard(w, guard);
        landed(await w.land(await w.proposal({ "src/lib/b.ts": REMOVED })));
        const cycles = await w.cycles();
        expect(cycles.some((c) => c.ms.exports !== undefined || c.exportsUncovered !== undefined)).toBe(false);
        expect(w.indexed()).toBe(false);
      });
    }
  });

  it("never holds a cycle up for long: with blob reads stalled it waits once, then lands changes unchecked (counted, logged)", async () => {
    await withWriter(FILES, undefined, async (w) => {
      exportGuard(w, "on");
      (w.trunk as unknown as { blobBytes(blob: Sha): Promise<Uint8Array | null> }).blobBytes = () => new Promise(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        let t0 = Date.now();
        landed(await w.land(await w.proposal({ "src/lib/b.ts": REMOVED })));
        const first = Date.now() - t0;
        expect(first).toBeGreaterThanOrEqual(DELETION_WAIT_MS - 50);
        expect(first).toBeLessThan(DELETION_WAIT_MS + 2_000);
        t0 = Date.now();
        landed(await w.land(await w.proposal({ "src/lib/b.ts": "export const bar = 3;\n" })));
        expect(Date.now() - t0).toBeLessThan(DELETION_WAIT_MS - 1_000);
        expect((await w.cycles()).map((c) => c.exportsUncovered)).toEqual([1, 1]);
        const open = warn.mock.calls.map((c) => JSON.parse(String(c[0])) as { ft: string; why: string });
        expect(open.map((o) => [o.ft, o.why])).toEqual([
          ["export-guard-open", `a blob read took longer than ${DELETION_WAIT_MS} ms`],
          ["export-guard-open", "blob reads stalled in an earlier cycle"],
        ]);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
