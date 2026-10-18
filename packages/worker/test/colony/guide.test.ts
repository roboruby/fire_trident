import { describe, expect, it } from "vitest";
import { GUIDE_LABEL, GUIDE_LIMITS } from "@fire_trident/core";
import type { Certification, ColonyEvent, Evidence, Landing } from "@fire_trident/core";
import { FieldGuide, guideEnabled, guideOffered, type GuideHost } from "../../src/colony/guide.ts";

/**
 * The field guide's store (colony/guide.ts) on an in-memory SQLite database that also holds the colony tables it reads
 * (proposals, landings, agents, agent_keys): capture with masking, the gate a certification applies, reverts, a person's
 * decisions, the budget, and what a take carries.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const sha = (c: string): string => c.repeat(40).slice(0, 40);

/** A colony's storage with the tables the guide reads, and a guide on it with a clock and certifications the test controls. */
function setup(opts: { certifying?: boolean } = {}) {
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
  sql.exec("INSERT INTO agents (id, kind, name, model) VALUES ('agt_ext', 'external', 'mcp agent', 'declared-model'), ('agt_int', 'internal', 'in-platform', '@cf/model-a')");
  sql.exec("INSERT INTO agent_keys (agent_id, digest, created_at) VALUES ('agt_ext', 'digest', 0)");
  const state = { now: 10_000, certs: [] as Certification[] };
  const host: GuideHost = {
    sql,
    certifying: () => opts.certifying !== false,
    certification: (s) => state.certs.find((c) => c.trunkSha === s) ?? null,
    certifications: (n) => [...state.certs].sort((a, b) => b.startedAt - a.startedAt).slice(0, n),
    now: () => state.now,
  };
  const guide = new FieldGuide(host);
  let n = 0;
  /** A proposal in the colony's table, for the guide to capture a lesson from. */
  const proposal = (agentId = "agt_ext", evidence: Evidence = { checks: [], residual: [], notVerified: "Not verified." }) => {
    const id = `prp_${++n}`;
    sql.exec("INSERT INTO proposals (id, intent_id, agent_id, status, data) VALUES (?, ?, ?, 'ready', '{}')", id, `int_${n}`, agentId);
    return { id, intentId: `int_${n}`, agentId, evidence };
  };
  /** A landing of these proposals at `at`, recorded by the colony as onLanding does, then reported to the guide. */
  const land = (id: string, at: number, proposalIds: string[], commit = sha(id.slice(-1))): Landing => {
    const l: Landing = { id, colonyId: "c", trunkSha: commit, parentSha: sha("0"), proposalIds, intentIds: [], paths: ["src/a.ts"], regions: ["src"], at };
    sql.exec("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, '{}')", id, at, state.now, commit);
    for (const p of proposalIds) sql.exec("UPDATE proposals SET status = 'landed' WHERE id = ?", p);
    guide.landed(l);
    return l;
  };
  /** A finished certification, stored as the certifier stores it, then published to the guide as its event. */
  const certify = (c: Partial<Certification> & Pick<Certification, "trunkSha" | "status">): void => {
    const cert: Certification = { startedAt: state.now, finishedAt: state.now + 100, ...c };
    state.certs = [...state.certs.filter((x) => x.trunkSha !== cert.trunkSha), cert];
    const e: ColonyEvent = { t: "certify", at: cert.finishedAt!, trunkSha: cert.trunkSha, status: cert.status, ...(cert.landingId ? { landingId: cert.landingId } : {}) };
    guide.certified(e);
  };
  return { guide, sql, state, proposal, land, certify };
}

describe("FT_FIELD_GUIDE", () => {
  it("is on for every colony or the listed ones, and offered where it names any", () => {
    expect(guideEnabled("on", "a")).toBe(true);
    expect(guideEnabled("b, a", "a")).toBe(true);
    expect(guideEnabled("b", "a")).toBe(false);
    expect(guideEnabled(undefined, "a")).toBe(false);
    expect(guideEnabled("off", "a")).toBe(false);
    expect(guideOffered("b")).toBe(true);
    expect(guideOffered(" ")).toBe(false);
    expect(guideOffered(undefined)).toBe(false);
  });
});

