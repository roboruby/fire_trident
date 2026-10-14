import { describe, expect, it } from "vitest";
import { GOAL_CONFLICT_MAX_FILES, GOAL_CONFLICT_MAX_REMOVED, removedLines, type Sha } from "@fire_trident/core";
import { noteUndoes, noteWriter, removedLineOwners, sqlLineageSource, type RemovedLinesQuery } from "../../src/decide/undone.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** A file version's text as a blob id: the text's own number, so equal texts share a blob as git's would. */
function blobOf(texts: Map<Sha, string>, text: string): Sha {
  for (const [blob, t] of texts) if (t === text) return blob;
  const blob = (texts.size + 1).toString(16).padStart(40, "b");
  texts.set(blob, text);
  return blob;
}

/** TrunkDO's landing tables over node:sqlite, with its blobs in memory, recorded as finalizeRows does. */
function trunk() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  db.exec("CREATE TABLE ft_landings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, trunk_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE TABLE ft_landing_paths (path TEXT NOT NULL, seq INTEGER NOT NULL, landing_id TEXT NOT NULL, before_blob TEXT, after_blob TEXT, PRIMARY KEY (path, seq))");
  db.exec("CREATE TABLE ft_notes (landing_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, note TEXT NOT NULL)");
  const texts = new Map<Sha, string>();
  const files = new Map<string, Sha | null>();
  const reads: Sha[] = [];
  let n = 0;
  /**
   * Land one change: `changes` maps paths to new texts (null deletes); `intent` wrote them (one proposal), or `note`
   * replaces the note (a revert, an antibody). Returns the landing id and each path's new blob.
   */
  const land = (changes: Record<string, string | null>, intent: string, at: number, note?: unknown): { id: string; blobs: Record<string, Sha | null> } => {
    n++;
    const id = `lnd_${n}`;
    const blobs: Record<string, Sha | null> = {};
    for (const [path, text] of Object.entries(changes)) blobs[path] = text === null ? null : blobOf(texts, text);
    const seq = (db.prepare("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?) RETURNING seq").all(id, n.toString(16).padStart(40, "c"), "0".repeat(40), at, "{}")[0] as { seq: number }).seq;
    for (const [path, blob] of Object.entries(blobs)) {
      db.prepare("INSERT INTO ft_landing_paths (path, seq, landing_id, before_blob, after_blob) VALUES (?, ?, ?, ?, ?)").all(path, seq, id, files.get(path) ?? null, blob);
      files.set(path, blob);
    }
    const written = note ?? { proposals: [{ id: `prp_${n}`, intent: { id: intent, title: intent }, writeSet: Object.entries(blobs).map(([path, blob]) => ({ path, blob })) }] };
    db.prepare("INSERT INTO ft_notes (landing_id, commit_sha, note) VALUES (?, ?, ?)").all(id, "c".repeat(40), JSON.stringify(written));
    return { id, blobs };
  };
  const source = (now = () => T0 + 10 * MIN) =>
    sqlLineageSource(
      sql,
      async (blob) => {
        reads.push(blob);
        const t = texts.get(blob);
        return t === undefined ? null : new TextEncoder().encode(t);
      },
      now,
    );
  return { sql, texts, land, source, reads, blob: (text: string) => blobOf(texts, text) };
}

const SEED = ["// The order backend.", 'export const language = "python";', 'export const build = "pip install";', 'export const start = "python -m app";', 'export const health = "python up";', "export const port = 8080;", "export function routes() {", '  return ["/orders"];', "}"].join("\n") + "\n";
const RUST = SEED.replace('"python";', '"rust";').replace('"pip install"', '"cargo build"').replace('"python -m app"', '"./orders"').replace('"python up"', '"rust up"');
const GO = SEED.replace('"python";', '"go";').replace('"pip install"', '"go build"').replace('"python -m app"', '"./orders-go"').replace('"python up"', '"go up"');

/** A query for one file at `base` whose change makes it `after`. */
function query(path: string, base: string, after: string | null, blob: (t: string) => Sha, over: Partial<RemovedLinesQuery> = {}): RemovedLinesQuery {
  return { files: [{ path, blob: blob(base), removed: removedLines(base, after) }], since: T0 - 60 * MIN, landings: 200, ...over };
}

