import { describe, expect, it } from "vitest";
import { landed, withWriter } from "./writer.ts";

/**
 * The first red search's range through the real trunk writer (TrunkDO.landingRange over its landing log): the commits
 * of whole landing cycles between two commits, oldest first, each with a file it wrote that reads back at that commit
 * through baseBlobs (how the search knows it read the commit), and no range when the log does not link the two.
 */

describe("TrunkDO.landingRange", () => {
  it("lists the landings between two commits, oldest first, each with a file it wrote at that commit", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n", "test/a.test.ts": "// a\n" }, undefined, async (w) => {
      const initial = w.head();
      const first = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" })));
      const second = landed(await w.land(await w.proposal({ "src/b.ts": "export const b = 1;\n", "src/a.ts": null })));
      const third = landed(await w.land(await w.proposal({ "src/c.ts": "export const c = 1;\n" })));

      const all = await w.trunk.landingRange({ from: initial, to: third.trunkSha, toLanding: third.id });
      expect(all.ok && all.landings.map((l) => [l.landingId, l.trunkSha])).toEqual([first, second, third].map((l) => [l.id, l.trunkSha]));
      if (!all.ok) return;
      for (const l of all.landings) {
        expect(l.witness).toBeDefined();
        const [read] = await w.trunk.baseBlobs(l.trunkSha, [l.witness!.path]);
        expect(read).toEqual({ path: l.witness!.path, blob: l.witness!.blob });
      }
      // The landing that deleted src/a.ts is witnessed by the file it added.
      expect(all.landings[1]!.witness!.path).toBe("src/b.ts");
      // A commit the writer cannot read answers no blob: the witness is how the search tells.
      expect(await w.trunk.baseBlobs("0".repeat(40), ["src/b.ts"])).toEqual([{ path: "src/b.ts", blob: null }]);

      expect(await w.trunk.landingRange({ from: first.trunkSha, to: third.trunkSha })).toMatchObject({ ok: true, landings: [{ landingId: second.id }, { landingId: third.id }] });
      expect(await w.trunk.landingRange({ from: initial, to: third.trunkSha, max: 2 })).toEqual({ ok: false, reason: `More than 2 landings since the last green commit ${initial.slice(0, 7)}: too many to search.` });
      expect(await w.trunk.landingRange({ from: "f".repeat(40), to: third.trunkSha })).toMatchObject({ ok: false, reason: expect.stringMatching(/^The landing log does not reach the last green commit fffffff/) });
    });
  });
});