describe("capture", () => {
  it("keeps a candidate cleaned and masked, with the proposal's provenance, and says when other agents will see it", () => {
    const { guide, proposal } = setup();
    const p = proposal("agt_ext");
    // Built from pieces, so no credential-shaped literal sits in this file.
    const value = "s3cr".repeat(4);
    const r = guide.capture(p, `  The API key‮ is read from\nsrc/env.ts at boot, not per request: api_key = "${value}"  `);
    expect(r.status).toBe("candidate");
    expect(r.note).toContain("once your change lands and the first certification of trunk after it is green, or once a person approves it");
    const [c] = guide.view(true).candidates!;
    expect(c).toMatchObject({ id: r.lessonId, status: "candidate", agentId: "agt_ext", proposalId: p.id, intentId: p.intentId, createdAt: 10_000 });
    expect(c!.text).not.toContain(value);
    expect(c!.text).toContain("[masked]");
    expect(c!.text).toContain("The API key is read from src/env.ts at boot, not per request:");
    expect(c!.text).not.toMatch(/[‮\n]/);
    // An external agent that joined over MCP with its own model name: declared, authenticated by its resume key.
    expect(c!.provenance).toEqual({ author: "external", auth: "mcp", model: "declared-model", modelEvidence: "declared" });
  });

  it("records an in-platform agent's model as observed, named after the model its calls went to", () => {
    const { guide, proposal } = setup();
    const p = proposal("agt_int", { checks: [{ name: "agent model usage", ok: true, ms: 1, detail: "@cf/model-b: 3 call(s), 900 input / 300 output tokens" }], residual: [], notVerified: "n" });
    guide.capture(p, "Handlers must export a default object, not a function.");
    expect(guide.view(true).candidates![0]!.provenance).toEqual({ author: "platform", auth: "platform", model: "@cf/model-b", modelEvidence: "observed" });
  });

  it("ignores a lesson with nothing left to keep, or one that is mostly secret-looking", () => {
    const { guide, proposal } = setup();
    expect(guide.capture(proposal(), "tiny").status).toBe("ignored");
    expect(guide.capture(proposal(), 42).status).toBe("ignored");
    const secret = guide.capture(proposal(), "-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA -----END RSA PRIVATE KEY-----");
    expect(secret).toMatchObject({ status: "ignored" });
    expect(secret.note).toMatch(/secret/);
    expect(guide.view(true).candidates).toEqual([]);
  });

  it("does not add a near-duplicate of an active or waiting lesson, and a repeat of the same proposal hears about its own lesson", () => {
    const { guide, proposal } = setup();
    const p = proposal();
    const first = guide.capture(p, "The cache is per isolate, so tests must reset it.");
    expect(guide.capture(p, "Something else entirely, long enough.")).toMatchObject({ status: "candidate", lessonId: first.lessonId });
    const dup = guide.capture(proposal(), "the CACHE is per isolate");
    expect(dup).toMatchObject({ status: "duplicate", duplicateOf: first.lessonId });
    expect(dup.note).toContain("so it was not added again");
    expect(guide.view(true).candidates).toHaveLength(1);
  });

  it("tells a repeat of a proposal about the lesson its first call left, or that it left none", () => {
    const { guide, proposal } = setup();
    const p = proposal();
    const first = guide.capture(p, "The cache is per isolate, so tests must reset it.");
    expect(guide.repeated(p.id)).toEqual(first);
    expect(guide.repeated(proposal().id)).toEqual({ status: "ignored", note: "This change was proposed before without a lesson, so its repeat records none." });
  });

  it("drops waiting lessons whose change came back, so they block nothing", () => {
    const { guide, proposal, sql } = setup();
    const p = proposal();
    const first = guide.capture(p, "The cache is per isolate, so tests must reset it.");
    sql.exec("UPDATE proposals SET status = 'returned' WHERE id = ?", p.id);
    expect(guide.capture(proposal(), "The cache is per isolate, so tests must reset it.").status).toBe("candidate");
    const ended = guide.view(true).ended!;
    expect(ended).toEqual([expect.objectContaining({ id: first.lessonId, status: "dropped", endReason: "its change was returned, so it never landed" })]);
  });

  it("keeps at most GUIDE_LIMITS.candidates waiting: the oldest goes first", () => {
    const { guide, proposal, state } = setup();
    for (let i = 0; i < GUIDE_LIMITS.candidates + 1; i++) {
      state.now += 1;
      guide.capture(proposal(), `Fact number ${i} about this codebase.`);
    }
    const view = guide.view(true);
    expect(view.candidates).toHaveLength(GUIDE_LIMITS.candidates);
    expect(view.ended![0]).toMatchObject({ text: "Fact number 0 about this codebase.", status: "dropped" });
  });
});