describe("removedLineOwners: who wrote the lines a change removes", () => {
  it("names the landing and intent that wrote the removed lines, with that landing's lines in the version", async () => {
    const t = trunk();
    t.land({ "src/backend.ts": SEED }, "int_seed", T0);
    const rust = t.land({ "src/backend.ts": RUST }, "int_rust", T0 + MIN);
    const answer = await removedLineOwners(t.source(), query("src/backend.ts", RUST, GO, t.blob));
    expect(answer).toEqual({ owners: [{ landingId: rust.id, at: T0 + MIN, rank: 0, path: "src/backend.ts", removed: 4, lines: 4, intentId: "int_rust", proposalId: "prp_2" }], skipped: [] });
  });

  it("follows kept lines back to the landing that created the file", async () => {
    const t = trunk();
    const seed = t.land({ "src/backend.ts": SEED }, "int_seed", T0);
    const rust = t.land({ "src/backend.ts": RUST }, "int_rust", T0 + MIN);
    const answer = await removedLineOwners(t.source(), query("src/backend.ts", RUST, null, t.blob));
    expect(answer.owners.map((o) => `${o.landingId} ${o.intentId} ${o.removed}/${o.lines} rank ${o.rank}`)).toEqual([`${rust.id} int_rust 4/4 rank 0`, `${seed.id} int_seed 5/5 rank 1`]);
  });

  it("looks only at recent landings: none before `since`, none outside the newest `landings`", async () => {
    const t = trunk();
    t.land({ "src/backend.ts": SEED }, "int_seed", T0);
    t.land({ "src/backend.ts": RUST }, "int_rust", T0 + MIN);
    t.land({ "README.md": "hi\n" }, "int_readme", T0 + 2 * MIN);
    const late = await removedLineOwners(t.source(), query("src/backend.ts", RUST, null, t.blob, { since: T0 + 30_000 }));
    expect(late.owners.map((o) => o.intentId)).toEqual(["int_rust"]);
    // Only the newest landing (the README) is recent: the version at the base is older, so nothing it holds is recent.
    expect((await removedLineOwners(t.source(), query("src/backend.ts", RUST, null, t.blob, { landings: 1 }))).owners).toEqual([]);
    expect((await removedLineOwners(t.source(), query("src/backend.ts", RUST, null, t.blob, { landings: 2 }))).owners.map((o) => o.intentId)).toEqual(["int_rust"]);
  });

  it("starts from the change's base, not from trunk: landings after the base are not the change's to undo", async () => {
    const t = trunk();
    t.land({ "src/backend.ts": SEED }, "int_seed", T0);
    t.land({ "src/backend.ts": RUST }, "int_rust", T0 + MIN);
    t.land({ "src/backend.ts": GO }, "int_go", T0 + 2 * MIN);
    // A change built on the Rust version (stale since the Go landing) that rewrites the start line.
    const answer = await removedLineOwners(t.source(), query("src/backend.ts", RUST, RUST.replace('"./orders"', '"./svc"'), t.blob));
    expect(answer.owners.map((o) => `${o.intentId} ${o.removed}/${o.lines} rank ${o.rank}`)).toEqual(["int_rust 1/4 rank 1"]);
  });

  it("has nothing for a version no recent landing produced, and reads no blob for it", async () => {
    const t = trunk();
    t.land({ "src/backend.ts": SEED }, "int_seed", T0);
    const answer = await removedLineOwners(t.source(), query("src/backend.ts", "an imported version\n", null, t.blob));
    expect(answer).toEqual({ owners: [], skipped: [] });
    expect(t.reads).toEqual([]);
  });

  it("marks FireTrident's own commits, which the rule never counts", async () => {
    const t = trunk();
    t.land({ "src/backend.ts": SEED }, "int_seed", T0);
    t.land({ "src/backend.ts": RUST }, "", T0 + MIN, { revert: { of: "lnd_0", reason: "undo" }, proposals: [] });
    const answer = await removedLineOwners(t.source(), query("src/backend.ts", RUST, SEED, t.blob));
    expect(answer.owners).toEqual([{ landingId: "lnd_2", at: T0 + MIN, rank: 0, path: "src/backend.ts", removed: 4, lines: 4, system: true }]);
  });

  it("reports a file it cannot follow, and keeps the landings it found before that", async () => {
    const t = trunk();
    t.land({ "src/backend.ts": SEED }, "int_seed", T0);
    const rust = t.land({ "src/backend.ts": RUST }, "int_rust", T0 + MIN);
    t.texts.delete(t.blob(SEED));
    const answer = await removedLineOwners(t.source(), query("src/backend.ts", RUST, null, t.blob));
    expect(answer.skipped).toEqual([{ path: "src/backend.ts", why: "partly traced: a version could not be read (or is too large)" }]);
    expect(answer.owners).toEqual([]);
    // Its base unreadable: not traced at all.
    const t2 = trunk();
    t2.land({ "src/backend.ts": SEED }, "int_seed", T0);
    t2.land({ "src/backend.ts": RUST }, "int_rust", T0 + MIN);
    const base = t2.blob(RUST);
    t2.texts.delete(base);
    const lost = await removedLineOwners(t2.source(), { files: [{ path: "src/backend.ts", blob: base, removed: [1, 2] }], since: 0, landings: 200 });
    expect(lost).toEqual({ owners: [], skipped: [{ path: "src/backend.ts", why: "not traced: its version at the change's base could not be read (or is too large)" }] });
    expect(rust.id).toBe("lnd_2");
  });

  it("stops at the time budget and says so", async () => {
    const t = trunk();
    t.land({ "src/a.ts": SEED, "src/b.ts": SEED }, "int_seed", T0);
    let clock = T0;
    const answer = await removedLineOwners(
      t.source(() => (clock += 3_000)),
      { files: [{ path: "src/a.ts", blob: t.blob(SEED), removed: [1, 2, 3] }, { path: "src/b.ts", blob: t.blob(SEED), removed: [1] }], since: 0, landings: 200 },
    );
    expect(answer.skipped.map((s) => s.path)).toContain("src/b.ts");
  });

  it("takes well formed files only, each path once, within the file and line limits", async () => {
    const t = trunk();
    t.land({ "src/backend.ts": SEED }, "int_seed", T0);
    const blob = t.blob(SEED);
    const files = [
      { path: "", blob, removed: [1] },
      { path: "src/x.ts", blob: "nope", removed: [1] },
      { path: "src/backend.ts", blob, removed: [1, 1, -2, 2.5, 3] },
      { path: "src/backend.ts", blob, removed: [4] },
      ...Array.from({ length: GOAL_CONFLICT_MAX_FILES + 5 }, (_, i) => ({ path: `src/f${i}.ts`, blob, removed: [GOAL_CONFLICT_MAX_REMOVED, 1] })),
    ];
    const answer = await removedLineOwners(t.source(), { files, since: 0, landings: 200 });
    expect(answer.owners).toEqual([{ landingId: "lnd_1", at: T0, rank: 0, path: "src/backend.ts", removed: 2, lines: 9, intentId: "int_seed", proposalId: "prp_1" }]);
    expect(await removedLineOwners(t.source(), null as unknown as RemovedLinesQuery)).toEqual({ owners: [], skipped: [] });
  });
});

