import { describe, expect, it } from "vitest";
import { SCOPE_LIMITS } from "@fire_trident/core";
import type { FileVersion, GuideLesson, Landing } from "@fire_trident/core";
import { FieldGuide, type GuideHost } from "../../src/colony/guide.ts";
import { landedScope, lessonScope, lessonScopesEnabled, scopeOnFootprint } from "../../src/colony/lessonscope.ts";

/**
 * Lesson scopes (colony/lessonscope.ts) through the field guide's store on an in-memory SQLite database holding the
 * colony tables it reads, the landing-paths index among them: a lesson keeps its change's files with their blobs, a take
 * marks the files that changed since with the landing and intent, leaves out a lesson whose every file changed, and
 * ranks the lessons on the take's footprint first. Lessons recorded before scopes are carried as before.
 */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const sha = (c: string): string => c.repeat(40).slice(0, 40);
const v = (path: string, c: string | null): FileVersion => ({ path, blob: c === null ? null : sha(c) });
/** A take with FT_LESSON_SCOPE on, for an intent whose footprint covers none of the files here. */
const SCOPED = { footprint: [] as string[] };

function setup() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  };
  sql.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)");
  sql.exec("CREATE TABLE landings (id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL, trunk_sha TEXT NOT NULL, data TEXT NOT NULL)");
  sql.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, model TEXT)");
  sql.exec("CREATE TABLE agent_keys (agent_id TEXT PRIMARY KEY, digest TEXT NOT NULL, created_at INTEGER NOT NULL)");
  sql.exec("CREATE TABLE intents (id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL)");
  // The colony's landing-paths index, as colony/direction.ts makes it.
  sql.exec("CREATE TABLE landing_paths (path TEXT NOT NULL, at INTEGER NOT NULL, landing_id TEXT NOT NULL, intent_id TEXT, PRIMARY KEY (path, at, landing_id))");
  sql.exec("INSERT INTO agents (id, kind, name, model) VALUES ('agt_ext', 'external', 'mcp agent', 'declared-model')");
  const state = { now: 10_000 };
  const host: GuideHost = { sql, certifying: () => false, certification: () => null, certifications: () => [], now: () => state.now };
  const guide = new FieldGuide(host);
  let n = 0;
  /** A proposal in the colony's table with these files read and written. */
  const proposal = (readSet?: FileVersion[], writeSet?: FileVersion[]) => {
    const id = `prp_${++n}`;
    sql.exec("INSERT INTO proposals (id, intent_id, agent_id, status, data) VALUES (?, ?, 'agt_ext', 'ready', '{}')", id, `int_${n}`);
    return { id, intentId: `int_${n}`, agentId: "agt_ext", evidence: { checks: [], residual: [], notVerified: "n" }, ...(readSet ? { readSet } : {}), ...(writeSet ? { writeSet } : {}) };
  };
  /** A landing at `at` of these paths for one intent (titled), recorded and indexed as onLanding does, then reported to the guide. */
  const land = (id: string, at: number, paths: string[], intent: { id: string; title: string } | null, proposalIds: string[] = [], merged?: Landing["merged"]): Landing => {
    const l: Landing = { id, colonyId: "c", trunkSha: sha(id.slice(-1)), parentSha: sha("0"), proposalIds, intentIds: intent ? [intent.id] : [], paths, regions: ["src"], at, ...(merged ? { merged } : {}) };
    sql.exec("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, '{}')", id, at, state.now, l.trunkSha);
    if (intent) sql.exec("INSERT OR IGNORE INTO intents (id, title, why) VALUES (?, ?, 'because')", intent.id, intent.title);
    for (const path of paths) sql.exec("INSERT INTO landing_paths (path, at, landing_id, intent_id) VALUES (?, ?, ?, ?)", path, at, id, intent?.id ?? null);
    guide.landed(l);
    return l;
  };
  /** Capture a lesson, land its change, and approve it. */
  const activeLesson = (text: string, readSet: FileVersion[], writeSet: FileVersion[], landingId: string, at: number): string => {
    const p = proposal(readSet, writeSet);
    const r = guide.capture(p, text);
    land(landingId, at, writeSet.map((w) => w.path), { id: p.intentId, title: `The intent of ${p.id}` }, [p.id]);
    state.now += 1;
    guide.decide(r.lessonId!, { action: "approve", by: "matt" });
    return r.lessonId!;
  };
  const stored = (id: string): GuideLesson => JSON.parse((sql.exec("SELECT data FROM guide_lessons WHERE id = ?", id).toArray()[0] as { data: string }).data) as GuideLesson;
  return { guide, sql, state, proposal, land, activeLesson, stored };
}