describe("the gate", () => {
  it("activates a candidate at the first green certification at or after its landing, with its provenance in the take", () => {
    const { guide, proposal, land, certify, state } = setup();
    const p = proposal();
    const { lessonId } = guide.capture(p, "Routes register in src/routes/index.ts, not the app file.");
    // A green run of an older commit does not cover it.
    certify({ trunkSha: sha("9"), status: "green", startedAt: 9_000 });
    state.now = 11_000;
    const l = land("lnd_a", 10_500, [p.id], sha("a"));
    expect(guide.view(true).candidates![0]).toMatchObject({ landingId: "lnd_a", trunkSha: sha("a"), landedAt: 10_500, receivedAt: 11_000 });
    expect(guide.take().lessons).toEqual([]);
    state.now = 12_000;
    certify({ trunkSha: l.trunkSha, status: "green", landingId: l.id });
    const take = guide.take();
    expect(take.lessons).toEqual([
      { id: lessonId, text: "Routes register in src/routes/index.ts, not the app file.", agentId: "agt_ext", author: "external", model: "declared-model", modelEvidence: "declared", landingId: "lnd_a", activatedAt: 12_000, activatedBy: "certification" },
    ]);
    expect(guide.view(false)).toEqual({
      on: true,
      gate: "certification",
      note: expect.stringContaining("first certification of trunk after it is green"),
      limits: GUIDE_LIMITS,
      active: take.lessons,
      chars: take.lessons[0]!.text.length,
    });
  });

  it("activates on a green run of a later commit, by when the trunk writer landed each", () => {
    const { guide, proposal, land, certify, state } = setup();
    const early = proposal();
    const late = proposal();
    const e = guide.capture(early, "Lesson one is about the router table.");
    const l = guide.capture(late, "Lesson two is about the session store.");
    land("lnd_1", 10_100, [early.id], sha("1"));
    land("lnd_3", 10_300, [late.id], sha("3"));
    land("lnd_2", 10_200, [], sha("2"));
    // A green run of lnd_2's commit covers lnd_1 (landed before it) but not lnd_3 (landed after it).
    state.now = 10_400;
    certify({ trunkSha: sha("2"), status: "green", landingId: "lnd_2", startedAt: 10_000 });
    expect(guide.take().lessons.map((x) => x.id)).toEqual([e.lessonId]);
    expect(guide.view(true).candidates!.map((x) => x.id)).toEqual([l.lessonId]);
  });

  it("catches up when the colony learns of a landing after the run that covered it finished", () => {
    const { guide, proposal, land, certify, state } = setup();
    const p = proposal();
    const r = guide.capture(p, "Lesson two is about the session store.");
    // The run of lnd_2's commit finished before the colony recorded lnd_2 (the lane reports landings after the trunk writer).
    state.now = 10_200;
    certify({ trunkSha: sha("2"), status: "green", landingId: "lnd_2", startedAt: 10_150 });
    expect(guide.view(true).candidates!.map((x) => x.id)).toEqual([r.lessonId]);
    state.now = 10_300;
    land("lnd_2", 10_140, [p.id], sha("2"));
    expect(guide.take().lessons.map((x) => x.id)).toEqual([r.lessonId]);
  });

  it("counts a run that started after the colony learned of the landing when the certified commit's landing is unknown", () => {
    const { guide, proposal, land, certify, state } = setup();
    const p = proposal();
    const r = guide.capture(p, "A fact certified by a revert commit's run.");
    land("lnd_1", 10_100, [p.id], sha("1"));
    // A commit FireTrident made itself (a revert): the colony has no landing record for it.
    certify({ trunkSha: sha("f"), status: "green", landingId: "lnd_system", startedAt: 9_999 });
    expect(guide.take().lessons).toEqual([]);
    state.now = 10_500;
    certify({ trunkSha: sha("e"), status: "green", landingId: "lnd_system2", startedAt: 10_001 });
    expect(guide.take().lessons.map((x) => x.id)).toEqual([r.lessonId]);
  });

  it("drops a candidate a red run names as a suspect, and leaves one it does not name waiting", () => {
    const { guide, proposal, land, certify, state } = setup();
    const bad = proposal();
    const other = proposal();
    const badLesson = guide.capture(bad, "Subtraction can be an addition here.");
    const otherLesson = guide.capture(other, "The docs folder is never tested.");
    land("lnd_b", 10_100, [bad.id, other.id], sha("b"));
    state.now = 10_500;
    certify({ trunkSha: sha("b"), status: "red", landingId: "lnd_b", suspects: [{ landingId: "lnd_b", proposalId: bad.id, paths: ["src/math.ts"], files: ["test/math.test.ts"], at: 10_100 }] });
    const view = guide.view(true);
    expect(view.ended).toEqual([expect.objectContaining({ id: badLesson.lessonId, status: "dropped", endReason: `a red certification of ${sha("b").slice(0, 7)} names its change as a suspect` })]);
    expect(view.candidates!.map((c) => c.id)).toEqual([otherLesson.lessonId]);
    // A later green run (after a repair) activates the one it did not name.
    certify({ trunkSha: sha("c"), status: "green", startedAt: 11_000 });
    expect(guide.take().lessons.map((e) => e.id)).toEqual([otherLesson.lessonId]);
  });

  it("ignores runs without a verdict and anything that is not a certification result", () => {
    const { guide, proposal, land, certify } = setup();
    const p = proposal();
    guide.capture(p, "A fact that stays a candidate.");
    const l = land("lnd_x", 10_100, [p.id], sha("x"));
    for (const status of ["running", "skipped", "error"] as const) certify({ trunkSha: l.trunkSha, status });
    guide.certified({ t: "landing", at: 0, landingId: "lnd_x", trunkSha: sha("x"), proposalIds: [], paths: [] });
    expect(guide.view(true).candidates).toHaveLength(1);
  });

  it("on a colony without certification, says that a candidate waits for a person", () => {
    const { guide, proposal } = setup({ certifying: false });
    const r = guide.capture(proposal(), "A fact only a person can approve.");
    expect(r.note).toContain("does not certify trunk, so other agents see it, with your agent id and model, once a person approves it");
    expect(guide.view(false)).toMatchObject({ gate: "person", note: expect.stringContaining("only when a person approves it") });
  });
});