describe("lineage notes", () => {
  it("names the proposal and intent that wrote a path, or FireTrident's own commit", () => {
    const note = { proposals: [{ id: "prp_1", intent: { id: "int_a" }, writeSet: [{ path: "a.ts", blob: null }] }, { id: "prp_2", intent: { id: "int_b" }, writeSet: [{ path: "b.ts" }] }] };
    expect(noteWriter(note, "b.ts")).toEqual({ proposalId: "prp_2", intentId: "int_b" });
    expect(noteWriter(note, "c.ts")).toBeNull();
    expect(noteWriter({ system: { kind: "antibody" }, proposals: note.proposals }, "a.ts")).toEqual({ system: true });
    expect(noteWriter("junk", "a.ts")).toBeNull();
    expect(noteWriter({ proposals: [null, { id: 3, writeSet: [{ path: "a.ts" }] }] }, "a.ts")).toEqual({});
  });

  it("keeps a proposal's well formed undoes records for its note, and no field when there are none", () => {
    expect(noteUndoes([{ landingId: "lnd_1", intentId: "int_a", path: "a.ts", lines: 5.5 }, { landingId: "", intentId: "x", path: "a.ts", lines: 1 }, null, "x"])).toEqual({
      undoes: [{ landingId: "lnd_1", intentId: "int_a", path: "a.ts", lines: 5 }],
    });
    expect(noteUndoes(undefined)).toEqual({});
    expect(noteUndoes([{ landingId: "lnd_1", intentId: "int_a", path: "a.ts", lines: -1 }])).toEqual({});
    expect(noteUndoes(Array.from({ length: 60 }, (_, i) => ({ landingId: `lnd_${i}`, intentId: "i", path: "p", lines: 3 }))).undoes).toHaveLength(50);
  });
});
