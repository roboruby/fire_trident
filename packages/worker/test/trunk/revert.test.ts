import { describe, expect, it, vi } from "vitest";
import type { Id, Landing, Path, Sha } from "@fire_trident/core";
import {
  IMPORT_SCAN,
  importedDeletions,
  importedText,
  movedText,
  planRevert,
  proposalWrites,
  relativeSpecifiers,
  runRevert,
  sqlRevertTrunk,
  type LandedPath,
  type RevertCommit,
  type RevertResult,
  type RevertTrunk,
} from "../../src/trunk/revert.ts";

const sha = (c: string): Sha => c.repeat(40).slice(0, 40);

describe("planRevert", () => {
  // The landing edited src/a.ts, created src/new.ts and deleted src/old.ts.
  const landed: LandedPath[] = [
    { path: "src/a.ts", before: sha("1"), after: sha("2") },
    { path: "src/new.ts", before: null, after: sha("3") },
    { path: "src/old.ts", before: sha("4"), after: null },
  ];
  const later = (by: Record<Path, string>) => (path: Path) => by[path] ?? null;

  it("puts every path back while trunk still holds what the landing produced", () => {
    const trunk: Record<Path, Sha | null> = { "src/a.ts": sha("2"), "src/new.ts": sha("3") };
    expect(planRevert(landed, (p) => trunk[p] ?? null, later({}))).toEqual({
      ok: true,
      restore: [
        { path: "src/a.ts", blob: sha("1"), expect: sha("2") },
        { path: "src/new.ts", blob: null, expect: sha("3") },
        { path: "src/old.ts", blob: sha("4"), expect: null },
      ],
    });
  });

  it("refuses when work landed on top, naming each path and the landing that moved it", () => {
    const trunk: Record<Path, Sha | null> = { "src/a.ts": sha("5"), "src/old.ts": sha("6") };
    const plan = planRevert(landed, (p) => trunk[p] ?? null, later({ "src/a.ts": "lnd_b", "src/new.ts": "lnd_c", "src/old.ts": "lnd_d" }));
    expect(plan).toEqual({
      ok: false,
      moved: [
        { path: "src/a.ts", now: sha("5"), by: "lnd_b" },
        { path: "src/new.ts", now: null, by: "lnd_c" },
        { path: "src/old.ts", now: sha("6"), by: "lnd_d" },
      ],
    });
    if (plan.ok) throw new Error("expected a refusal");
    expect(movedText(plan.moved)).toBe("src/a.ts changed since, last by lnd_b; src/new.ts deleted since, last by lnd_c; src/old.ts changed since, last by lnd_d");
    expect(movedText(plan.moved, 1)).toBe("src/a.ts changed since, last by lnd_b; and 2 more");
  });

  it("skips paths the landing left as they were", () => {
    const same: LandedPath[] = [{ path: "src/a.ts", before: sha("1"), after: sha("1") }];
    expect(planRevert(same, () => sha("1"), later({}))).toEqual({ ok: true, restore: [] });
  });
});

