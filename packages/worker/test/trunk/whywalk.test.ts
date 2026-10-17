import { describe, expect, it } from "vitest";
import type { Landing, LineageNote, Path, Sha } from "@fire_trident/core";
import { WHY_WALK_MS, WHY_WALK_STEPS, holdsOf, walkLine, whyLineage, type WhySource } from "../../src/trunk/whywalk.ts";

/**
 * `why` per line over a stand-in landing log (trunk/whywalk.ts): the walk past formatting-only landings, through code
 * moved from another file, within its bounds, and whether each landing still holds on today's trunk.
 */

type Change = Record<Path, string | null>;
interface Spec {
  id: string;
  changes: Change;
  reads?: Record<Path, string | null>;
}

/** A landing log built from changes on top of `files`, with a clock the test moves. */
function log(files: Record<Path, string>, landings: Spec[], clock = { t: 0, step: 0 }): WhySource & { blobOf(text: string): Sha; reads: number } {
  const blobs = new Map<Sha, string>();
  const blobOf = (text: string): Sha => {
    const sha = `b${[...blobs.values()].indexOf(text) >= 0 ? [...blobs.values()].indexOf(text) : blobs.size}`.padEnd(40, "0");
    blobs.set(sha, text);
    return sha;
  };
  const tree = new Map<Path, Sha>(Object.entries(files).map(([p, t]) => [p, blobOf(t)]));
  const rows: Array<{ seq: number; path: Path; landingId: string; before: Sha | null; after: Sha | null }> = [];
  const meta = new Map<number, { landing: Landing; note: LineageNote }>();
  landings.forEach((l, i) => {
    const seq = i + 1;
    const paths = Object.keys(l.changes);
    for (const [path, text] of Object.entries(l.changes)) {
      const before = tree.get(path) ?? null;
      const after = text === null ? null : blobOf(text);
      if (after === null) tree.delete(path);
      else tree.set(path, after);
      rows.push({ seq, path, landingId: l.id, before, after });
    }
    const landing = { id: l.id, colonyId: "c", trunkSha: `t${seq}`.padEnd(40, "0"), parentSha: `t${seq - 1}`.padEnd(40, "0"), proposalIds: [`prp_${seq}`], intentIds: [`int_${seq}`], paths, regions: [], at: seq } as Landing;
    const writeSet = rows.filter((r) => r.seq === seq).map((r) => ({ path: r.path, blob: r.after }));
    const readSet = Object.entries(l.reads ?? {}).map(([path, text]) => ({ path, blob: text === null ? null : blobOf(text) }));
    const note = { schema: "firetrident.lineage/v1", landingId: l.id, colonyId: "c", proposals: [{ id: `prp_${seq}`, agentId: "a", agentKind: "internal", intent: { id: `int_${seq}`, title: l.id, why: "" }, writeSet, readSet, decisions: [], evidence: { checks: [] } }] } as unknown as LineageNote;
    meta.set(seq, { landing, note });
  });
  const of = (r: (typeof rows)[number]) => ({ seq: r.seq, ...meta.get(r.seq)!, before: r.before, after: r.after });
  const src = {
    reads: 0,
    blobOf,
    history: (path: Path, limit: number) => rows.filter((r) => r.path === path).reverse().slice(0, limit).map(of),
    steps: (path: Path, before: number, limit: number) =>
      rows
        .filter((r) => r.path === path && r.seq < before)
        .reverse()
        .slice(0, limit)
        .map((r) => ({ seq: r.seq, landingId: r.landingId, before: r.before, after: r.after })),
    row: (seq: number, path: Path) => {
      const r = rows.find((x) => x.seq === seq && x.path === path);
      return r ? of(r) : null;
    },
    paths: (seq: number) => rows.filter((r) => r.seq === seq).map((r) => ({ path: r.path, before: r.before, after: r.after })),
    current: (path: Path) => tree.get(path) ?? null,
    since: (path: Path, seq: number) => {
      const later = rows.filter((r) => r.path === path && r.seq > seq);
      return later.length > 0 ? { by: later[later.length - 1]!.landingId, landings: later.length } : null;
    },
    read: async (blob: Sha) => {
      src.reads++;
      const t = blobs.get(blob);
      return t === undefined ? null : new TextEncoder().encode(t);
    },
    now: () => (clock.t += clock.step),
  };
  return src;
}

const lines = (...l: string[]): string => `${l.join("\n")}\n`;
const SEED = lines("export function price(item) {", "  return item.cost * 2;", "}");

