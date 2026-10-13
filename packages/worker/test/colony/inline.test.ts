import { describe, expect, it } from "vitest";
import type { Colony, FileVersion, Proposal, Sha } from "@fire_trident/core";
import { INLINE_LIMITS, blobId, changesetId } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { CONTENTS_GRACE_MS, InlineContents, inlineEnabled, inlineOffered, inlineRefusal, isInlineChange, migrateContents, type SqlRunner } from "../../src/colony/inline.ts";
import { contentsReader, runInnateChecks, type BlobReader } from "../../src/colony/innate.ts";
import { loadDiffs } from "../../src/decide/contest.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** A fresh in-memory store, with the table migrated in. */
function store(): { contents: InlineContents; rows: (q: string, ...b: unknown[]) => unknown[] } {
  const db = new DatabaseSync(":memory:");
  // Like a Durable Object's storage, a statement runs when it is executed (its rows are read later).
  const sql: SqlRunner = {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
  migrateContents(sql);
  migrateContents(sql); // additive and repeatable
  return { contents: new InlineContents(sql), rows: (q, ...b) => db.prepare(q).all(...b) };
}

const BASE = "b".repeat(40);
const A_TS = "export const a = 1;\n";
const B_TS = "export const b = 2;\n";

/** An inline change over BASE writing these files (content null deletes). */
function change(files: Record<string, string | null>): { writeSet: FileVersion[]; contents: Record<Sha, string>; headSha: Sha } {
  const writeSet: FileVersion[] = [];
  const contents: Record<Sha, string> = {};
  for (const [path, text] of Object.entries(files)) {
    const blob = text === null ? null : blobId(text);
    writeSet.push({ path, blob });
    if (text !== null && blob) contents[blob] = text;
  }
  return { writeSet, contents, headSha: changesetId(BASE, writeSet) };
}

describe("FT_INLINE", () => {
  it("is off when absent or off, on for every colony or for the listed ones", () => {
    for (const setting of [undefined, "", "off", " OFF "]) {
      expect(inlineEnabled(setting, "c1")).toBe(false);
      expect(inlineOffered(setting)).toBe(false);
    }
    expect(inlineEnabled("on", "c1")).toBe(true);
    expect(inlineEnabled("c2, c1", "c1")).toBe(true);
    expect(inlineEnabled("c2", "c1")).toBe(false);
    expect(inlineOffered("on")).toBe(true);
    expect(inlineOffered("c2")).toBe(true);
    expect(inlineOffered(" , ")).toBe(false);
  });
});

describe("inline changes: what the colony accepts", () => {
  it("tells an inline change from a pushed commit by its head", () => {
    const c = change({ "src/a.ts": A_TS, "src/old.ts": null });
    expect(isInlineChange({ baseSha: BASE, headSha: c.headSha, writeSet: c.writeSet })).toBe(true);
    // The order of the write set does not matter; a commit id never matches.
    expect(isInlineChange({ baseSha: BASE, headSha: c.headSha, writeSet: [...c.writeSet].reverse() })).toBe(true);
    expect(isInlineChange({ baseSha: BASE, headSha: "c".repeat(40), writeSet: c.writeSet })).toBe(false);
    expect(isInlineChange({ baseSha: "a".repeat(40), headSha: c.headSha, writeSet: c.writeSet })).toBe(false);
    // More written files than an inline change may carry: never one, and no hashing is done.
    const many = Array.from({ length: INLINE_LIMITS.files + 1 }, (_, i) => ({ path: `f${i}.txt`, blob: blobId(String(i)) }));
    expect(isInlineChange({ baseSha: BASE, headSha: changesetId(BASE, many), writeSet: many })).toBe(false);
    expect(isInlineChange({ baseSha: BASE, headSha: undefined as unknown as Sha, writeSet: [] })).toBe(false);
  });

  it("accepts a valid change, a deletion included", () => {
    const c = change({ "src/a.ts": A_TS, "src/b.ts": B_TS, "src/old.ts": null });
    expect(inlineRefusal({ baseSha: BASE, headSha: c.headSha, writeSet: c.writeSet }, c.contents)).toBeNull();
    const del = change({ "src/old.ts": null });
    expect(inlineRefusal({ baseSha: BASE, headSha: del.headSha, writeSet: del.writeSet }, {})).toBeNull();
  });

  it("refuses a text that does not hash to its blob, a missing or extra text, and contents that are not a map", () => {
    const c = change({ "src/a.ts": A_TS });
    const blob = c.writeSet[0]!.blob!;
    expect(inlineRefusal({ baseSha: BASE, headSha: c.headSha, writeSet: c.writeSet }, { [blob]: B_TS })).toMatch(/^the contents of src\/a\.ts hash to [0-9a-f]{12}, not its blob/);
    expect(inlineRefusal({ baseSha: BASE, headSha: c.headSha, writeSet: c.writeSet }, {})).toMatch(/^no contents for src\/a\.ts/);
    expect(inlineRefusal({ baseSha: BASE, headSha: c.headSha, writeSet: c.writeSet }, { ...c.contents, [blobId(B_TS)]: B_TS })).toMatch(/which no written file uses/);
    for (const bad of [null, "text", [A_TS]]) expect(inlineRefusal({ baseSha: BASE, headSha: c.headSha, writeSet: c.writeSet }, bad)).toMatch(/contents must map/);
  });

  it("refuses a head that is not the changeset id of the base and write set", () => {
    const c = change({ "src/a.ts": A_TS });
    const refused = inlineRefusal({ baseSha: BASE, headSha: "c".repeat(40), writeSet: c.writeSet }, c.contents);
    expect(refused).toBe(`the head of an inline change is the changeset id of its base and write set (${c.headSha}), not ${"c".repeat(40)}`);
    expect(inlineRefusal({ baseSha: "a".repeat(40), headSha: c.headSha, writeSet: c.writeSet }, c.contents)).toMatch(/the head of an inline change is the changeset id/);
  });

  it("refuses a change over the limits: too many files, a file too large, too much in all, binary text", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= INLINE_LIMITS.files; i++) files[`f${i}.txt`] = `file ${i}\n`;
    const many = change(files);
    expect(inlineRefusal({ baseSha: BASE, headSha: many.headSha, writeSet: many.writeSet }, many.contents)).toMatch(/at most 64 files/);
    const big = change({ "big.txt": "x".repeat(INLINE_LIMITS.fileBytes + 1) });
    expect(inlineRefusal({ baseSha: BASE, headSha: big.headSha, writeSet: big.writeSet }, big.contents)).toMatch(/over the 262144-byte limit/);
    const half = "y".repeat(INLINE_LIMITS.fileBytes);
    const total = change({ "one.txt": half, "two.txt": `${half.slice(1)}z`, "three.txt": "w" });
    expect(inlineRefusal({ baseSha: BASE, headSha: total.headSha, writeSet: total.writeSet }, total.contents)).toMatch(/over the 524288-byte limit/);
    const nul = change({ "bin.dat": "a\0b" });
    expect(inlineRefusal({ baseSha: BASE, headSha: nul.headSha, writeSet: nul.writeSet }, nul.contents)).toMatch(/is not text/);
  });
});