describe("importedDeletions", () => {
  // Trunk after landings: src/lib/fresh.ts and src/lib/kit/index.ts were created by the landing being undone.
  const tree = new Set(["src/app/main.ts", "src/app/other.ts", "src/lib/fresh.ts", "src/lib/kit/index.ts", "src/lib/util.ts", "src/lib/util/index.ts", "docs/guide.md", "data.json"]);
  const exists = (p: Path) => tree.has(p);
  const files = (texts: Record<Path, string>) => Object.entries(texts).map(([path, text]) => ({ path, specifiers: relativeSpecifiers(text) }));

  it("finds the trunk files whose relative imports resolve to a deleted file, as the decide stage resolves them", () => {
    const found = importedDeletions(
      ["src/lib/fresh.ts", "src/lib/kit/index.ts"],
      files({
        "src/app/main.ts": 'import { fresh } from "../lib/fresh.js";\nimport kit from "../lib/kit";\n',
        "src/app/other.ts": 'export { fresh } from "../lib/fresh";\n',
        "src/lib/util.ts": 'import type { Fresh } from "./fresh.ts";\n',
        "docs/guide.md": 'import { fresh } from "../src/lib/fresh";\n',
      }),
      exists,
    );
    expect(found).toEqual([
      { path: "src/lib/fresh.ts", by: ["src/app/main.ts", "src/app/other.ts", "src/lib/util.ts"] },
      { path: "src/lib/kit/index.ts", by: ["src/app/main.ts"] },
    ]);
    expect(importedText(found, (p) => (p === "src/app/main.ts" ? "lnd_b" : null))).toBe(
      "src/lib/fresh.ts is imported by src/app/main.ts (last changed by lnd_b), src/app/other.ts, src/lib/util.ts; src/lib/kit/index.ts is imported by src/app/main.ts (last changed by lnd_b)",
    );
  });

  it("ignores imports that resolve elsewhere, packages, comments and strings, and the deleted files themselves", () => {
    const found = importedDeletions(
      ["src/lib/fresh.ts", "src/lib/kit/index.ts"],
      files({
        // "./util" resolves to the file beside the directory, never to anything deleted.
        "src/app/main.ts": 'import { helper } from "../lib/util";\nimport x from "fresh";\n// import { fresh } from "../lib/fresh";\nconst s = "import y from \'../lib/fresh\'";\n',
        // A deleted file importing another deleted file goes away with it.
        "src/lib/kit/index.ts": 'export * from "../fresh.ts";\n',
      }),
      exists,
    );
    expect(found).toEqual([]);
  });

  it("caps the refusal text", () => {
    const by = Array.from({ length: 7 }, (_, i) => `src/a${i}.ts`);
    const list = Array.from({ length: 7 }, (_, i) => ({ path: `src/gone${i}.ts`, by }));
    const text = importedText(list);
    expect(text.startsWith("src/gone0.ts is imported by src/a0.ts, src/a1.ts, src/a2.ts, src/a3.ts, src/a4.ts, 2 more; src/gone1.ts")).toBe(true);
    expect(text.endsWith("; and 2 more")).toBe(true);
  });
});

describe("proposalWrites", () => {
  it("reads one proposal's intent and paths from a lineage note, and nothing from a note that does not list it", () => {
    const note = {
      proposals: [
        { id: "prp_a", intent: { id: "int_a" }, writeSet: [{ path: "src/a.ts", blob: sha("1") }, { path: "src/new.ts", blob: null }] },
        { id: "prp_b", intent: {}, writeSet: [{ path: "src/b.ts", blob: sha("2") }, { nope: 1 }] },
      ],
    };
    expect(proposalWrites(note, "prp_a")).toEqual({ intentId: "int_a", paths: ["src/a.ts", "src/new.ts"] });
    expect(proposalWrites(note, "prp_b")).toEqual({ intentId: null, paths: ["src/b.ts"] });
    expect(proposalWrites(note, "prp_c")).toBeNull();
    for (const bad of [null, "text", { proposals: "x" }, { proposals: [null, { id: "prp_a" }] }]) expect(proposalWrites(bad, "prp_a")).toBeNull();
  });
});

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const hex = (n: number): Sha => n.toString(16).padStart(40, "0");
type Writes = Record<Path, string | Uint8Array | null>;

/**
 * Trunk as TrunkDO keeps it for a revert: its tables (as its constructor creates them, filled the way
 * finalizeRows fills them), blob bytes by id, and a writer that refuses a stale file and commits the
 * way systemCommitNow does. `between` runs inside the serial step before the revert's own work there:
 * a landing that slipped in after the first checks.
 */
class Trunk {
  readonly sql: SqlStorage;
  readonly commits: RevertCommit[] = [];
  between: (() => void) | null = null;
  notesStarted = 0;
  /** The mode each path had in each commit, as modeAt answers it (absent: no modeAt, as a writer without it). */
  modes: ((commit: Sha, path: Path) => Promise<string | null>) | null = null;
  failNotes = false;
  private readonly db: DatabaseSync;
  private readonly blobs = new Map<Sha, Uint8Array>();
  private readonly ids = new Map<string, Sha>();
  private n = 0;
  private head = hex(0);

