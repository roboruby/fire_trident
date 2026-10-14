import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { Id, Landing, Path, Proposal, Sha } from "@fire_trident/core";
import {
  HOLD_MS,
  MegafileAlarm,
  SPLIT_PRIORITY,
  collisionReason,
  holdReason,
  isHoldReason,
  megafileEnabled,
  namesPath,
  splitFootprint,
  watchedPath,
  type MegafileHost,
  type SplitIntentInput,
  type SqlRunner,
} from "../../src/colony/megafile.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const NOW = 10_000_000_000;
const MIN = 60_000;
const BIG = "src/big.ts";

/** A text of `n` lines. */
function text(n: number, tag = "v"): string {
  return Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};\n`).join("");
}

/** A write set naming these paths. */
function writes(...paths: Path[]): Array<{ path: Path; blob: Sha }> {
  return paths.map((path) => ({ path, blob: "f".repeat(40) }));
}

/** One colony's alarm over an in-memory store and a fake colony: proposals, intents, trunk files, the clock. */
function colony(opts: { on?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
  const state = {
    on: opts.on ?? true,
    now: NOW,
    intents: new Map<Id, { status: string; reported: boolean }>(),
    proposals: new Map<Id, Proposal>(),
    contents: new Map<Id, Record<Sha, string>>(),
    trunk: new Map<Path, string>(),
    declared: [] as Array<SplitIntentInput & { id: Id }>,
    sentBack: [] as Array<{ id: Id; reason: string }>,
    inFlight: new Map<Path, Array<{ id: Id; intentId: Id }>>(),
    reads: [] as Path[],
    waiting: [] as Array<Promise<unknown>>,
  };
  const host: MegafileHost = {
    sql,
    enabled: () => state.on,
    now: () => state.now,
    proposal: (id) => state.proposals.get(id) ?? null,
    contents: (id) => state.contents.get(id) ?? null,
    intent: (id) => state.intents.get(id) ?? null,
    declare: async (input) => {
      const id = `int_split_${state.declared.length + 1}`;
      state.declared.push({ ...input, id });
      state.intents.set(id, { status: "open", reported: false });
      return { id };
    },
    readFile: async (path) => {
      state.reads.push(path);
      return state.trunk.get(path) ?? null;
    },
    inFlight: (path, intentId) => (state.inFlight.get(path) ?? []).filter((p) => p.intentId !== intentId).map((p) => p.id),
    sendBack: async (items) => {
      state.sentBack.push(...items);
    },
    waitUntil: (p) => {
      state.waiting.push(p);
    },
  };
  const alarm = new MegafileAlarm(host);
  let n = 0;

  /** Wait for the work the alarm left running (evaluations, trunk reads). */
  async function settle(): Promise<void> {
    while (state.waiting.length > 0) await state.waiting.shift();
  }

  /**
   * One landing: `agentId`'s change writes these files (content null deletes) for `intentId`. Inline by default (the
   * colony keeps its texts); `merged` lands it as the trunk writer's merge (no change's text is what landed).
   */
  async function land(agentId: Id, files: Record<Path, string | null>, o: { intentId?: Id; inline?: boolean; merged?: boolean; advanceMs?: number } = {}): Promise<Landing> {
    state.now += o.advanceMs ?? MIN;
    const pid = `prp_${++n}`;
    const intentId = o.intentId ?? `int_${n}`;
    const writeSet = Object.entries(files).map(([path, t]) => ({ path, blob: t === null ? null : blobId(t) }));
    state.proposals.set(pid, { id: pid, colonyId: "c", intentId, agentId, writeSet, readSet: [], status: "ready", createdAt: state.now } as unknown as Proposal);
    if (o.inline !== false) state.contents.set(pid, Object.fromEntries(Object.values(files).filter((t): t is string => t !== null).map((t) => [blobId(t), t])));
    for (const [path, t] of Object.entries(files)) {
      if (t === null) state.trunk.delete(path);
      else state.trunk.set(path, t);
    }
    const l: Landing = {
      id: `lnd_${n}`,
      colonyId: "c",
      trunkSha: "a".repeat(40),
      parentSha: "b".repeat(40),
      proposalIds: [pid],
      intentIds: [intentId],
      paths: Object.keys(files),
      regions: ["src"],
      at: state.now,
      ...(o.merged ? { merged: Object.keys(files).map((path) => ({ proposalId: pid, path, blob: "c".repeat(40) })) } : {}),
    };
    alarm.landed(l);
    // The colony settles the landing's intents right after the alarm's hook (a landed split is no longer live).
    if (state.intents.has(intentId)) state.intents.set(intentId, { status: "landed", reported: false });
    await settle();
    return l;
  }

  /** A change that went back with this reason, having written `writes` and read `reads`. */
  function back(reason: string, writes: Path[], reads: Path[] = []): Proposal {
    const id = `prp_${++n}`;
    return { id, intentId: `int_${n}`, agentId: `a${n}`, status: "returned", reason, writeSet: writes.map((path) => ({ path, blob: "d".repeat(40) })), readSet: reads.map((path) => ({ path, blob: "e".repeat(40) })) } as unknown as Proposal;
  }

  /** Grow BIG from 650 lines by `step` per landing, one agent each, `count` landings after the seed (a0). */
  async function grow(count: number, step = 45): Promise<void> {
    let lines = 650;
    await land("a0", { [BIG]: text(lines) });
    for (let i = 1; i <= count; i++) {
      lines += step;
      await land(`a${i}`, { [BIG]: text(lines) });
    }
  }

  const tables = (): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  const rows = (q: string, ...b: unknown[]): unknown[] => db.prepare(q).all(...b);
  return { alarm, state, land, back, grow, settle, tables, rows };
}

describe("FT_MEGAFILE and the files it watches", () => {
  it("is off when absent or off, on for every colony or the listed ones", () => {
    for (const s of [undefined, "", "off", " OFF "]) expect(megafileEnabled(s, "c1")).toBe(false);
    expect(megafileEnabled("on", "c1")).toBe(true);
    expect(megafileEnabled("c2, c1", "c1")).toBe(true);
    expect(megafileEnabled("c2", "c1")).toBe(false);
  });

  it("watches JavaScript and TypeScript sources, not tests or other files", () => {
    for (const p of ["src/big.ts", "a.js", "lib/x.mjs", "ui/App.tsx", "y.cts"]) expect(watchedPath(p)).toBe(true);
    for (const p of ["test/big.ts", "src/big.test.ts", "src/__tests__/a.ts", "README.md", "package.json", "src/style.css"]) expect(watchedPath(p)).toBe(false);
  });

  it("names a held file in the reason a change goes back with", () => {
    const reason = holdReason(BIG, "int_9");
    expect(reason).toBe("src/big.ts is being split by intent int_9; take again after it lands");
    expect(isHoldReason(reason)).toBe(true);
    expect(isHoldReason("stale: src/big.ts")).toBe(false);
  });

  it("counts collisions only: stale reads and writes and conflicts, not review, direction or holds", () => {
    expect(collisionReason("stale: 1 path changed on trunk since read: src/big.ts")).toBe(true);
    expect(collisionReason("conflicts with another proposal in this landing on src/big.ts")).toBe(true);
    expect(collisionReason("conflict at land time: src/big.ts")).toBe(true);
    for (const r of ["llm: src/big.ts does not compile", "withdrawn: not needed", "intent revised: r1 → r2", "superseded: recalled", holdReason(BIG, "int_1"), undefined]) {
      expect(collisionReason(r)).toBe(false);
    }
  });

  it("finds a path only as a whole path", () => {
    expect(namesPath("stale: src/big.ts (read 1a2b, now 3c4d)", BIG)).toBe(true);
    expect(namesPath("conflicts on src/big.ts.", BIG)).toBe(true);
    expect(namesPath("src/big.ts", BIG)).toBe(true);
    expect(namesPath("stale: src/big.tsx", BIG)).toBe(false);
    expect(namesPath("stale: lib/src/big.ts", BIG)).toBe(false);
    expect(namesPath("stale: src/big.ts.bak", BIG)).toBe(false);
    expect(namesPath("stale: src/big.tsx and src/big.ts", BIG)).toBe(true);
  });

  it("gives the split the file, new files beside it and a directory named after it", () => {
    expect(splitFootprint(BIG)).toEqual(["src/big.ts", "src/*", "src/big/**"]);
    expect(splitFootprint("big.module.ts")).toEqual(["big.module.ts", "*", "big.module/**"]);
  });
});

describe("the alarm while FT_MEGAFILE is off", () => {
  it("records nothing, holds nothing and makes no table", async () => {
    const c = colony({ on: false });
    await c.grow(6);
    c.alarm.returned([c.back("stale: src/big.ts", [BIG])]);
    expect(c.state.declared).toEqual([]);
    expect(c.alarm.report()).toBeNull();
    const rows = [{ id: "int_1", fp: [BIG] }];
    expect(c.alarm.offerable(rows, (r) => r.fp)).toEqual({ rows });
    expect(c.alarm.heldBack(writes(BIG), "int_1")).toBeNull();
    expect(c.tables().filter((t) => t.startsWith("megafile"))).toEqual([]);
    await expect(c.alarm.holdByHand(BIG, "maya")).rejects.toThrow(/\[ft:409\] the megafile alarm is off/);
    expect(() => c.alarm.release(BIG, "maya")).toThrow(/\[ft:409\]/);
  });
});

describe("a file that grew among many writers", () => {
  it("is held once it grew a quarter with five agents writing it, and its split intent says why", async () => {
    const c = colony();
    // 650 → 785 lines with four writers (the seed's included): 21%, not yet.
    await c.grow(3);
    expect(c.state.declared).toEqual([]);
    c.state.inFlight.set(BIG, [
      { id: "prp_ready", intentId: "int_other" },
      { id: "prp_split_own", intentId: "int_split_1" },
    ]);
    await c.land("a4", { [BIG]: text(830) });
    expect(c.state.declared).toHaveLength(1);
    const split = c.state.declared[0]!;
    expect(split).toMatchObject({
      id: "int_split_1",
      title: "Split src/big.ts into smaller modules",
      source: "system",
      priority: SPLIT_PRIORITY,
      createdBy: "megafile",
      footprint: ["src/big.ts", "src/*", "src/big/**"],
      acceptance: ["Every name src/big.ts exports today is still exported from src/big.ts (re-export what moved), so no import of it changes", "The tests pass"],
    });
    expect(split.why).toContain("src/big.ts has 830 lines, up from 650 (28%) in the last 30 minutes, and changes from 5 agents landed on it in that time.");
    expect(split.why).toContain("re-export what moved from src/big.ts");
    expect(split.why).toContain("Until this lands (at most 60 minutes), no other change may write src/big.ts.");
    const report = c.alarm.report()!;
    expect(report.held).toEqual([
      expect.objectContaining({ path: BIG, intentId: "int_split_1", by: "colony", signal: "growth", lines: 830, baseline: 650, agents: 5, returns: 0, until: report.held[0]!.at + HOLD_MS }),
    ]);
    expect(report.held[0]!.growth).toBeCloseTo(180 / 650);
    // The change already on its way that writes the file goes back; the split's own does not.
    expect(c.state.sentBack).toEqual([{ id: "prp_ready", reason: "src/big.ts is being split by intent int_split_1; take again after it lands" }]);
  });

  it("offers no other intent whose footprint covers the held file, and sends back a change that writes it", async () => {
    const c = colony();
    await c.grow(4);
    const rows = [
      { id: "int_split_1", fp: splitFootprint(BIG) },
      { id: "int_exact", fp: [BIG] },
      { id: "int_dir", fp: ["src/"] },
      { id: "int_glob", fp: ["src/**/*.ts"] },
      { id: "int_other", fp: ["src/other.ts", "lib/x.ts"] },
    ];
    expect(c.alarm.offerable(rows, (r) => r.fp).rows.map((r) => r.id)).toEqual(["int_split_1", "int_other"]);
    expect(c.alarm.offerable(rows.slice(1, 4), (r) => r.fp)).toEqual({
      rows: [],
      reason: "every open intent covers a file being split: src/big.ts is being split by intent int_split_1; take again after it lands",
    });
    expect(c.alarm.heldBack(writes(BIG), "int_exact")).toBe("src/big.ts is being split by intent int_split_1; take again after it lands");
    expect(c.alarm.heldBack(writes("src/other.ts", BIG), "int_other")).toMatch(/^src\/big\.ts is being split/);
    expect(c.alarm.heldBack(writes(BIG, "src/big-a.ts"), "int_split_1")).toBeNull();
    expect(c.alarm.heldBack(writes("src/other.ts"), "int_other")).toBeNull();
  });

  it("has the split's change record the file's lines before and after it, for its lineage note", async () => {
    const c = colony();
    await c.grow(4);
    const index = 'export * from "./big-a.ts";\n';
    const write = [{ path: BIG, blob: blobId(index) }, { path: "src/big-a.ts", blob: blobId(text(830)) }];
    expect(c.alarm.splitCheck("int_split_1", write, { [blobId(index)]: index })).toEqual({
      name: "megafile: split",
      ok: true,
      ms: 0,
      detail: "src/big.ts: 830 lines when it was held (650 when its window opened); 1 line after this change",
    });
    expect(c.alarm.splitCheck("int_split_1", write, null)?.detail).toBe("src/big.ts: 830 lines when it was held (650 when its window opened); its length after this change is not known (a pushed commit)");
    expect(c.alarm.splitCheck("int_split_1", [{ path: "src/big-a.ts", blob: blobId(text(830)) }], null)?.detail).toMatch(/; this change leaves it as it was$/);
    expect(c.alarm.splitCheck("int_other", write, null)).toBeNull();
    c.state.on = false;
    expect(c.alarm.splitCheck("int_split_1", write, null)).toBeNull();
  });

  it("offers the splits of two held files in one directory, though each split's footprint covers the other file", async () => {
    const c = colony();
    c.state.trunk.set("src/a.ts", text(700));
    c.state.trunk.set("src/b.ts", text(900));
    const a = (await c.alarm.holdByHand("src/a.ts", "maya")).hold.intentId;
    const b = (await c.alarm.holdByHand("src/b.ts", "maya")).hold.intentId;
    const rows = [
      { id: a, fp: splitFootprint("src/a.ts") },
      { id: b, fp: splitFootprint("src/b.ts") },
      { id: "int_b", fp: ["src/b.ts"] },
    ];
    expect(c.alarm.offerable(rows, (r) => r.fp).rows.map((r) => r.id)).toEqual([a, b]);
    // A split that writes the other held file still goes back.
    expect(c.alarm.heldBack(writes("src/a.ts", "src/b.ts"), a)).toBe(holdReason("src/b.ts", b));
  });

  it("fails open: holds it cannot read keep no work from being offered or proposed", async () => {
    const c = colony();
    await c.grow(4);
    c.rows("DROP TABLE megafile_holds");
    c.state.now += 2_000;
    const rows = [{ id: "int_exact", fp: [BIG] }];
    expect(c.alarm.offerable(rows, (r) => r.fp).rows).toEqual(rows);
    expect(c.alarm.heldBack(writes(BIG), "int_exact")).toBeNull();
  });

  it("does not count one agent writing its own file, or growth outside the window", async () => {
    const solo = colony();
    for (let i = 0; i < 6; i++) await solo.land("a1", { [BIG]: text(650 + 100 * i) });
    expect(solo.state.declared).toEqual([]);
    const slow = colony();
    let lines = 650;
    await slow.land("a0", { [BIG]: text(lines) });
    for (let i = 1; i <= 5; i++) await slow.land(`a${i}`, { [BIG]: text((lines += 45)) }, { advanceMs: 10 * MIN });
    expect(slow.state.declared).toEqual([]);
  });
});

describe("the hold lifts", () => {
  it("when the split lands: the file's length after it is kept and the file starts afresh", async () => {
    const c = colony();
    await c.grow(4);
    await c.land("splitter", { [BIG]: text(120, "re"), "src/big-a.ts": text(400, "a"), "src/big-b.ts": text(320, "b") }, { intentId: "int_split_1" });
    const report = c.alarm.report()!;
    expect(report.held).toEqual([]);
    expect(report.lifted).toEqual([expect.objectContaining({ path: BIG, intentId: "int_split_1", lifted: "landed", lines: 830, linesAfter: 120 })]);
    expect(c.alarm.heldBack(writes(BIG), "int_x")).toBeNull();
    expect(c.alarm.offerable([{ id: "int_x", fp: [BIG] }], (r) => r.fp).rows).toHaveLength(1);
    // Only the split's landing is left, as the next window's baseline.
    expect(c.rows("SELECT landing_id, lines FROM megafile_writes WHERE path = ?", BIG)).toEqual([{ landing_id: "lnd_6", lines: 120 }]);
    // Writers after the split start a new count.
    for (let i = 5; i < 9; i++) await c.land(`a${i}`, { [BIG]: text(130 + i) });
    expect(c.state.declared).toHaveLength(1);
  });

  it("when the split landed as a merge: its length after it is read from trunk", async () => {
    const c = colony();
    await c.grow(4);
    c.state.reads.length = 0;
    await c.land("splitter", { [BIG]: text(90, "re"), "src/big-a.ts": text(800, "a") }, { intentId: "int_split_1", merged: true });
    expect(c.state.reads).toEqual([BIG]);
    expect(c.alarm.report()!.lifted[0]).toMatchObject({ lifted: "landed", linesAfter: 90 });
  });

  it("when the split intent is withdrawn or reported, or after an hour; and its live split keeps the file from a second one", async () => {
    for (const [end, reason] of [
      ["withdrawn", "withdrawn"],
      ["reported", "escalated"],
      ["expired", "expired"],
    ] as const) {
      const c = colony();
      await c.grow(4);
      const held = c.alarm.report()!.held[0]!;
      if (end === "withdrawn") c.state.intents.set("int_split_1", { status: "withdrawn", reported: false });
      if (end === "reported") c.state.intents.set("int_split_1", { status: "open", reported: true });
      c.state.now += end === "expired" ? HOLD_MS : 2_000;
      expect(c.alarm.heldBack(writes(BIG), "int_x")).toBeNull();
      expect(c.alarm.report()!.lifted[0]).toMatchObject({ path: BIG, lifted: reason, liftedAt: end === "expired" ? held.until : c.state.now });
      if (end === "expired") {
        // The split intent is still open: the file grows hot again, but no second split is declared.
        await c.grow(4);
        expect(c.state.declared).toHaveLength(1);
        expect(c.alarm.report()!.held).toEqual([]);
      }
    }
  });

  it("when a person releases it; a person's hold reuses a live split intent", async () => {
    const c = colony();
    c.state.trunk.set(BIG, text(700));
    const first = await c.alarm.holdByHand(BIG, "maya");
    expect(first).toMatchObject({ already: false, hold: { path: BIG, intentId: "int_split_1", by: "maya", signal: "person", lines: 700 } });
    expect(c.state.declared[0]!.why).toMatch(/^maya asked for src\/big\.ts to be split\. It has 700 lines\./);
    expect(await c.alarm.holdByHand(` ./${BIG} `, "maya")).toMatchObject({ already: true, hold: { intentId: "int_split_1" } });
    const released = c.alarm.release(BIG, "maya");
    expect(released).toMatchObject({ path: BIG, lifted: "released by maya" });
    expect(c.alarm.release(BIG, "maya")).toBeNull();
    expect(c.alarm.heldBack(writes(BIG), "int_x")).toBeNull();
    // Its split intent is still open: holding the file again waits for it, with no second intent.
    expect(await c.alarm.holdByHand(BIG, "sam")).toMatchObject({ already: false, hold: { intentId: "int_split_1", by: "sam" } });
    expect(c.state.declared).toHaveLength(1);
  });

  it("refuses a person's hold on a file not on trunk, or on a glob or a directory", async () => {
    const c = colony();
    await expect(c.alarm.holdByHand("src/missing.ts", "maya")).rejects.toThrow(/\[ft:404\] src\/missing\.ts is not on trunk/);
    for (const p of ["src/*.ts", "src/", "../x.ts", ""]) await expect(c.alarm.holdByHand(p, "maya")).rejects.toThrow(/\[ft:400\]/);
    expect(c.state.declared).toEqual([]);
  });
});

describe("a file changes keep colliding on", () => {
  it("is held after six changes that wrote it went back colliding on it; reads, review verdicts, holds and redirects do not count", async () => {
    const c = colony();
    const hub = "src/hub.ts";
    c.alarm.returned([
      c.back("stale: 1 path changed on trunk since read: src/hub.ts", [hub]),
      c.back("stale: src/hub.ts read 1a, now 2b", ["src/a.ts"], [hub]),
      c.back("conflicts with another proposal in this landing on src/hub.ts", [hub]),
      c.back("llm: src/hub.ts does not compile", [hub]),
      c.back(holdReason(hub, "int_0"), [hub]),
      c.back("withdrawn: src/hub.ts is not needed", [hub]),
      c.back("stale: src/hub.tsx changed", ["src/hub.tsx", hub]),
      c.back("stale: src/hub.ts changed", ["src/hub.test.ts"], ["README.md"]),
    ]);
    await c.settle();
    expect(c.state.declared).toEqual([]);
    expect(c.rows("SELECT COUNT(*) AS n FROM megafile_returns WHERE path = ?", hub)).toEqual([{ n: 2 }]);
    c.state.now += 20 * MIN;
    c.alarm.returned([c.back("stale: src/hub.ts", [hub]), c.back("conflict at land time: src/hub.ts", [hub])]);
    await c.settle();
    expect(c.state.declared).toEqual([]);
    c.alarm.returned([{ ...c.back("stale: src/hub.ts", [hub]), status: "rejected" } as Proposal, c.back("stale: src/hub.ts", [hub])]);
    await c.settle();
    expect(c.state.declared).toEqual([]);
    c.alarm.returned([c.back("stale: src/hub.ts (text merge: conflicting hunks at lines 12-14)", [hub])]);
    await c.settle();
    expect(c.state.declared).toHaveLength(1);
    expect(c.state.declared[0]!.why).toMatch(/^6 changes that wrote src\/hub\.ts went back in the last 30 minutes because they collided on it \(stale versions or conflicts\)\./);
    expect(c.alarm.report()!.held[0]).toMatchObject({ path: hub, signal: "returns", returns: 6 });
  });
});

describe("the length of a file no change's text gave", () => {
  it("is read from trunk, for a file that already has enough writers only", async () => {
    const c = colony();
    await c.land("a0", { [BIG]: text(650) });
    let lines = 650;
    for (let i = 1; i <= 2; i++) await c.land(`a${i}`, { [BIG]: text((lines += 45)) }, { merged: true });
    expect(c.state.reads).toEqual([]);
    // A fourth writer: the newest length is read (785, 21%: not yet).
    await c.land("a3", { [BIG]: text((lines += 45)) }, { merged: true });
    expect(c.state.reads).toEqual([BIG]);
    expect(c.state.declared).toEqual([]);
    await c.land("a4", { [BIG]: text((lines += 45)) }, { inline: false });
    expect(c.state.reads).toEqual([BIG, BIG]);
    expect(c.state.declared).toHaveLength(1);
    expect(c.alarm.report()!.held[0]).toMatchObject({ lines: 830, baseline: 650, agents: 5 });
  });

  it("counts every writer of a landing that two changes wrote, and reads the length those changes left", async () => {
    const c = colony();
    await c.land("a0", { [BIG]: text(650) });
    for (const [first, second, lines] of [
      ["a1", "a2", 740],
      ["a3", "a4", 830],
    ] as const) {
      const one = await c.land(first, { [BIG]: text(lines - 45) });
      // A second change of the same landing wrote the file too (the trunk writer merged it): neither text is what landed.
      c.state.proposals.set(`${one.proposalIds[0]}_b`, { ...c.state.proposals.get(one.proposalIds[0]!)!, id: `${one.proposalIds[0]}_b`, agentId: second });
      c.state.trunk.set(BIG, text(lines));
      c.rows("DELETE FROM megafile_writes WHERE landing_id = ?", one.id);
      c.alarm.landed({ ...one, proposalIds: [one.proposalIds[0]!, `${one.proposalIds[0]}_b`] });
      await c.settle();
    }
    expect(c.state.reads).toEqual([BIG]);
    expect(c.state.declared).toHaveLength(1);
    expect(c.alarm.report()!.held[0]).toMatchObject({ lines: 830, baseline: 650, agents: 5 });
  });

  it("is not known when two changes of one landing wrote the file, or a commit no change wrote changed it", async () => {
    const c = colony();
    await c.land("a0", { [BIG]: text(650) });
    const l = await c.land("a1", { [BIG]: text(700) });
    expect(c.rows("SELECT lines, agents FROM megafile_writes WHERE landing_id = ?", l.id)).toEqual([{ lines: 700, agents: '["a1"]' }]);
    c.alarm.landed({ ...l, id: "lnd_revert", proposalIds: [], intentIds: [], paths: [BIG, "README.md"] });
    expect(c.rows("SELECT path, lines, agents FROM megafile_writes WHERE landing_id = 'lnd_revert'")).toEqual([{ path: BIG, lines: null, agents: "[]" }]);
    c.state.proposals.set("prp_twin", { ...c.state.proposals.get("prp_2")!, id: "prp_twin", agentId: "a2" });
    c.alarm.landed({ ...l, id: "lnd_twins", proposalIds: ["prp_2", "prp_twin"] });
    expect(c.rows("SELECT lines, agents FROM megafile_writes WHERE landing_id = 'lnd_twins'")).toEqual([{ lines: null, agents: '["a1","a2"]' }]);
  });
});

describe("stored signals", () => {
  it("keep only the window, and each file's newest known length before it", async () => {
    const c = colony();
    await c.land("a0", { [BIG]: text(500) }, { advanceMs: 0 });
    await c.land("a1", { [BIG]: text(520) }, { advanceMs: 10 * MIN });
    await c.land("a2", { [BIG]: text(540) }, { advanceMs: 10 * MIN, merged: true });
    c.alarm.returned([c.back("stale: src/big.ts", [BIG])]);
    await c.settle();
    // An hour later the next landing prunes: the newest landing with a known length stays as the baseline.
    await c.land("a3", { [BIG]: text(560) }, { advanceMs: 60 * MIN });
    expect(c.rows("SELECT landing_id, lines FROM megafile_writes ORDER BY at")).toEqual([
      { landing_id: "lnd_2", lines: 520 },
      { landing_id: "lnd_5", lines: 560 },
    ]);
    expect(c.rows("SELECT COUNT(*) AS n FROM megafile_returns")).toEqual([{ n: 0 }]);
  });
});
