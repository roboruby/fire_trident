import { describe, expect, it } from "vitest";
import type { Path } from "@fire_trident/core";
import { DIRECTION_TABLE } from "../../src/trunk/direction.ts";
import { isFenceHeld } from "../../src/trunk/fencecheck.ts";
import { PROTECT_TABLE } from "../../src/trunk/protect.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * The direction fence fails closed in the real trunk writer (writer.ts: TrunkDO over a Durable Object's storage): a cycle
 * that cannot read the record of intents withdrawn or amended holds the changes it could not check for the next cycle,
 * lands none of them and sends none back, counts them in its stats, and lands them in the first cycle whose read works.
 * The protected-path check at the same commit point holds the same way.
 */

const FILES: Record<Path, string> = { "src/a.ts": "export const a = 1;\n", "README.md": "# fence\n" };

/** The writer's own storage, where the test breaks and mends the record. */
function sqlOf(trunk: unknown): SqlStorage {
  return (trunk as { sql: SqlStorage }).sql;
}

describe("the direction fence in the trunk writer, when its record cannot be read", () => {
  it("holds the change for the next cycle (not landed, not returned), counts it, and lands it once the read works", async () => {
    await withWriter(FILES, undefined, async (w) => {
      const sql = sqlOf(w.trunk);
      const head = w.head();
      sql.exec("DROP TABLE ft_direction");
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      const r = await w.land(p);
      expect(r.landing).toBeUndefined();
      expect(r.returned).toEqual([]);
      expect(r.deferred).toHaveLength(1);
      expect(r.deferred![0]!.proposalId).toBe(p.id);
      expect(isFenceHeld(r.deferred![0]!.reason)).toBe(true);
      expect(r.deferred![0]!.reason).toMatch(/could not read whether this change's intent was withdrawn or amended \(.*ft_direction.*\), so the change was neither landed nor sent back/);
      expect(w.head()).toBe(head);
      const held = (await w.cycles()).at(-1)!;
      expect(held).toMatchObject({ directionUnchecked: 1, deferred: 1, landed: 0, returned: 0 });

      // A transient failure does not wedge anything: the next cycle that reads the record lands the same change.
      sql.exec(DIRECTION_TABLE);
      const l = landed(await w.land(p));
      expect(l.proposalIds).toEqual([p.id]);
      expect(w.head()).not.toBe(head);
      expect((await w.cycles()).at(-1)).not.toHaveProperty("directionUnchecked");
    });
  });

  it("holds only the change whose intent's row cannot be parsed, and still sends back a withdrawn one", async () => {
    await withWriter(FILES, undefined, async (w) => {
      const sql = sqlOf(w.trunk);
      const bad = await w.proposal({ "src/a.ts": "export const a = 3;\n" });
      const gone = await w.proposal({ "README.md": "# gone\n" });
      const fine = await w.proposal({ "src/b.ts": "export const b = 1;\n" });
      sql.exec("INSERT INTO ft_direction (intent_id, info, at) VALUES (?, ?, 1)", bad.intentId, "{not json");
      sql.exec("INSERT INTO ft_direction (intent_id, info, at) VALUES (?, ?, 1)", gone.intentId, JSON.stringify({ status: "withdrawn", revision: 1, withdrawnReason: "not needed" }));
      const r = await w.land(bad, gone, fine);
      expect(r.landing?.proposalIds).toEqual([fine.id]);
      expect(r.returned).toEqual([{ proposalId: gone.id, reason: "withdrawn: not needed" }]);
      expect(r.deferred?.map((d) => d.proposalId)).toEqual([bad.id]);
      expect(r.deferred![0]!.reason).toContain(`the record of intent ${bad.intentId} cannot be parsed`);
      expect((await w.cycles()).at(-1)?.directionUnchecked).toBe(1);
    });
  });
});

describe("the protected-path check in the trunk writer, when its record cannot be read", () => {
  it("holds the cycle's changes for the next cycle (not landed, not sent to a person), counts them, and lands them once the read works", async () => {
    await withWriter(FILES, undefined, async (w) => {
      const sql = sqlOf(w.trunk);
      const head = w.head();
      sql.exec("DROP TABLE ft_protected");
      const p = await w.proposal({ "src/a.ts": "export const a = 4;\n" });
      const r = await w.land(p);
      expect(r.landing).toBeUndefined();
      expect(r.returned).toEqual([]);
      expect(r.deferred?.map((d) => d.proposalId)).toEqual([p.id]);
      expect(isFenceHeld(r.deferred![0]!.reason)).toBe(true);
      expect(r.deferred![0]!.reason).toMatch(/^waiting for the next landing cycle: the protected-path check could not read the colony's protected paths \(.*ft_protected.*\)/);
      expect(w.head()).toBe(head);
      expect((await w.cycles()).at(-1)).toMatchObject({ protectUnchecked: 1, deferred: 1, landed: 0, returned: 0 });

      sql.exec(PROTECT_TABLE);
      expect(landed(await w.land(p)).proposalIds).toEqual([p.id]);
      expect((await w.cycles()).at(-1)).not.toHaveProperty("protectUnchecked");
    });
  });
});