  constructor(files: Writes) {
    this.db = new DatabaseSync(":memory:");
    const db = this.db;
    this.sql = {
      exec(query: string, ...bindings: unknown[]) {
        const rows = db.prepare(query).all(...bindings);
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
            return rows[0];
          },
        };
      },
    } as unknown as SqlStorage;
    db.exec("CREATE TABLE ft_files (path TEXT PRIMARY KEY, blob TEXT NOT NULL, size INTEGER NOT NULL, mode TEXT NOT NULL)");
    db.exec("CREATE TABLE ft_landings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, trunk_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
    db.exec("CREATE TABLE ft_landing_paths (path TEXT NOT NULL, seq INTEGER NOT NULL, landing_id TEXT NOT NULL, before_blob TEXT, after_blob TEXT, PRIMARY KEY (path, seq))");
    db.exec("CREATE TABLE ft_notes (landing_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, note TEXT NOT NULL)");
    db.exec("CREATE TABLE ft_landed (proposal_id TEXT PRIMARY KEY, landing_id TEXT NOT NULL)");
    for (const [path, content] of Object.entries(files)) this.setFile(path, content === null ? null : this.store(content));
  }

  /** The text trunk holds at `path` now, or null when absent. */
  text(path: Path): string | null {
    const blob = this.blobOf(path);
    return blob === null ? null : new TextDecoder().decode(this.blobs.get(blob));
  }

  blobOf(path: Path): Sha | null {
    return this.sql.exec<{ blob: string }>("SELECT blob FROM ft_files WHERE path = ?", path).toArray()[0]?.blob ?? null;
  }

  /** A landing of these proposals (content null deletes), recorded as finalizeRows records one; `note: false` leaves out its lineage note. */
  land(id: Id, proposals: Array<{ id: Id; intent: Id; writes: Writes }>, opts: { note?: boolean } = {}): Landing {
    const changes: Array<{ path: Path; before: Sha | null; after: Sha | null }> = [];
    const entries = proposals.map((p) => {
      const writeSet = Object.entries(p.writes).map(([path, content]) => {
        const before = this.blobOf(path);
        const after = content === null ? null : this.store(content);
        this.setFile(path, after);
        changes.push({ path, before, after });
        return { path, blob: after };
      });
      return { id: p.id, agentId: "agt_1", agentKind: "internal", intent: { id: p.intent, title: p.intent, why: "" }, writeSet, readSet: [], decisions: [], evidence: { checks: [] } };
    });
    const landing = this.landing(id, changes, proposals.map((p) => p.id), proposals.map((p) => p.intent));
    this.record(landing, changes, opts.note === false ? null : JSON.stringify({ schema: "firetrident.lineage/v1", landingId: id, colonyId: "c", proposals: entries }));
    return landing;
  }

  trunk(): RevertTrunk {
    return sqlRevertTrunk(this.sql, {
      landing: (ref) => {
        const rows = this.sql.exec<{ data: string }>("SELECT data FROM ft_landings WHERE id = ? OR substr(trunk_sha, 1, ?) = ?", ref, ref.length, ref).toArray();
        return rows.length === 1 ? (JSON.parse(rows[0]!.data) as Landing) : null;
      },
      read: async (blob) => this.blobs.get(blob) ?? null,
      ...(this.modes ? { modeAt: this.modes } : {}),
      serial: async (fn) => {
        const slipped = this.between;
        this.between = null;
        slipped?.();
        return fn();
      },
      commitNow: async (commit) => {
        for (const f of commit.files) {
          const now = this.blobOf(f.path);
          if (now !== f.expect) return { stale: `${f.path} ${now === null ? "deleted" : "changed"} since` };
        }
        const changes = commit.files.map((f) => {
          const before = this.blobOf(f.path);
          const after = f.content === null ? null : this.store(f.content);
          // The text written back is byte for byte the blob the path had before the landing.
          if (after !== f.blob) throw new Error(`${f.path} went back as ${after}, not ${f.blob}`);
          this.setFile(f.path, after);
          return { path: f.path, before, after };
        });
        this.commits.push(commit);
        const landing = this.landing(`lnd_r${this.commits.length}`, changes, [], []);
        this.record(landing, changes, JSON.stringify(commit.note));
        return { landing };
      },
      notesSoon: async () => {
        this.notesStarted++;
        if (this.failNotes) throw new Error("alarm not set");
      },
    });
  }

  private store(content: string | Uint8Array): Sha {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const key = Array.from(bytes).join(",");
    let id = this.ids.get(key);
    if (id === undefined) {
      id = hex(++this.n);
      this.ids.set(key, id);
      this.blobs.set(id, bytes);
    }
    return id;
  }

  private setFile(path: Path, blob: Sha | null): void {
    if (blob === null) this.sql.exec("DELETE FROM ft_files WHERE path = ?", path);
    else this.sql.exec("INSERT OR REPLACE INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, '100644')", path, blob, this.blobs.get(blob)!.length);
  }

  private landing(id: Id, changes: Array<{ path: Path }>, proposalIds: Id[], intentIds: Id[]): Landing {
    const paths = changes.map((c) => c.path).sort();
    return { id, colonyId: "c", trunkSha: hex(1_000_000 + ++this.n), parentSha: this.head, proposalIds, intentIds, paths, regions: ["src"], at: this.n };
  }

  private record(landing: Landing, changes: Array<{ path: Path; before: Sha | null; after: Sha | null }>, note: string | null): void {
    const seq = this.sql
      .exec<{ seq: number }>("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?) RETURNING seq", landing.id, landing.trunkSha, landing.parentSha, landing.at, JSON.stringify(landing))
      .one().seq;
    for (const c of changes) this.sql.exec("INSERT OR REPLACE INTO ft_landing_paths (path, seq, landing_id, before_blob, after_blob) VALUES (?, ?, ?, ?, ?)", c.path, seq, landing.id, c.before, c.after);
    if (note !== null) this.sql.exec("INSERT OR REPLACE INTO ft_notes (landing_id, commit_sha, note) VALUES (?, ?, ?)", landing.id, landing.trunkSha, note);
    for (const pid of landing.proposalIds) this.sql.exec("INSERT OR REPLACE INTO ft_landed (proposal_id, landing_id) VALUES (?, ?)", pid, landing.id);
    this.head = landing.trunkSha;
  }
}