describe("a lesson's scope", () => {
  it("is stored with the lesson: the files written and read with their blobs, a file read and written counted as written", () => {
    const { guide, proposal, stored } = setup();
    const p = proposal([v("src/a.ts", "1"), v("src/b.ts", "2"), v("src/gone.ts", null)], [v("src/a.ts", "3"), v("src/new.ts", "4")]);
    const r = guide.capture(p, "Routes register in src/a.ts, not the app file.");
    expect(stored(r.lessonId!).scope).toEqual({ writes: [v("src/a.ts", "3"), v("src/new.ts", "4")], reads: [v("src/b.ts", "2"), v("src/gone.ts", null)] });
  });

  it("keeps at most SCOPE_LIMITS.paths files, written first, counts the rest, and skips what is not a file version", () => {
    const writes = Array.from({ length: 15 }, (_, i) => v(`src/w${i}.ts`, "a"));
    const reads = Array.from({ length: 10 }, (_, i) => v(`src/r${i}.ts`, "b"));
    const s = lessonScope({ writeSet: writes, readSet: [...reads, { path: "src/‮x.ts", blob: sha("c") }, { path: "src/y.ts", blob: "HEAD" }, "src/z.ts"] })!;
    expect(s.writes).toEqual(writes);
    expect(s.reads).toEqual(reads.slice(0, SCOPE_LIMITS.paths - 15));
    expect(s.more).toBe(5);
    expect(lessonScope({})).toBeUndefined();
    expect(lessonScope({ readSet: [], writeSet: "x" })).toBeUndefined();
  });

  it("takes the blob a text merge landed for a file the change wrote", () => {
    const { guide, proposal, land, stored } = setup();
    const p = proposal([], [v("src/a.ts", "3"), v("src/b.ts", "4")]);
    const r = guide.capture(p, "The merge keeps both sides of the router table.");
    land("lnd_1", 10_100, ["src/a.ts", "src/b.ts"], null, [p.id], [{ proposalId: p.id, path: "src/a.ts", blob: sha("9") }, { proposalId: "prp_other", path: "src/b.ts", blob: sha("8") }]);
    expect(stored(r.lessonId!).scope!.writes).toEqual([v("src/a.ts", "9"), v("src/b.ts", "4")]);
    expect(landedScope({ reads: [], writes: [v("src/a.ts", "3")] }, undefined, p.id)).toEqual({ reads: [], writes: [v("src/a.ts", "3")] });
  });

  it("is on a footprint when a footprint entry covers one of its files: an exact path, a directory or a glob", () => {
    const s = { reads: [v("src/lib/util.ts", "1")], writes: [v("src/app/main.ts", "2")] };
    expect(scopeOnFootprint(s, ["src/lib/util.ts"])).toBe(true);
    expect(scopeOnFootprint(s, ["src/app/"])).toBe(true);
    expect(scopeOnFootprint(s, ["src/**/*.ts"])).toBe(true);
    expect(scopeOnFootprint(s, ["docs/", "src/lib/other.ts"])).toBe(false);
    expect(scopeOnFootprint(undefined, ["src/"])).toBe(false);
    expect(scopeOnFootprint(s, [])).toBe(false);
  });
});

