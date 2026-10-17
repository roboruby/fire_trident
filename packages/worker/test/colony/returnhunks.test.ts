import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { MergeConflict, Proposal, Sha } from "@fire_trident/core";
import { CUT, HUNK_LINES, RETURN_HUNK_CHARS, RETURN_HUNK_LINES, cleanContested, cleanHunks, hasQuotes } from "../../src/colony/hunks.ts";
import { movedReturn, type SqlRunner } from "../../src/colony/movedby.ts";
import { eventMovedBy, fetchReturnHunks, hunkQuery, quoteHunks, quotedSentence, returnHunksEnabled, type HunkHost, type QuotedHunks, type ReturnHunksQuery } from "../../src/colony/returnhunks.ts";
import { quoteReturns, type QuoteSource } from "../../src/trunk/quote.ts";

/**
 * Return hunks (FT_RETURN_HUNKS): a change that goes back because trunk moved its files carries what beat it, quoted by
 * the trunk writer: each movedBy landing's diff of the files it moved, and each contested region of a text merge
 * conflict, capped per file and per return; when the writer does not answer in time, the return goes out as before.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const sha = (c: string): string => c.repeat(40);
const A = "src/a.ts";
const B = "src/b.ts";

/** Numbered lines, some replaced. */
function lines(n: number, changes: Record<number, string> = {}, name = "line"): string {
  return Array.from({ length: n }, (_, i) => `${changes[i + 1] ?? `${name} ${i + 1}`}\n`).join("");
}

/**
 * A colony (the tables movedBy reads) and a trunk writer (quoteReturns over texts in memory): lnd_base made the base;
 * lnd_a then changed src/a.ts and src/b.ts for int_a; each landing's before and after texts are known to the writer.
 */
function world(): { sql: SqlRunner; host: (over?: Partial<HunkHost>) => HunkHost; asks: ReturnHunksQuery[]; texts: Map<Sha, string>; land(id: string, at: number, trunk: string, files: Record<string, [string, string]>): void; store(p: Proposal): void } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
  const run = (q: string, ...b: unknown[]): void => void db.prepare(q).run(...b);
  run("CREATE TABLE landings (id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL, trunk_sha TEXT NOT NULL, data TEXT NOT NULL)");
  run("CREATE TABLE landing_paths (path TEXT NOT NULL, at INTEGER NOT NULL, landing_id TEXT NOT NULL, intent_id TEXT, PRIMARY KEY (path, at, landing_id))");
  run("CREATE TABLE intents (id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL)");
  run("CREATE TABLE proposals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, data TEXT NOT NULL)");
  run("CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, model TEXT)");
  run("INSERT INTO intents (id, title, why) VALUES ('int_a', 'Cache lookups', 'Lookups repeat')");
  const texts = new Map<Sha, string>();
  const writer = new Map<string, { trunkSha: Sha; files: Record<string, [Sha, Sha]> }>();
  const stored = new Map<string, Proposal>();
  const asks: ReturnHunksQuery[] = [];
  const blob = (text: string): Sha => {
    const id = blobId(text);
    texts.set(id, text);
    return id;
  };
  const land = (id: string, at: number, trunk: string, files: Record<string, [string, string]>): void => {
    run("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, ?)", id, at, at, trunk, JSON.stringify({ id, proposalIds: [] }));
    const kept: Record<string, [Sha, Sha]> = {};
    for (const [path, [before, after]] of Object.entries(files)) {
      run("INSERT INTO landing_paths (path, at, landing_id, intent_id) VALUES (?, ?, ?, ?)", path, at, id, id === "lnd_base" ? null : "int_a");
      kept[path] = [blob(before), blob(after)];
    }
    writer.set(id, { trunkSha: trunk, files: kept });
  };
  const source = (): QuoteSource => ({
    landingPath: (landingId, path) => {
      const l = writer.get(landingId);
      const f = l?.files[path];
      return l && f ? { trunkSha: l.trunkSha, before: f[0], after: f[1] } : null;
    },
    read: async (b) => texts.get(b) ?? null,
    now: () => Date.now(),
  });
  land("lnd_base", 1_000, sha("1"), { "src/c.ts": ["", "c\n"] });
  return {
    sql,
    asks,
    texts,
    land,
    store: (p) => stored.set(p.id, p),
    host: (over = {}) => ({
      sql,
      proposal: (id) => stored.get(id) ?? null,
      quote: async (q) => {
        asks.push(q);
        return quoteReturns(source(), q);
      },
      ...over,
    }),
  };
}