describe("runRevert", () => {
  /** lnd_1 carries two proposals: prp_a edited src/a.ts and created src/new.ts, prp_b edited src/b.ts. */
  function twoProposals(): { t: Trunk; landing: Landing } {
    const t = new Trunk({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n", "src/main.ts": 'import { a } from "./a.ts";\n' });
    const landing = t.land("lnd_1", [
      { id: "prp_a", intent: "int_a", writes: { "src/a.ts": "export const a = 2;\n", "src/new.ts": "export const n = 1;\n" } },
      { id: "prp_b", intent: "int_b", writes: { "src/b.ts": "export const b = 2;\n" } },
    ]);
    return { t, landing };
  }

  it("undoes one proposal of a landing: only the paths it wrote, with the proposal in the commit and its note", async () => {
    const { t, landing } = twoProposals();
    const res = await runRevert(t.trunk(), "lnd_1", { by: "matt", reason: "a  broke\nthe build", proposal: "prp_a" });
    expect(res).toMatchObject({ ok: true, reverted: { id: "lnd_1" }, landing: { id: "lnd_r1", paths: ["src/a.ts", "src/new.ts"] }, proposal: { id: "prp_a", intentId: "int_a" } });
    expect([t.text("src/a.ts"), t.text("src/new.ts"), t.text("src/b.ts")]).toEqual(["export const a = 1;\n", null, "export const b = 2;\n"]);
    const commit = t.commits[0]!;
    expect(commit.message).toBe(`Revert prp_a of lnd_1 (${landing.trunkSha.slice(0, 7)})\n\nmatt reverted prp_a of ${landing.trunkSha}: a broke the build\n\nFT-Revert-Of: lnd_1\nFT-Revert-Proposal: prp_a`);
    expect(commit.note).toMatchObject({ proposals: [], revert: { of: "lnd_1", commit: landing.trunkSha, by: "matt", reason: "a broke the build", proposal: "prp_a" } });
    expect(t.notesStarted).toBe(1);
  });

  it("undoes a whole landing when no proposal is named, and a failed notes start does not fail it", async () => {
    const { t, landing } = twoProposals();
    t.failNotes = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await runRevert(t.trunk(), landing.trunkSha.slice(0, 9), { by: "matt", reason: "all of it" });
      expect(res).toMatchObject({ ok: true, reverted: { id: "lnd_1" }, landing: { paths: ["src/a.ts", "src/b.ts", "src/new.ts"] } });
      expect(res.ok && res.proposal).toBe(undefined);
      expect(errors).toHaveBeenCalledOnce();
    } finally {
      errors.mockRestore();
    }
    expect(t.commits[0]!.message).toBe(`Revert lnd_1 (${landing.trunkSha.slice(0, 7)})\n\nmatt reverted ${landing.trunkSha}: all of it\n\nFT-Revert-Of: lnd_1`);
    expect((t.commits[0]!.note as unknown as { revert: Record<string, unknown> }).revert).not.toHaveProperty("proposal");
  });

  it("applies every guard to the proposal's paths only", async () => {
    const { t } = twoProposals();
    t.land("lnd_2", [{ id: "prp_c", intent: "int_c", writes: { "src/b.ts": "export const b = 3;\n" } }]);
    const moved = await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_b" });
    expect(moved).toEqual({ ok: false, status: 409, error: "work landed on top of prp_b of lnd_1: src/b.ts changed since, last by lnd_2", moved: [{ path: "src/b.ts", now: t.blobOf("src/b.ts"), by: "lnd_2" }] });
    expect(await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r" })).toMatchObject({ ok: false, status: 409, error: "work landed on top of lnd_1: src/b.ts changed since, last by lnd_2" });
    expect(t.commits).toHaveLength(0);
    // prp_a's paths did not move, so it can still go on its own.
    expect(await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_a" })).toMatchObject({ ok: true, landing: { paths: ["src/a.ts", "src/new.ts"] } });
    expect(t.text("src/b.ts")).toBe("export const b = 3;\n");
    // Undone once, it is refused the second time: its paths hold the revert now.
    expect(await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_a" })).toMatchObject({ ok: false, status: 409, error: "work landed on top of prp_a of lnd_1: src/a.ts changed since, last by lnd_r1; src/new.ts deleted since, last by lnd_r1" });
  });

  it("refuses to delete a file the proposal created while a trunk file imports it, a file of the same landing included", async () => {
    const t = new Trunk({ "src/use.ts": "export {};\n" });
    t.land("lnd_1", [
      { id: "prp_a", intent: "int_a", writes: { "src/kit.ts": "export const kit = 1;\n" } },
      { id: "prp_b", intent: "int_b", writes: { "src/use.ts": 'import { kit } from "./kit.ts";\n' } },
    ]);
    expect(await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_a" })).toEqual({
      ok: false,
      status: 409,
      error: "work landed on top of prp_a of lnd_1: src/kit.ts is imported by src/use.ts",
      imported: [{ path: "src/kit.ts", by: ["src/use.ts"] }],
    });
    // The whole landing takes the importer back with it.
    expect(await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r" })).toMatchObject({ ok: true });
    expect([t.text("src/kit.ts"), t.text("src/use.ts")]).toEqual([null, "export {};\n"]);
  });

  it("answers 404 for a proposal that is not in the landing, 400 for none, and 422 when the note cannot tell its files", async () => {
    const { t } = twoProposals();
    t.land("lnd_2", [{ id: "prp_c", intent: "int_c", writes: { "src/c.ts": "c\n" } }], { note: false });
    t.land("lnd_3", [
      { id: "prp_d", intent: "int_d", writes: { "src/d.ts": "d\n" } },
      { id: "prp_e", intent: "int_e", writes: { "src/e.ts": "e\n" } },
    ], { note: false });
    expect(await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_c" })).toEqual({ ok: false, status: 404, error: "proposal prp_c did not land in lnd_1 (it landed in lnd_2)" });
    expect(await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_x" })).toEqual({ ok: false, status: 404, error: "proposal prp_x did not land in lnd_1" });
    expect(await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r", proposal: " " })).toEqual({ ok: false, status: 400, error: "say which proposal of the landing to revert" });
    expect(await runRevert(t.trunk(), "lnd_3", { by: "m", reason: "r", proposal: "prp_d" })).toEqual({
      ok: false,
      status: 422,
      error: "the lineage note of lnd_3 does not say which files prp_d wrote; revert the whole landing",
    });
    expect(t.commits).toHaveLength(0);
    // The only proposal of its landing wrote all of it, note or not; its intent is the landing's.
    expect(await runRevert(t.trunk(), "lnd_2", { by: "m", reason: "r", proposal: "prp_c" })).toMatchObject({ ok: true, landing: { paths: ["src/c.ts"] }, proposal: { id: "prp_c", intentId: "int_c" } });
  });

  it("checks again inside the commit: work that slips in before it refuses the revert, and nothing is written", async () => {
    // A landing between the first checks and the commit changes a file the proposal wrote...
    const { t } = twoProposals();
    t.between = () => t.land("lnd_2", [{ id: "prp_c", intent: "int_c", writes: { "src/a.ts": "export const a = 3;\n" } }]);
    expect(await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_a" })).toEqual({ ok: false, status: 409, error: "work landed on top of prp_a of lnd_1: src/a.ts changed since" });
    expect([t.commits.length, t.notesStarted, t.text("src/new.ts")]).toEqual([0, 0, "export const n = 1;\n"]);

    // ...or makes a trunk file import the file the revert would delete.
    const u = twoProposals().t;
    u.between = () => u.land("lnd_2", [{ id: "prp_c", intent: "int_c", writes: { "src/main.ts": 'import { n } from "./new.ts";\n' } }]);
    expect(await runRevert(u.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_a" })).toMatchObject({
      ok: false,
      status: 409,
      error: "work landed on top of prp_a of lnd_1: src/new.ts is imported by src/main.ts (last changed by lnd_2)",
    });
    expect([u.commits.length, u.text("src/a.ts")]).toEqual([0, "export const a = 2;\n"]);
  });

  it("puts a file that is not UTF-8 text back byte for byte, by its blob", async () => {
    const logo = new Uint8Array([0xff, 0xfe, 0x00, 0x41, 0x89, 0x50, 0x4e, 0x47]);
    const t = new Trunk({ "assets/logo.png": logo });
    const before = t.blobOf("assets/logo.png");
    t.land("lnd_1", [{ id: "prp_a", intent: "int_a", writes: { "assets/logo.png": "not a png\n" } }]);
    const produced = t.blobOf("assets/logo.png");
    const r = await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_a" });
    expect(r.ok).toBe(true);
    expect(t.commits[0]?.files).toEqual([{ path: "assets/logo.png", blob: before, expect: produced, content: logo }]);
    expect(t.blobOf("assets/logo.png")).toBe(before);
  });

  it("puts a file the landing deleted back with the mode it had, and refuses one whose mode it cannot read or put back", async () => {
    const run = async (mode: string | null | "none"): Promise<{ t: Trunk; r: RevertResult }> => {
      const t = new Trunk({ "bin/run.sh": "#!/bin/sh\necho hi\n", "src/a.ts": "export const a = 1;\n" });
      const landing = t.land("lnd_1", [{ id: "prp_a", intent: "int_a", writes: { "bin/run.sh": null } }]);
      if (mode !== "none") t.modes = async (commit, path) => (commit === landing.parentSha && path === "bin/run.sh" ? mode : null);
      return { t, r: await runRevert(t.trunk(), "lnd_1", { by: "m", reason: "r" }) };
    };
    const exec = await run("100755");
    expect(exec.r.ok).toBe(true);
    expect(exec.t.commits[0]?.files.map((f) => [f.path, f.mode, f.content === null ? null : new TextDecoder().decode(f.content)])).toEqual([["bin/run.sh", "100755", "#!/bin/sh\necho hi\n"]]);
    expect((await run("120000")).t.commits[0]?.files[0]?.mode).toBe("120000");
    // A writer that cannot say (older code, a stand-in): the file comes back as trunk adds files, as before.
    expect((await run("none")).t.commits[0]?.files[0]).not.toHaveProperty("mode");
    const unread = await run(null);
    expect(unread.r).toEqual({ ok: false, status: 422, error: "cannot read the mode bin/run.sh had before lnd_1; revert it by hand" });
    const sub = await run("160000");
    expect(sub.r).toEqual({ ok: false, status: 422, error: "bin/run.sh had mode 160000 before lnd_1, which a revert does not put back; revert it by hand" });
    expect([unread.t.commits.length, sub.t.commits.length]).toEqual([0, 0]);
  });

  it("answers 422 when the import check would read too much", async () => {
    const { t: u } = twoProposals();
    u.sql.exec("UPDATE ft_files SET size = ? WHERE path = ?", IMPORT_SCAN.bytes + 1, "src/main.ts");
    expect(await runRevert(u.trunk(), "lnd_1", { by: "m", reason: "r", proposal: "prp_a" })).toEqual({ ok: false, status: 422, error: "too many files to check which ones import src/new.ts; revert prp_a of lnd_1 by hand" });
    expect(u.commits.length).toBe(0);
  });
});
