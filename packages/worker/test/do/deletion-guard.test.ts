import { describe, expect, it, vi } from "vitest";
import type { Path, Sha } from "@fire_trident/core";
import { DELETION_WAIT_MS } from "../../src/trunk/imports.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * The deletion guard (FT_DELETION_GUARD) in the real trunk writer, cycle after cycle (writer.ts: TrunkDO over a Durable
 * Object's storage, with only the network steps stood in for).
 */

const FILES: Record<Path, string> = {
  "src/lib/fresh.ts": "export const fresh = 1;\n",
  "src/lib/old.ts": "export const old = 1;\n",
  "src/app/main.ts": "console.log(1);\n",
  "README.md": "# guard\n",
};
const IMPORTER = 'import { fresh } from "../lib/fresh.ts";\nconsole.log(fresh);\n';
const BROKEN = "deleting src/lib/fresh.ts breaks the imports of src/app/main.ts: change them in the same change, or first";

describe("deletion guard in the trunk writer (FT_DELETION_GUARD)", () => {
  it("returns a deletion whose importer landed in an earlier cycle, and lands it with the importer changed in the same change", async () => {
    await withWriter(FILES, "on", async (w) => {
      // Cycle 1: the importer lands. It deletes nothing, so the import index is not touched.
      landed(await w.land(await w.proposal({ "src/app/main.ts": IMPORTER })));
      expect(w.indexed()).toBe(false);
      // Cycle 2: deleting the file it imports goes back, naming the importer; trunk keeps the file.
      const head = w.head();
      const del = await w.proposal({ "src/lib/fresh.ts": null });
      expect(await w.land(del)).toEqual({ returned: [{ proposalId: del.id, reason: BROKEN }] });
      expect(w.head()).toBe(head);
      expect(w.has("src/lib/fresh.ts")).toBe(true);
      // Cycle 3: the same deletion with the importer rewritten in the same change lands.
      const both = landed(await w.land(await w.proposal({ "src/lib/fresh.ts": null, "src/app/main.ts": "console.log(2);\n" })));
      expect(both.paths).toEqual(["src/app/main.ts", "src/lib/fresh.ts"]);
      expect(w.has("src/lib/fresh.ts")).toBe(false);
      // Only the cycles that delete files paid for the guard.
      const cycles = await w.cycles();
      expect(cycles.map((c) => c.ms.deletions !== undefined)).toEqual([false, true, true]);
    });
  });

  it("lands a deletion nothing imports, and keeps the index current from the landings in between", async () => {
    await withWriter(FILES, "on", async (w) => {
      // The first deletion builds the index; nothing imports old.ts.
      landed(await w.land(await w.proposal({ "src/lib/old.ts": null })));
      // An importer lands in a cycle of its own (marked, not read), and the next deletion finds it.
      landed(await w.land(await w.proposal({ "src/app/main.ts": IMPORTER })));
      const del = await w.proposal({ "src/lib/fresh.ts": null });
      expect((await w.land(del)).returned).toEqual([{ proposalId: del.id, reason: BROKEN }]);
    });
  });

  it("never holds a cycle up for long: with the index unreadable it waits once, then lands deletions unguarded (logged)", async () => {
    await withWriter({ ...FILES, "src/app/main.ts": IMPORTER }, "on", async (w) => {
      // Every blob read of the import index hangs (a stuck read): its first build never ends.
      (w.trunk as unknown as { blobBytes(blob: Sha): Promise<Uint8Array | null> }).blobBytes = () => new Promise(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        let t0 = Date.now();
        landed(await w.land(await w.proposal({ "src/lib/fresh.ts": null })));
        const first = Date.now() - t0;
        expect(first).toBeGreaterThanOrEqual(DELETION_WAIT_MS - 50);
        expect(first).toBeLessThan(DELETION_WAIT_MS + 2_000);
        // The same sync is still running: the next deletion does not wait for it again.
        t0 = Date.now();
        landed(await w.land(await w.proposal({ "src/lib/old.ts": null })));
        expect(Date.now() - t0).toBeLessThan(DELETION_WAIT_MS - 1_000);
        const open = warn.mock.calls.map((c) => JSON.parse(String(c[0])) as { ft: string; why: string });
        expect(open.map((o) => o.ft)).toEqual(["deletion-guard-open", "deletion-guard-open"]);
        expect(open[0]!.why).toMatch(/^import index still syncing after \d+ ms$/);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("lands the deletion as today when the guard is off, or on for another colony only", async () => {
    for (const guard of [undefined, "off", "col_other"]) {
      await withWriter(FILES, guard, async (w) => {
        landed(await w.land(await w.proposal({ "src/app/main.ts": IMPORTER })));
        landed(await w.land(await w.proposal({ "src/lib/fresh.ts": null })));
        expect(w.has("src/lib/fresh.ts")).toBe(false);
        expect((await w.cycles()).some((c) => c.ms.deletions !== undefined)).toBe(false);
        expect(w.indexed()).toBe(false);
      });
    }
  });
});