describe("the walk for one line", () => {
  it("skips a formatting-only landing and lists it under the landing that wrote the line", async () => {
    const src = log({ "src/p.ts": SEED }, [
      { id: "lnd_meaning", changes: { "src/p.ts": lines("export function price(item) {", "  return item.cost * 3 + 'x';", "}") } },
      { id: "lnd_fmt", changes: { "src/p.ts": lines("export function price(item) {", '    return item.cost*3 + "x"', "}") } },
    ]);
    const found = await walkLine(src, "src/p.ts", 2);
    expect(found?.walk).toEqual({ landingId: "lnd_meaning", path: "src/p.ts", line: 2, skipped: [{ landingId: "lnd_fmt", path: "src/p.ts" }], moved: [] });
    const answer = await whyLineage(src, "src/p.ts", 2, 50);
    expect(answer.map((e) => e.landing.id)).toEqual(["lnd_meaning", "lnd_fmt"]);
    expect(answer[0]!.walk?.landingId).toBe("lnd_meaning");
    expect(answer[1]!.walk).toBeUndefined();
  });

  // Each kind of formatting a landing may do to the line, after the landing that wrote it: the line asked, in the reformatted file.
  const KINDS: Array<[string, string, string, number]> = [
    ["whitespace", lines("const total = price * count;"), lines("const total=price  *  count;"), 1],
    ["quote style", lines("const name = 'fire';"), lines('const name = "fire";'), 1],
    ["a trailing comma", lines("const list = [", "  first,", "  second", "];"), lines("const list = [", "  first,", "  second,", "];"), 3],
    ["a semicolon", lines("const total = price * count;"), lines("const total = price * count"), 1],
    ["line wrapping", lines("const r = call(first, second);"), lines("const r = call(", "  first,", "  second", ");"), 3],
  ];
  for (const [kind, meaning, reformatted, line] of KINDS) {
    it(`skips a landing that only changed ${kind}`, async () => {
      const src = log({ "src/k.ts": lines("// start") }, [
        { id: "lnd_meaning", changes: { "src/k.ts": meaning } },
        { id: "lnd_fmt", changes: { "src/k.ts": reformatted } },
      ]);
      const found = await walkLine(src, "src/k.ts", line);
      expect(found?.walk.landingId).toBe("lnd_meaning");
      expect(found?.walk.skipped).toEqual([{ landingId: "lnd_fmt", path: "src/k.ts" }]);
    });
  }

  it("says the line came with the files when every landing on it only reformatted it", async () => {
    const src = log({ "src/p.ts": SEED }, [{ id: "lnd_fmt", changes: { "src/p.ts": lines("export function price(item) {", "  return item.cost * 2", "}") } }]);
    const answer = await whyLineage(src, "src/p.ts", 2, 50);
    expect(answer.map((e) => e.landing.id)).toEqual(["lnd_fmt"]);
    expect(answer[0]!.walk).toEqual({ path: "src/p.ts", line: 2, skipped: [{ landingId: "lnd_fmt", path: "src/p.ts" }], moved: [] });
  });

  it("follows a block moved from another file back to the landing that wrote it there", async () => {
    const helper = ["export function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i.price;", "  return sum;", "}"];
    const util = lines("export const a = 1;", ...helper);
    const src = log({ "src/util.ts": lines("export const a = 1;"), "src/other.ts": lines("x") }, [
      { id: "lnd_wrote", changes: { "src/util.ts": util } },
      { id: "lnd_noise", changes: { "src/other.ts": lines("y") } },
      // The move: the block leaves util.ts and lands in total.ts, its quotes and semicolons reformatted on the way.
      { id: "lnd_move", changes: { "src/util.ts": lines("export const a = 1;"), "src/total.ts": lines("// totals", ...helper.map((l) => l.replace(/;$/, ""))) } },
    ]);
    const found = await walkLine(src, "src/total.ts", 4);
    expect(found?.walk).toEqual({ landingId: "lnd_wrote", path: "src/util.ts", line: 4, skipped: [], moved: [{ landingId: "lnd_move", from: "src/util.ts", to: "src/total.ts", line: 4 }] });
    const answer = await whyLineage(src, "src/total.ts", 4, 50);
    // The landing that wrote it in the other file comes first, then the file's own landings.
    expect(answer.map((e) => e.landing.id)).toEqual(["lnd_wrote", "lnd_move"]);
    expect(answer[0]!.holds?.wrote).toEqual({ path: "src/util.ts", state: "changed", by: "lnd_move", landings: 1 });
  });

  it("does not follow a block the other file kept (a copy, not a move)", async () => {
    const helper = ["export function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i.price;", "  return sum;", "}"];
    const src = log({ "src/util.ts": lines(...helper), "src/x.ts": lines("x") }, [{ id: "lnd_copy", changes: { "src/total.ts": lines(...helper), "src/x.ts": lines("y") } }]);
    expect((await walkLine(src, "src/total.ts", 3))?.walk).toEqual({ landingId: "lnd_copy", path: "src/total.ts", line: 3, skipped: [], moved: [] });
  });

  it("stops after WHY_WALK_STEPS landings and fails open with the oldest landing it found that changed the line", async () => {
    // Each landing flips the line's quotes: every one of them only reformats it.
    const quoted = (q: string) => lines(`export const name = ${q}fire${q};`);
    const landings: Spec[] = Array.from({ length: WHY_WALK_STEPS + 5 }, (_, i) => ({ id: `lnd_${i + 1}`, changes: { "src/n.ts": quoted(i % 2 === 0 ? '"' : "'") } }));
    const src = log({ "src/n.ts": quoted("'") }, landings);
    const found = await walkLine(src, "src/n.ts", 1);
    expect(found?.walk.bounded).toBe(`it stepped through ${WHY_WALK_STEPS} landings`);
    expect(found?.walk.skipped).toHaveLength(WHY_WALK_STEPS - 1);
    expect(found?.walk.landingId).toBe(`lnd_${landings.length - WHY_WALK_STEPS + 1}`);
    expect(found?.walk.skipped.map((s) => s.landingId)).not.toContain(found?.walk.landingId);
  });

  it("stops after WHY_WALK_MS and fails open with what it found", async () => {
    const quoted = (q: string) => lines(`export const name = ${q}fire${q};`);
    const clock = { t: 0, step: WHY_WALK_MS * 0.4 };
    const src = log({ "src/n.ts": quoted("'") }, [1, 2, 3, 4, 5].map((i) => ({ id: `lnd_${i}`, changes: { "src/n.ts": quoted(i % 2 === 1 ? '"' : "'") } })), clock);
    const found = await walkLine(src, "src/n.ts", 1);
    expect(found?.walk.bounded).toBe(`it ran for ${WHY_WALK_MS / 1000} s`);
    expect(found?.walk.landingId).toBe("lnd_4");
    expect(found?.walk.skipped).toEqual([{ landingId: "lnd_5", path: "src/n.ts" }]);
  });

  it("has no walk for a line past the end of the file, and lists the landings newest first", async () => {
    const src = log({ "src/p.ts": SEED }, [{ id: "lnd_1", changes: { "src/p.ts": lines("a") } }, { id: "lnd_2", changes: { "src/p.ts": lines("b") } }]);
    expect(await walkLine(src, "src/p.ts", 40)).toBeNull();
    const answer = await whyLineage(src, "src/p.ts", 40, 50);
    expect(answer.map((e) => [e.landing.id, e.walk])).toEqual([
      ["lnd_2", undefined],
      ["lnd_1", undefined],
    ]);
  });
});