/** A change in flight built on `base`, writing `writes`. */
function change(base: string, writes: string[], extra: Partial<Proposal> = {}): Proposal {
  return {
    id: "prp_back",
    colonyId: "c",
    intentId: "int_back",
    agentId: "agt_back",
    workspace: { namespace: "ft-ws-0", name: "c--ws-1", remote: "https://example.invalid/ws.git" },
    baseSha: base,
    headSha: sha("f"),
    writeSet: writes.map((path) => ({ path, blob: sha("9") })),
    readSet: [],
    declared: { footprint: writes, summary: "back" },
    evidence: { checks: [] },
    status: "ready",
    createdAt: 0,
    ...extra,
  };
}

const STALE = "stale: 1 path changed on trunk since read: src/a.ts (expected 1111111111, trunk 2222222222)";

/** What updateProposals does for one item: the quotes first, then the return as the colony settles it. */
async function settle(w: ReturnType<typeof world>, p: Proposal, patch: Partial<Proposal>, stale: string[], over: Partial<HunkHost> = {}): Promise<{ next: Proposal; quoted: QuotedHunks | null }> {
  w.store(p);
  const items = [{ id: p.id, patch, stale: stale.map((path) => ({ path })) }];
  const quoted = await fetchReturnHunks(w.host(over), items);
  const next: Proposal = { ...p, ...patch };
  const moved = movedReturn(w.sql, next, items[0]!.stale);
  if (moved) Object.assign(next, moved);
  quoteHunks(next, quoted);
  return { next, quoted };
}