describe("inline contents: the colony's table", () => {
  it("keeps each text by blob, and serves it back", () => {
    const { contents, rows } = store();
    const c = change({ "src/a.ts": A_TS, "src/b.ts": B_TS });
    contents.put("prp_1", c.contents);
    expect(contents.get("prp_1")).toEqual(c.contents);
    expect(contents.get("prp_other")).toBeNull();
    expect(rows("SELECT bytes FROM proposal_contents WHERE proposal_id = ? ORDER BY bytes", "prp_1").map((r) => (r as { bytes: number }).bytes)).toEqual([20, 20]);
  });

  it("drops a landed change's texts at once, and keeps a returned or rejected one's for the grace period", () => {
    const { contents } = store();
    for (const id of ["prp_landed", "prp_back", "prp_rejected", "prp_waiting"]) contents.put(id, change({ [`${id}.ts`]: `// ${id}\n` }).contents);
    const t0 = 1_000_000;
    contents.settle("prp_landed", "landed", t0);
    contents.settle("prp_back", "returned", t0);
    contents.settle("prp_rejected", "rejected", t0);
    contents.settle("prp_waiting", "escalated", t0); // waits for a person: kept
    expect(contents.get("prp_landed")).toBeNull();
    // A second settle (returned, then rejected) does not move the grace period on.
    contents.settle("prp_back", "rejected", t0 + CONTENTS_GRACE_MS - 1);
    contents.sweep(t0 + CONTENTS_GRACE_MS - 1, true);
    expect(contents.get("prp_back")).not.toBeNull();
    expect(contents.get("prp_rejected")).not.toBeNull();
    contents.sweep(t0 + CONTENTS_GRACE_MS, true);
    expect(contents.get("prp_back")).toBeNull();
    expect(contents.get("prp_rejected")).toBeNull();
    expect(contents.get("prp_waiting")).not.toBeNull();
  });

  it("sweeps at most once a minute unless forced", () => {
    const { contents } = store();
    const t0 = 1_000_000;
    contents.put("prp_1", change({ "a.txt": "a\n" }).contents);
    contents.settle("prp_1", "returned", t0);
    contents.sweep(t0 + CONTENTS_GRACE_MS - 10_000); // runs: nothing is past its grace yet
    contents.sweep(t0 + CONTENTS_GRACE_MS + 1); // past it, but within a minute of the last sweep: skipped
    expect(contents.get("prp_1")).not.toBeNull();
    contents.sweep(t0 + CONTENTS_GRACE_MS + 50_000);
    expect(contents.get("prp_1")).toBeNull();
  });

  it("answers the trunk writer within a byte budget, in the order asked, always with at least one change", () => {
    const { contents } = store();
    const texts = { prp_a: "a".repeat(100), prp_b: "b".repeat(100), prp_c: "c".repeat(50), prp_d: "d".repeat(10) };
    for (const [id, text] of Object.entries(texts)) contents.put(id, { [blobId(text)]: text });
    const all = contents.fetch(["prp_a", "prp_b", "prp_gone", "prp_c", "prp_d"]);
    expect(Object.keys(all.contents).sort()).toEqual(["prp_a", "prp_b", "prp_c", "prp_d"]);
    expect(all.contents.prp_c).toEqual({ [blobId(texts.prp_c)]: texts.prp_c });
    expect(all.more).toEqual([]);
    // 150 bytes: a fits, b would not, and what follows waits its turn.
    const first = contents.fetch(["prp_a", "prp_b", "prp_c", "prp_d"], 150);
    expect(Object.keys(first.contents)).toEqual(["prp_a"]);
    expect(first.more).toEqual(["prp_b", "prp_c", "prp_d"]);
    // A change larger than the budget still comes alone.
    const alone = contents.fetch(["prp_b", "prp_c"], 10);
    expect(Object.keys(alone.contents)).toEqual(["prp_b"]);
    expect(alone.more).toEqual(["prp_c"]);
    expect(contents.fetch([])).toEqual({ contents: {}, more: [] });
  });

  it("keeps odd ids as plain keys", () => {
    const { contents } = store();
    contents.put("__proto__", { [blobId("x")]: "x" });
    const got = contents.fetch(["__proto__"]);
    expect(Object.hasOwn(got.contents, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)[blobId("x")]).toBeUndefined();
  });
});