describe("whether a landing still holds", () => {
  it("says a landing still holds as written, and names what changed a later file and a file it read", async () => {
    const src = log({ "src/a.ts": lines("a"), "src/b.ts": lines("b"), "src/c.ts": lines("c") }, [
      { id: "lnd_1", changes: { "src/a.ts": lines("a1"), "src/b.ts": lines("b1") }, reads: { "src/c.ts": lines("c") } },
      { id: "lnd_2", changes: { "src/b.ts": lines("b2") } },
      { id: "lnd_3", changes: { "src/c.ts": lines("c3") } },
    ]);
    const [first] = await whyLineage(src, "src/a.ts", undefined, 50);
    expect(first!.holds).toEqual({
      wrote: { path: "src/a.ts", state: "same" },
      others: {
        files: 2,
        changed: 2,
        list: [
          { path: "src/b.ts", state: "changed", by: "lnd_2", landings: 1 },
          { path: "src/c.ts", state: "changed", by: "lnd_3", landings: 1 },
        ],
      },
    });
  });

  it("says a file changed or deleted since, by the newest landing and how many", async () => {
    const src = log({ "src/a.ts": lines("a") }, [
      { id: "lnd_1", changes: { "src/a.ts": lines("a1") } },
      { id: "lnd_2", changes: { "src/a.ts": lines("a2") } },
      { id: "lnd_3", changes: { "src/a.ts": lines("a3") } },
    ]);
    const answer = await whyLineage(src, "src/a.ts", undefined, 50);
    expect(answer.map((e) => e.holds?.wrote)).toEqual([
      { path: "src/a.ts", state: "same" },
      { path: "src/a.ts", state: "changed", by: "lnd_3", landings: 1 },
      { path: "src/a.ts", state: "changed", by: "lnd_3", landings: 2 },
    ]);
    const gone = log({ "src/a.ts": lines("a") }, [
      { id: "lnd_1", changes: { "src/a.ts": lines("a1") } },
      { id: "lnd_2", changes: { "src/a.ts": null } },
    ]);
    const row = gone.row(1, "src/a.ts")!;
    expect(holdsOf(gone, row, "src/a.ts").wrote).toEqual({ path: "src/a.ts", state: "deleted", by: "lnd_2", landings: 1 });
  });
});