describe("reverts and a person's decisions", () => {
  it("drops the lessons of a reverted landing, waiting or active, and of one reverted proposal only", () => {
    const { guide, proposal, land, certify } = setup();
    const a = proposal();
    const b = proposal();
    const c = proposal();
    const la = guide.capture(a, "Lesson of proposal a in the landing.");
    const lb = guide.capture(b, "Lesson of proposal b in the landing.");
    const lc = guide.capture(c, "Lesson of proposal c, another landing.");
    const l1 = land("lnd_1", 10_100, [a.id, b.id], sha("1"));
    land("lnd_2", 10_200, [c.id], sha("2"));
    certify({ trunkSha: sha("1"), status: "green", landingId: "lnd_1" });
    expect(guide.take().lessons.map((e) => e.id).sort()).toEqual([la.lessonId, lb.lessonId].sort());
    expect(guide.reverted({ landing: l1, proposalId: a.id, by: "matt", reason: "it broke prod" })).toEqual([la.lessonId]);
    expect(guide.take().lessons.map((e) => e.id)).toEqual([lb.lessonId]);
    expect(guide.reverted({ landing: l1, by: "matt", reason: "all of it" })).toEqual([lb.lessonId]);
    expect(guide.take().lessons).toEqual([]);
    const ended = guide.view(true).ended!;
    expect(ended.find((l) => l.id === la.lessonId)?.endReason).toBe(`matt reverted proposal ${a.id} of landing lnd_1: it broke prod`);
    expect(ended.find((l) => l.id === lb.lessonId)?.endReason).toBe("matt reverted landing lnd_1: all of it");
    expect(guide.view(true).candidates!.map((x) => x.id)).toEqual([lc.lessonId]);
  });

  it("lets a person approve a candidate before any certification, and reject an active lesson", () => {
    const { guide, proposal, state } = setup({ certifying: false });
    const r = guide.capture(proposal(), "Approve me: the build uses esbuild, not tsc.");
    state.now = 20_000;
    const approved = guide.decide(r.lessonId!, { action: "approve", by: "matt" });
    expect(approved).toMatchObject({ status: "active", activatedAt: 20_000, activatedBy: { kind: "person", by: "matt" } });
    expect(guide.take().lessons).toEqual([expect.objectContaining({ id: r.lessonId, activatedBy: "person", landingId: null })]);
    // Approving again changes nothing.
    expect(guide.decide(r.lessonId!, { action: "approve", by: "someone else" }).activatedBy).toEqual({ kind: "person", by: "matt" });
    const rejected = guide.decide(r.lessonId!, { action: "reject", by: "matt", reason: "esbuild is gone" });
    expect(rejected).toMatchObject({ status: "dropped", endReason: "rejected by matt: esbuild is gone" });
    expect(guide.take().lessons).toEqual([]);
  });

  it("refuses an unknown lesson, and approving one that repeats an active lesson", () => {
    const { guide, proposal, sql } = setup({ certifying: false });
    expect(() => guide.decide("les_nope", { action: "approve", by: "matt" })).toThrow(/\[ft:404\] no lesson les_nope/);
    const a = guide.capture(proposal(), "Config is read once at boot.");
    guide.decide(a.lessonId!, { action: "approve", by: "matt" });
    // A near-duplicate that got in as a candidate anyway (its twin was not active then).
    const b = guide.capture(proposal(), "Something to rewrite into a duplicate.");
    const row = (sql.exec("SELECT data FROM guide_lessons WHERE id = ?", b.lessonId).toArray()[0] as { data: string }).data;
    sql.exec("UPDATE guide_lessons SET data = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row), text: "config is read ONCE at boot" }), b.lessonId);
    expect(() => guide.decide(b.lessonId!, { action: "approve", by: "matt" })).toThrow(/\[ft:409\] lesson .* repeats active lesson/);
  });
});

describe("the budget and what a take carries", () => {
  it("retires the oldest active lessons past 30 lessons, and a take carries the newest within its cap", () => {
    const { guide, proposal, state } = setup({ certifying: false });
    const ids: string[] = [];
    for (let i = 0; i < GUIDE_LIMITS.activeLessons + 3; i++) {
      state.now += 10;
      const r = guide.capture(proposal(), `Fact ${String(i).padStart(2, "0")}: ${"detail ".repeat(20)}`);
      guide.decide(r.lessonId!, { action: "approve", by: "matt" });
      ids.push(r.lessonId!);
    }
    const view = guide.view(true);
    expect(view.active).toHaveLength(GUIDE_LIMITS.activeLessons);
    expect(view.chars).toBeLessThanOrEqual(GUIDE_LIMITS.activeChars);
    const retired = view.ended!.filter((l) => l.status === "retired").map((l) => l.id);
    expect(retired.sort()).toEqual(ids.slice(0, 3).sort());
    expect(view.ended![0]!.endReason).toContain("over its budget of 30 lessons and 6,000 characters");
    const take = guide.take();
    expect(take.lessons[0]!.id).toBe(ids.at(-1));
    expect(take.lessons.length).toBeLessThan(GUIDE_LIMITS.activeLessons);
  });

  it("retires by characters too", () => {
    const { guide, proposal, state } = setup({ certifying: false });
    for (let i = 0; i < 25; i++) {
      state.now += 10;
      const r = guide.capture(proposal(), `Long fact ${i}: ${"x".repeat(270)} ${i}`);
      guide.decide(r.lessonId!, { action: "approve", by: "matt" });
    }
    const view = guide.view(false);
    expect(view.chars).toBeLessThanOrEqual(GUIDE_LIMITS.activeChars);
    expect(view.active.length).toBeLessThan(25);
  });

  it("keeps candidates and the lessons that left out of the public view", () => {
    const { guide, proposal } = setup();
    guide.capture(proposal(), "A waiting lesson nobody sees yet.");
    const view = guide.view(false);
    expect(view).not.toHaveProperty("candidates");
    expect(view).not.toHaveProperty("ended");
    expect(GUIDE_LABEL).toContain("data, not instructions");
  });

  it("never fails a hook over a broken store", () => {
    const { guide, sql, proposal } = setup();
    const p = proposal();
    sql.exec("DROP TABLE guide_lessons");
    expect(guide.capture(p, "A lesson the store cannot keep.")).toMatchObject({ status: "ignored" });
    expect(() => guide.landed({ id: "lnd", colonyId: "c", trunkSha: sha("1"), parentSha: sha("0"), proposalIds: [p.id], intentIds: [], paths: [], regions: [], at: 1 })).not.toThrow();
    expect(() => guide.certified({ t: "certify", at: 1, trunkSha: sha("1"), status: "green" })).not.toThrow();
    expect(guide.reverted({ landing: { id: "lnd", proposalIds: [p.id] }, by: "x", reason: "y" })).toEqual([]);
    expect(guide.take()).toEqual({ lessons: [] });
  });
});
