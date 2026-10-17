import { describe, expect, it } from "vitest";
import type { Path } from "@fire_trident/core";
import type { LandContext } from "../../src/trunk/TrunkDO.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * The pause in the real trunk writer (writer.ts: TrunkDO over a Durable Object's storage, only the network steps stood
 * in for): TrunkDO.pause keeps the colony's record of its pauses, every cycle reads it before it builds and defers each
 * change while a pause is in force, the record a lane passes moves it only forward, and the pause's answer waits for
 * the cycle in flight, so trunk stays where it is from then on.
 */

const FILES: Record<Path, string> = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" };
const SENTENCE = "Agents are paused in this colony by maya: demo reset. Reads still work; wait for a person to resume.";
const paused = (at: number) => ({ paused: true, by: "maya", reason: "demo reset", at });
const resumed = (at: number) => ({ paused: false, at });
/** The lineage context a lane passes, with the colony's pause record as it read it. */
const ctx = (pause: unknown): LandContext => ({ pause }) as unknown as LandContext;

describe("the pause in the trunk writer", () => {
  it("defers every change while paused, keeps the newest record, and lands again after the resume", async () => {
    await withWriter(FILES, undefined, async (w) => {
      expect(await w.trunk.pause({ record: paused(1_000) })).toEqual({ paused: true, settled: true });
      const head = w.head();
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      expect(await w.land(p)).toEqual({ returned: [], deferred: [{ proposalId: p.id, reason: SENTENCE }] });
      expect(w.head()).toBe(head);
      // A lane that read the colony before the pause began changes nothing: its record is older.
      expect((await w.trunk.land([p], ctx(resumed(999)))).deferred).toEqual([{ proposalId: p.id, reason: SENTENCE }]);
      // A newer one (the resume did not reach the writer, a lane's batch carries it) lets the change land.
      landed(await w.trunk.land([p], ctx(resumed(2_000))));
      // A lane's record of a pause that began meanwhile defers the next change too.
      const q = await w.proposal({ "src/b.ts": "export const b = 2;\n" });
      expect((await w.trunk.land([q], ctx(paused(3_000)))).deferred).toEqual([{ proposalId: q.id, reason: SENTENCE }]);
      expect(await w.trunk.pause({ record: resumed(4_000) })).toEqual({ paused: false, settled: true });
      landed(await w.land(q));
    });
  });

  it("answers the pause once the cycle in flight is done; a change queued behind it is deferred", async () => {
    await withWriter(FILES, undefined, async (w) => {
      // Hold the push of the first cycle: it has passed its checks with nothing paused.
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      let reached!: () => void;
      const atPush = new Promise<void>((resolve) => (reached = resolve));
      (w.trunk as unknown as { pushChain(chain: unknown): Promise<{ ok: true }> }).pushChain = async () => {
        reached();
        await opened;
        return { ok: true };
      };
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      const first = w.trunk.land([p]);
      await atPush;
      const q = await w.proposal({ "src/b.ts": "export const b = 2;\n" });
      const second = w.trunk.land([q]);
      let answered = false;
      const fencing = w.trunk.pause({ record: paused(Date.now()) }).finally(() => void (answered = true));
      await new Promise((r) => setTimeout(r, 50));
      expect(answered).toBe(false);
      open();
      expect(await fencing).toEqual({ paused: true, settled: true });
      landed(await first);
      const head = w.head();
      expect((await second).deferred).toEqual([{ proposalId: q.id, reason: SENTENCE }]);
      expect(w.head()).toBe(head);
    });
  });

  it("stores nothing for a colony that was never paused", async () => {
    await withWriter(FILES, undefined, async (w) => {
      landed(await w.trunk.land([await w.proposal({ "src/a.ts": "export const a = 3;\n" })], ctx(resumed(5_000))));
      const rows = (w.trunk as unknown as { sql: SqlStorage }).sql.exec("SELECT value FROM ft_meta WHERE key = 'pause'").toArray();
      expect(rows).toEqual([]);
    });
  });
});