describe("a stale return quotes the change of each landing that beat it", () => {
  it("names the landing and carries its diff of each moved file, and its reason says to build on it", async () => {
    const w = world();
    w.land("lnd_a", 2_000, sha("2"), { [A]: [lines(6), lines(6, { 3: "line three, cached" })] });
    const { next } = await settle(w, change(sha("1"), [A]), { status: "returned", reason: STALE }, [A]);
    expect(next.movedBy).toHaveLength(1);
    expect(next.movedBy![0]).toMatchObject({ landingId: "lnd_a", paths: [A], trunkSha: sha("2"), intentId: "int_a" });
    expect(next.movedBy![0]!.hunks).toEqual([{ path: A, trunkSha: sha("2"), diff: "@@ -1,5 +1,5 @@\n line 1\n line 2\n-line 3\n+line three, cached\n line 4\n line 5", truncated: false }]);
    expect(next.reason).toBe(
      `${STALE}. Landing lnd_a (commit ${sha("2").slice(0, 7)}, intent int_a) moved it. Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold. ${quotedSentence(true, false)}`,
    );
    // No file is named in what the quote adds to the reason (a reason that names a file counts toward its megafile alarm).
    expect(quotedSentence(true, true)).not.toMatch(/src\//);
    expect(hasQuotes(next)).toBe(true);
  });

  it("asks the trunk writer once for the batch, for the first files of each landing, deduplicated", async () => {
    const w = world();
    w.land("lnd_a", 2_000, sha("2"), { [A]: [lines(3), lines(3, { 1: "a" })], [B]: [lines(3), lines(3, { 2: "b" })] });
    const p1 = change(sha("1"), [A, B]);
    const p2 = { ...change(sha("1"), [A]), id: "prp_two" };
    w.store(p1);
    w.store(p2);
    const items = [
      { id: p1.id, patch: { status: "returned" as const, reason: STALE }, stale: [{ path: A }, { path: B }] },
      { id: p2.id, patch: { status: "returned" as const, reason: STALE }, stale: [{ path: A }] },
      // Not a collision: a review return asks nothing.
      { id: "prp_review", patch: { status: "returned" as const, reason: "llm: no" } },
    ];
    const quoted = await fetchReturnHunks(w.host(), items);
    expect(w.asks).toHaveLength(1);
    expect(w.asks[0]!.diffs).toEqual([
      { landingId: "lnd_a", path: A },
      { landingId: "lnd_a", path: B },
    ]);
    expect(w.asks[0]!.budgetMs).toBeLessThan(1_000);
    expect([...quoted!.diffs.keys()]).toHaveLength(2);
    // Final proposals, and changes already back, are not asked about.
    w.store({ ...p1, status: "landed" });
    expect(hunkQuery(w.host(), items.slice(0, 1)).diffs).toEqual([]);
  });

  it("cuts a long diff with a truncated marker, and holds the return to its overall caps", async () => {
    const w = world();
    // One landing rewrote 500 lines of a file.
    const before = lines(500);
    const after = lines(500, {}, "new");
    w.land("lnd_big", 2_000, sha("2"), { [A]: [before, after] });
    const { next } = await settle(w, change(sha("1"), [A]), { status: "returned", reason: STALE }, [A]);
    const h = next.movedBy![0]!.hunks![0]!;
    expect(h.truncated).toBe(true);
    const shown = h.diff.split("\n");
    expect(shown).toHaveLength(HUNK_LINES + 1);
    expect(shown[shown.length - 1]).toBe(CUT);

    // Twelve files moved by five landings: at most RETURN_HUNK_LINES lines and RETURN_HUNK_CHARS characters in all.
    const many = world();
    const paths = Array.from({ length: 15 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    for (let l = 0; l < 5; l++) {
      const files: Record<string, [string, string]> = {};
      for (const path of paths.slice(l * 3, l * 3 + 3)) files[path] = [lines(200, {}, `x${"y".repeat(60)}`), lines(200, {}, `z${"w".repeat(60)}`)];
      many.land(`lnd_${l}`, 2_000 + l, sha(String(2 + l)), files);
    }
    const all = await settle(many, change(sha("1"), paths), { status: "returned", reason: STALE }, paths);
    const quotes = all.next.movedBy!.flatMap((m) => m.hunks ?? []);
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.reduce((n, q) => n + q.diff.split("\n").length, 0)).toBeLessThanOrEqual(RETURN_HUNK_LINES);
    expect(quotes.reduce((n, q) => n + q.diff.length, 0)).toBeLessThanOrEqual(RETURN_HUNK_CHARS);
    expect(quotes.every((q) => q.diff.split("\n").every((line) => line.length <= 240))).toBe(true);
    // The newest landing is quoted first; landings past the budget are still named, without hunks.
    expect(all.next.movedBy![0]!.landingId).toBe("lnd_4");
    expect(all.next.movedBy![0]!.hunks).toBeDefined();
    expect(all.next.movedBy!.some((m) => m.hunks === undefined)).toBe(true);
  });

  it("masks a line that looks like a secret", async () => {
    const w = world();
    w.land("lnd_a", 2_000, sha("2"), { [A]: [lines(3), lines(3, { 2: 'const password = "hunter2-hunter2-hunter2";' })] });
    const { next } = await settle(w, change(sha("1"), [A]), { status: "returned", reason: STALE }, [A]);
    expect(next.movedBy![0]!.hunks![0]!.diff).not.toContain("hunter2");
    expect(next.movedBy![0]!.hunks![0]!.diff).toContain("[masked]");
  });
});

describe("a text merge conflict quotes each contested region", () => {
  it("carries the base's, trunk's and the change's lines, from the base line where the region starts", async () => {
    const w = world();
    const base = lines(8);
    const ours = lines(8, { 6: "trunk six" });
    const theirs = lines(8, { 6: "own six", 7: "own seven" });
    w.land("lnd_a", 2_000, sha("2"), { [A]: [base, ours] });
    for (const t of [base, ours, theirs]) w.texts.set(blobId(t), t);
    const conflict: MergeConflict = { path: A, base: blobId(base), trunk: blobId(ours), theirs: blobId(theirs), lines: [6] };
    const reason = `stale: ${A} (expected ${blobId(base)}, trunk has ${blobId(ours)}); text merge of ${A}: 1 conflicting hunk, at line 6 of its base`;
    const { next } = await settle(w, change(sha("1"), [A]), { status: "returned", reason, mergeConflicts: [conflict] }, [A]);
    expect(next.contested).toEqual([{ path: A, line: 6, base: ["line 6", "line 7"], trunk: ["trunk six", "line 7"], own: ["own six", "own seven"] }]);
    expect(next.movedBy![0]!.hunks![0]!.diff).toContain("+trunk six");
    expect(next.reason!.endsWith(quotedSentence(true, true))).toBe(true);
    expect(w.asks[0]!.conflicts).toEqual([conflict]);
  });

  it("quotes the regions alone when no known landing moved the file", async () => {
    const w = world();
    const base = lines(4);
    const ours = lines(4, { 2: "theirs on trunk" });
    const theirs = lines(4, { 2: "mine" });
    for (const t of [base, ours, theirs]) w.texts.set(blobId(t), t);
    const conflict: MergeConflict = { path: B, base: blobId(base), trunk: blobId(ours), theirs: blobId(theirs), lines: [2] };
    const reason = `stale: ${B} (expected x, trunk has y); text merge of ${B}: 1 conflicting hunk, at line 2 of its base`;
    const { next } = await settle(w, change(sha("1"), [B]), { status: "returned", reason, mergeConflicts: [conflict] }, [B]);
    expect(next.movedBy).toBeUndefined();
    expect(next.contested).toEqual([{ path: B, line: 2, base: ["line 2"], trunk: ["theirs on trunk"], own: ["mine"] }]);
    expect(next.reason).toBe(`${reason}. ${quotedSentence(false, true)}`);
  });
});

describe("best effort: a return never waits long or fails over its quotes", () => {
  it("a trunk writer that does not answer in time leaves the return as it goes out today, its landing named", async () => {
    const w = world();
    w.land("lnd_a", 2_000, sha("2"), { [A]: [lines(3), lines(3, { 1: "a" })] });
    const slow = { budgetMs: 30, quote: () => new Promise<never>(() => undefined) };
    const t0 = Date.now();
    const { next, quoted } = await settle(w, change(sha("1"), [A]), { status: "returned", reason: STALE }, [A], slow);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(quoted).toBeNull();
    const today = movedReturn(w.sql, { ...change(sha("1"), [A]), status: "returned", reason: STALE }, [{ path: A }])!;
    expect(next.reason).toBe(today.reason);
    expect(next.movedBy).toEqual(today.movedBy);
    expect(next.movedBy![0]!.hunks).toBeUndefined();
  });

  it("a writer on older code (the call refused) or one that fails does the same", async () => {
    const w = world();
    w.land("lnd_a", 2_000, sha("2"), { [A]: [lines(3), lines(3, { 1: "a" })] });
    const refused = { quote: async () => Promise.reject(new TypeError('The RPC receiver does not implement the method "returnHunks".')) };
    const { next } = await settle(w, change(sha("1"), [A]), { status: "returned", reason: STALE }, [A], refused);
    expect(next.movedBy![0]!.hunks).toBeUndefined();
    expect(next.reason!.endsWith("escalate if both cannot hold.")).toBe(true);
  });

  it("the flag reads like the others: on, a list of colony ids, or off when absent", () => {
    expect(returnHunksEnabled(undefined, "c")).toBe(false);
    expect(returnHunksEnabled("off", "c")).toBe(false);
    expect(returnHunksEnabled("on", "c")).toBe(true);
    expect(returnHunksEnabled("a, c", "c")).toBe(true);
    expect(returnHunksEnabled("a,b", "c")).toBe(false);
  });

  it("other returns gain nothing, quotes or not", () => {
    const quoted: QuotedHunks = { diffs: new Map([["lnd_a\u0000src/a.ts", { path: A, diff: "@@ -1 +1 @@\n-a\n+b", truncated: false }]]), conflicts: new Map() };
    const p = { ...change(sha("1"), [A]), status: "returned" as const, reason: "llm: the flag is still read", movedBy: [{ landingId: "lnd_a", paths: [A] }] };
    quoteHunks(p, quoted);
    expect(p.reason).toBe("llm: the flag is still read");
    expect(p.movedBy[0]).not.toHaveProperty("hunks");
  });
});

describe("quotes as received, stored and streamed", () => {
  it("keeps well-formed hunks and regions, cut to the caps, and drops the rest", () => {
    const long = Array.from({ length: 90 }, (_, i) => `+${i}`).join("\n");
    expect(cleanHunks([{ path: A, diff: long, truncated: false, trunkSha: "bad" }, { path: "", diff: "x" }, { path: B }, null])).toEqual([{ path: A, diff: [...long.split("\n").slice(0, HUNK_LINES), CUT].join("\n"), truncated: true }]);
    expect(cleanHunks("nope")).toBeUndefined();
    expect(cleanContested([{ path: A, line: 0, base: [], trunk: [], own: [] }, { path: A, line: 3, base: ["a"], trunk: ["b", 7], own: ["c"] }])).toEqual([{ path: A, line: 3, base: ["a"], trunk: ["b"], own: ["c"] }]);
  });

  it("the live event stream carries movedBy without its quotes", () => {
    const moved = [{ landingId: "lnd_a", paths: [A], hunks: [{ path: A, diff: "@@ -1 +1 @@", truncated: false }] }, { landingId: "lnd_b", paths: [B] }];
    expect(eventMovedBy(moved)).toEqual([
      { landingId: "lnd_a", paths: [A] },
      { landingId: "lnd_b", paths: [B] },
    ]);
  });
});