describe("a take marks what moved since a lesson was written", () => {
  it("names a file a later landing changed, with that landing, when, and the intent and its title", () => {
    const { guide, land, activeLesson } = setup();
    const id = activeLesson("util.ts helpers are pure: they never read the env.", [v("src/lib/env.ts", "1")], [v("src/lib/util.ts", "2")], "lnd_1", 10_100);
    expect(guide.take(SCOPED).lessons[0]).not.toHaveProperty("movedSince");
    land("lnd_2", 10_200, ["src/lib/util.ts", "src/other.ts"], { id: "int_9", title: "Read the region from the env" });
    const [e] = guide.take(SCOPED).lessons;
    expect(e).toMatchObject({ id, movedSince: [{ path: "src/lib/util.ts", landingId: "lnd_2", at: 10_200, intentId: "int_9", title: "Read the region from the env" }] });
    expect(e!.movedSince).toHaveLength(1);
  });

  it("counts neither its own landing nor one before it", () => {
    const { guide, land, activeLesson } = setup();
    land("lnd_0", 10_050, ["src/lib/util.ts"], { id: "int_0", title: "Before" });
    activeLesson("util.ts helpers are pure: they never read the env.", [], [v("src/lib/util.ts", "2"), v("src/lib/b.ts", "3")], "lnd_1", 10_100);
    expect(guide.take(SCOPED).lessons[0]).not.toHaveProperty("movedSince");
  });

  it("before its change lands (a person approved it), counts what landed after the lesson was recorded", () => {
    const { guide, proposal, land, state } = setup();
    land("lnd_0", 9_000, ["src/a.ts"], { id: "int_0", title: "Before" });
    const r = guide.capture(proposal([v("src/a.ts", "1")], [v("src/b.ts", "2")]), "The config is read once at boot.");
    guide.decide(r.lessonId!, { action: "approve", by: "matt" });
    expect(guide.take(SCOPED).lessons[0]).not.toHaveProperty("movedSince");
    state.now = 12_000;
    land("lnd_3", 11_000, ["src/a.ts"], { id: "int_3", title: "Read config per request" });
    expect(guide.take(SCOPED).lessons[0]!.movedSince).toEqual([{ path: "src/a.ts", landingId: "lnd_3", at: 11_000, intentId: "int_3", title: "Read config per request" }]);
  });

  it("leaves a lesson out once every file of its scope changed, and keeps it marked while some still hold", () => {
    const { guide, land, activeLesson } = setup();
    const id = activeLesson("The two files share one cache key format.", [v("src/b.ts", "1")], [v("src/a.ts", "2")], "lnd_1", 10_100);
    land("lnd_2", 10_200, ["src/a.ts"], { id: "int_2", title: "Rewrite a" });
    expect(guide.take(SCOPED).lessons.map((e) => e.id)).toEqual([id]);
    land("lnd_3", 10_300, ["src/b.ts"], { id: "int_3", title: "Rewrite b" });
    expect(guide.take(SCOPED).lessons).toEqual([]);
    // It stays active in the guide (a person or the budget retires it): only takes leave it out.
    expect(guide.view(false).active.map((e) => e.id)).toEqual([id]);
  });

  it("keeps a lesson whose scope was cut at the cap even when every kept file changed", () => {
    const { sql, land, activeLesson, stored } = setup();
    const id = activeLesson("The router table is generated at build time.", [], [v("src/a.ts", "2")], "lnd_1", 10_100);
    const l = stored(id);
    sql.exec("UPDATE guide_lessons SET data = ? WHERE id = ?", JSON.stringify({ ...l, scope: { ...l.scope, more: 3 } }), id);
    const fresh = new FieldGuide({ sql, certifying: () => false, certification: () => null, certifications: () => [], now: () => 20_000 });
    land("lnd_2", 10_200, ["src/a.ts"], null);
    expect(fresh.take(SCOPED).lessons).toEqual([expect.objectContaining({ id, movedSince: [{ path: "src/a.ts", landingId: "lnd_2", at: 10_200 }] })]);
  });
});