const COLONY = { id: "c", trunk: { namespace: "ft-trunk", name: "c--trunk", remote: "" } } as unknown as Colony;
const enc = new TextEncoder();

/** An inline proposal writing src/a.ts (which trunk has as `before`) and a new src/new.ts, with a reader that records every repo it is asked about. */
function inlineProposal(): { p: Proposal; read: BlobReader; asked: string[] } {
  const before = "export const a = 0;\n";
  const beforeBlob = blobId(before);
  const c = change({ "src/a.ts": A_TS, "src/new.ts": "export function fresh(): number {\n  return 2;\n}\n" });
  const asked: string[] = [];
  const read: BlobReader = async (where, ids) => {
    asked.push(where.name);
    return new Map(ids.map((id) => [id, where.name === COLONY.trunk.name && id === beforeBlob ? enc.encode(before) : null]));
  };
  const p = {
    id: "prp_1",
    colonyId: "c",
    intentId: "int_1",
    agentId: "agt_1",
    workspace: { namespace: "ft-ws-0", name: "c--ws-0", remote: "" },
    baseSha: BASE,
    headSha: c.headSha,
    writeSet: c.writeSet,
    readSet: [
      { path: "src/a.ts", blob: beforeBlob },
      { path: "src/new.ts", blob: null },
    ],
    declared: { footprint: ["src/**"], summary: "change" },
    evidence: { checks: [], notVerified: "Not verified: the tests" },
    status: "checking",
    createdAt: 0,
    contents: c.contents,
  } as Proposal;
  return { p, read, asked };
}

describe("the decide stage and the contest judge read an inline change from its contents", () => {
  it("innate checks take the new files from the contents and never ask the workspace", async () => {
    const { p, read, asked } = inlineProposal();
    const r = await runInnateChecks(p, { env: {} as Env, colony: COLONY, intent: null, rules: [], read });
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => [f.path, f.before, f.after, f.unreadable])).toEqual([
      ["src/a.ts", "export const a = 0;\n", A_TS, false],
      ["src/new.ts", null, "export function fresh(): number {\n  return 2;\n}\n", false],
    ]);
    expect(asked).toEqual([COLONY.trunk.name]);
  });

  it("a text missing from the contents fails the blobs check with a reason for an inline change", async () => {
    const { p, read, asked } = inlineProposal();
    const r = await runInnateChecks({ ...p, contents: {} }, { env: {} as Env, colony: COLONY, intent: null, rules: [], read });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/^no text kept for the new blobs of this inline change: src\/a\.ts \([0-9a-f]{10}\), src\/new\.ts \([0-9a-f]{10}\); propose it again$/);
    expect(asked).toEqual([COLONY.trunk.name]);
  });

  it("the contest judge's diffs come from the contents too", async () => {
    const { p, read, asked } = inlineProposal();
    const diffs = await loadDiffs(p, { env: {} as Env, trunk: COLONY.trunk, read });
    expect(diffs.map((d) => [d.path, d.status])).toEqual([
      ["src/a.ts", "modified"],
      ["src/new.ts", "added"],
    ]);
    expect(diffs[0]!.addedLines).toEqual(["export const a = 1;"]);
    expect(asked).toEqual([COLONY.trunk.name]);
  });

  it("the contents reader answers only for the blobs it holds", async () => {
    const read = contentsReader({ [blobId(A_TS)]: A_TS });
    const got = await read({ namespace: "x", name: "y" }, [blobId(A_TS), blobId(B_TS), "toString"]);
    expect(new TextDecoder().decode(got.get(blobId(A_TS))!)).toBe(A_TS);
    expect(got.get(blobId(B_TS))).toBeNull();
    expect(got.get("toString")).toBeNull();
  });
});
