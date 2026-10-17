import { describe, expect, it } from "vitest";
import { holdsText, walkLines } from "@fire_trident/core";
import { landed, withWriter } from "./writer.ts";

/**
 * `why` on the real trunk writer (TrunkDO.why, trunk/whywalk.ts), over landings it recorded itself: whether each landing
 * still holds on today's trunk, the walk for a line past a formatting-only landing, and code moved from another file.
 */

const lines = (...l: string[]): string => `${l.join("\n")}\n`;
const HELPER = ["export function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i.price;", "  return sum;", "}"];

describe("why on the trunk writer", () => {
  it("says which landing still holds as written and which changed since, and by which landing", async () => {
    await withWriter({ "src/a.ts": lines("export const a = 1;"), "src/b.ts": lines("export const b = 1;") }, undefined, async (w) => {
      const first = landed(await w.land(await w.proposal({ "src/a.ts": lines("export const a = 2;"), "src/b.ts": lines("export const b = 2;") })));
      const second = landed(await w.land(await w.proposal({ "src/b.ts": lines("export const b = 3;") })));
      const a = await w.trunk.why("src/a.ts");
      expect(a.map((e) => e.landing.id)).toEqual([first.id]);
      expect(a[0]!.holds).toEqual({ wrote: { path: "src/a.ts", state: "same" }, others: { files: 1, changed: 1, list: [{ path: "src/b.ts", state: "changed", by: second.id, landings: 1 }] } });
      expect(holdsText(a[0]!.holds, null)).toBe(`src/a.ts as it wrote it · 1 of 1 other file it wrote or read changed since: src/b.ts changed by ${second.id}`);
      const b = await w.trunk.why("src/b.ts");
      expect(b.map((e) => [e.landing.id, e.holds?.wrote.state, e.holds?.wrote.by])).toEqual([
        [second.id, "same", undefined],
        [first.id, "changed", second.id],
      ]);
    });
  });

  it("walks a line past a landing that only reformatted it, to the landing that wrote its meaning", async () => {
    await withWriter({ "src/p.ts": lines("export function price(item) {", "  return item.cost * 2;", "}") }, undefined, async (w) => {
      const meaning = landed(await w.land(await w.proposal({ "src/p.ts": lines("export function price(item) {", "  return item.cost * 3 + 'x';", "}") })));
      const fmt = landed(await w.land(await w.proposal({ "src/p.ts": lines("export function price(item) {", '    return item.cost*3 + "x"', "}") })));
      const answer = await w.trunk.why("src/p.ts", 2);
      expect(answer.map((e) => e.landing.id)).toEqual([meaning.id, fmt.id]);
      expect(answer[0]!.walk).toEqual({ landingId: meaning.id, path: "src/p.ts", line: 2, skipped: [{ landingId: fmt.id, path: "src/p.ts" }], moved: [] });
      expect(walkLines(answer[0]!.walk, { path: "src/p.ts", line: 2 })).toEqual([`line 2 written by ${meaning.id}`, `skipped 1 formatting-only landing: ${fmt.id}`]);
      // Without a line, the order is newest first and there is no walk.
      expect((await w.trunk.why("src/p.ts")).map((e) => [e.landing.id, e.walk])).toEqual([
        [fmt.id, undefined],
        [meaning.id, undefined],
      ]);
    });
  });

  it("follows a block moved from another file back to the landing that wrote it there", async () => {
    await withWriter({ "src/util.ts": lines("export const a = 1;") }, undefined, async (w) => {
      const wrote = landed(await w.land(await w.proposal({ "src/util.ts": lines("export const a = 1;", ...HELPER) })));
      const move = landed(await w.land(await w.proposal({ "src/util.ts": lines("export const a = 1;"), "src/total.ts": lines("// totals", ...HELPER) })));
      const answer = await w.trunk.why("src/total.ts", 4);
      expect(answer.map((e) => e.landing.id)).toEqual([wrote.id, move.id]);
      expect(answer[0]!.walk).toEqual({ landingId: wrote.id, path: "src/util.ts", line: 4, skipped: [], moved: [{ landingId: move.id, from: "src/util.ts", to: "src/total.ts", line: 4 }] });
      expect(walkLines(answer[0]!.walk, { path: "src/total.ts", line: 4 })).toEqual([`line 4 written by ${wrote.id} at src/util.ts:4`, `moved from src/util.ts:4 by ${move.id}`]);
      // The landing that wrote it holds no more where it wrote it: the move took the block away.
      expect(answer[0]!.holds?.wrote).toEqual({ path: "src/util.ts", state: "changed", by: move.id, landings: 1 });
    });
  });
});