describe("a take ranks and carries", () => {
  it("ranks the lessons whose change read or wrote a file of the take's footprint first, then the newest", () => {
    const { guide, activeLesson } = setup();
    const onRead = activeLesson("Lesson one reads the session store.", [v("src/session.ts", "1")], [v("src/x.ts", "2")], "lnd_1", 10_100);
    const off = activeLesson("Lesson two is about the docs build.", [], [v("docs/build.md", "3")], "lnd_2", 10_200);
    const onWrite = activeLesson("Lesson three writes the router table.", [], [v("src/routes/index.ts", "4")], "lnd_3", 10_300);
    const newest = activeLesson("Lesson four is about the billing job.", [], [v("jobs/billing.ts", "5")], "lnd_4", 10_400);
    const take = guide.take({ footprint: ["src/session.ts", "src/routes/"] });
    expect(take.lessons.map((e) => e.id)).toEqual([onWrite, onRead, newest, off]);
    expect(take.lessons.map((e) => e.onFootprint ?? false)).toEqual([true, true, false, false]);
    // Without a footprint, newest first as before.
    expect(guide.take(SCOPED).lessons.map((e) => e.id)).toEqual([newest, onWrite, off, onRead]);
  });

  it("carries a lesson recorded before scopes as before: unmarked, never left out, off the footprint", () => {
    const { sql, land, activeLesson, stored } = setup();
    const id = activeLesson("An old lesson with no scope stored.", [], [v("src/a.ts", "2")], "lnd_1", 10_100);
    const { scope: _drop, ...old } = stored(id);
    sql.exec("UPDATE guide_lessons SET data = ? WHERE id = ?", JSON.stringify(old), id);
    const fresh = new FieldGuide({ sql, certifying: () => false, certification: () => null, certifications: () => [], now: () => 20_000 });
    land("lnd_2", 10_200, ["src/a.ts"], { id: "int_2", title: "Rewrite a" });
    expect(fresh.take({ footprint: ["src/a.ts"] }).lessons).toEqual([{ id, text: "An old lesson with no scope stored.", agentId: "agt_ext", author: "external", model: "declared-model", modelEvidence: "declared", landingId: "lnd_1", activatedAt: 10_001, activatedBy: "person" }]);
  });

  it("carries lessons unmarked when the landing-paths index cannot be read", () => {
    const { guide, sql, land, activeLesson } = setup();
    const id = activeLesson("A lesson whose file moved, unread.", [], [v("src/a.ts", "2")], "lnd_1", 10_100);
    land("lnd_2", 10_200, ["src/a.ts"], { id: "int_2", title: "Rewrite a" });
    sql.exec("DROP TABLE landing_paths");
    expect(guide.take(SCOPED).lessons).toEqual([expect.objectContaining({ id })]);
    expect(guide.take(SCOPED).lessons[0]).not.toHaveProperty("movedSince");
  });
});

describe("FT_LESSON_SCOPE", () => {
  it("is on for every colony or the listed ones, off when absent", () => {
    expect(lessonScopesEnabled("on", "a")).toBe(true);
    expect(lessonScopesEnabled("b, a", "a")).toBe(true);
    expect(lessonScopesEnabled("b", "a")).toBe(false);
    expect(lessonScopesEnabled(undefined, "a")).toBe(false);
    expect(lessonScopesEnabled("off", "a")).toBe(false);
  });

  it("off: a take carries the newest lessons unmarked, as before, though scopes are stored", () => {
    const { guide, land, activeLesson, stored } = setup();
    const moved = activeLesson("A lesson whose only file moved.", [], [v("src/a.ts", "2")], "lnd_1", 10_100);
    const newer = activeLesson("A newer lesson about the docs.", [], [v("docs/a.md", "3")], "lnd_2", 10_200);
    land("lnd_3", 10_300, ["src/a.ts"], { id: "int_3", title: "Rewrite a" });
    expect(stored(moved).scope).toEqual({ reads: [], writes: [v("src/a.ts", "2")] });
    const take = guide.take();
    expect(take.lessons.map((e) => e.id)).toEqual([newer, moved]);
    for (const e of take.lessons) {
      expect(e).not.toHaveProperty("movedSince");
      expect(e).not.toHaveProperty("onFootprint");
    }
  });
});
