import { describe, expect, it } from "vitest";
import type { Colony, ColonyEvent, Id, Intent, Landing, Path, Proposal, Sha } from "@fire_trident/core";
import { ColonyAudit, type AuditHost } from "../../src/colony/audit.ts";
import type { ProposeInput } from "../../src/decide/engine.ts";
import { DecideStore } from "../../src/decide/store.ts";
import type { Env } from "../../src/env.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  return {
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
}

const COLONY: Colony = { id: "c1", name: "c1", trunk: { namespace: "ft-trunk", name: "c1", remote: "" }, trunkSha: "0".repeat(40), createdAt: 0, regionDepth: 1 };
const APP = "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n";

/** A colony around the audit: proposals, intents, blobs, landings and a trunk, all in memory. */
class Colonyish implements AuditHost {
  readonly env = {} as Env;
  readonly sql = sqlStorage();
  readonly store = new DecideStore(this.sql);
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly landings = new Map<Id, Landing>();
  readonly blobs = new Map<Sha, string>();
  readonly files = new Map<Path, string>([["src/app.ts", APP]]);
  readonly pending: Array<Promise<unknown>> = [];
  readonly events: ColonyEvent[] = [];
  readonly sealed: Array<{ id: Id; reason: string }> = [];
  readonly reverts: Array<{ landingId: Id; proposal: Id; reason: string; by: string }> = [];
  readonly proposed: Proposal[] = [];
  revertRefusal: string | null = null;
  readonly audit: ColonyAudit;
  private seq = 0;

  constructor() {
    this.audit = new ColonyAudit(this);
  }

  decide(): DecideStore {
    return this.store;
  }
  colony(): Colony {
    return COLONY;
  }
  proposal(id: Id): Proposal | null {
    const p = this.proposals.get(id);
    return p ? structuredClone(p) : null;
  }
  intent(id: Id): Intent | null {
    return this.intents.get(id) ?? null;
  }
  rules() {
    return [];
  }
  landing(id: Id): Landing | null {
    return this.landings.get(id) ?? null;
  }
  trunk() {
    return {
      baseBlobs: async (_sha: Sha, paths: Path[]) => paths.map((path) => ({ path, blob: this.blobOf(this.files.get(path) ?? null) })),
      blobsFor: async (paths: Path[]) => Object.fromEntries(paths.map((p) => [p, this.blobOf(this.files.get(p) ?? null)])),
      readFile: async (path: Path) => this.files.get(path) ?? null,
      files: async () => [...this.files].map(([path, text]) => ({ path, size: text.length, blob: this.blobOf(text)! })),
    };
  }
  read = async (_where: { namespace: string; name: string }, blobs: Sha[]) => new Map(blobs.map((b) => [b, this.blobs.has(b) ? new TextEncoder().encode(this.blobs.get(b)!) : null]));
  waitUntil(p: Promise<unknown>): void {
    this.pending.push(p);
  }
  publish(events: ColonyEvent[]): void {
    this.events.push(...events);
  }
  async revert(landingId: Id, p: { proposal: Id; reason: string; by: string }): Promise<{ landing: Landing }> {
    if (this.revertRefusal) throw new Error(this.revertRefusal);
    this.reverts.push({ landingId, ...p });
    return { landing: { id: "lnd_revert" } as Landing };
  }
  seal(id: Id, reason: string): void {
    this.sealed.push({ id, reason });
    this.save({ ...this.proposals.get(id)!, status: "rejected", reason });
  }
  async canaryAgent(): Promise<Id> {
    return "agt_canary";
  }
  vaccineTargets() {
    return [{ title: "Greet through the logger", why: "The colony logs through one module.", footprint: ["src/app.ts"] }];
  }
  sealedIntent(i: { title: string; why: string; footprint: Path[]; agentId: Id }): Id {
    const id = `int_c${++this.seq}`;
    this.intents.set(id, { id, colonyId: COLONY.id, title: i.title, why: i.why, source: "agent", footprint: i.footprint, priority: 0, status: "claimed", createdAt: 0, createdBy: "vaccine" });
    return id;
  }
  async propose(input: ProposeInput): Promise<Proposal> {
    const p: Proposal = { ...input, id: `prp_c${++this.seq}`, status: "checking", createdAt: Date.now(), evidence: { checks: [], ...input.evidence } };
    this.save(p);
    this.proposed.push(p);
    return p;
  }
  push = async (_env: Env, _colony: Id, changes: Array<{ files: Array<{ path: Path; content: string }>; message: string }>) => ({
    repo: { namespace: "ft-sessions", name: "c1--vaccine", remote: "" },
    commits: changes.map((c, i) => ({ head: `${i}`.padStart(40, "e"), blobs: Object.fromEntries(c.files.map((f) => [f.path, this.blob(f.content)])) })),
  });

  blob(text: string): Sha {
    const id = `${(++this.seq).toString(16).padStart(8, "0")}${"b".repeat(32)}`;
    this.blobs.set(id, text);
    return id;
  }
  blobOf(text: string | null): Sha | null {
    if (text === null) return null;
    for (const [id, t] of this.blobs) if (t === text) return id;
    return this.blob(text);
  }
  save(p: Proposal): void {
    this.proposals.set(p.id, p);
    this.sql.exec("INSERT INTO proposals (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", p.id, p.status);
  }

  /** A change to src/app.ts that the gate landed by `rule` (on `layer`), landed as its own landing; returns it. */
  land(rule: string, layer: "deterministic" | "reflex" | "llm", region = "src", over: Partial<Proposal> = {}): { p: Proposal; l: Landing } {
    const n = ++this.seq;
    const intent: Intent = { id: `int_${n}`, colonyId: COLONY.id, title: `Change ${n}`, why: "test", source: "human", footprint: ["src/app.ts"], priority: 1, status: "landed", createdAt: 0, createdBy: "t" };
    this.intents.set(intent.id, intent);
    const after = `${APP}export const n${n} = ${n};\n`;
    const p: Proposal = {
      id: `prp_${n}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_1",
      workspace: { namespace: "ft-sessions", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${n}`.padStart(40, "f"),
      writeSet: [{ path: "src/app.ts", blob: this.blob(after) }],
      readSet: [{ path: "src/app.ts", blob: this.blobOf(APP) }],
      declared: { footprint: ["src/app.ts"], summary: "edit" },
      evidence: { checks: [{ name: "gate", ok: true, ms: 0, detail: `${rule} → land by ${layer} at head 0123: ok`, gate: { rule, preset: "central-development", values: [] } }] },
      status: "landed",
      createdAt: n,
      landingId: `lnd_${n}`,
      ...over,
    };
    this.save(p);
    this.store.recordOutcome({ proposalId: p.id, region, head: p.headSha, layer, action: "land", risk: 0, detectors: [], vaccine: false, state: null, at: n });
    const l: Landing = { id: `lnd_${n}`, colonyId: COLONY.id, trunkSha: `${n}`.padStart(40, "1"), parentSha: COLONY.trunkSha, proposalIds: [p.id], intentIds: [intent.id], paths: ["src/app.ts"], regions: [region], at: n };
    this.landings.set(l.id, l);
    return { p, l };
  }

  /** An escalated proposal waiting for a person. */
  escalate(): Proposal {
    const n = ++this.seq;
    const p: Proposal = {
      id: `prp_e${n}`,
      colonyId: COLONY.id,
      intentId: `int_e${n}`,
      agentId: "agt_1",
      workspace: { namespace: "ft-sessions", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${n}`.padStart(40, "a"),
      writeSet: [],
      readSet: [],
      declared: { footprint: [], summary: "risky" },
      evidence: { checks: [] },
      status: "escalated",
      createdAt: n,
    };
    this.save(p);
    return p;
  }

  async settle(): Promise<void> {
    while (this.pending.length > 0) await Promise.all(this.pending.splice(0));
  }
}

type Item = Proposal & { audit?: { kind: string; layer: string; rule: string; landedBy: string; landingId: string }; review?: { files: Array<{ path: string; hunks: string }> } };

describe("the audit sample at a landing", () => {
  it("puts the first landing of each confirming layer in the queue, after the landing, and counts the rest", () => {
    const c = new Colonyish();
    const first = c.land("L3 innate+llm", "llm");
    c.audit.landed(first.l, [first.p]);
    const second = c.land("L3 innate+llm", "llm");
    c.audit.landed(second.l, [second.p]);
    const proof = c.land("D3 innate+proof", "deterministic");
    c.audit.landed(proof.l, [proof.p]);
    expect(c.audit.store.pending(10).map((r) => [r.proposalId, r.layer, r.rule, r.why])).toEqual([
      [first.p.id, "model", "L3 innate+llm", "first"],
      [proof.p.id, "deterministic", "D3 innate+proof", "first"],
    ]);
    expect(c.audit.measures()).toMatchObject({ landed: 3, queued: 2, pending: 2, audited: 0, rate: 0.03 });
  });

  it("never holds or breaks a landing: it runs after it, and a failure is only logged", () => {
    const c = new Colonyish();
    const { p, l } = c.land("R3 innate+autonomy", "reflex");
    // The proposal already landed when the colony calls in; nothing here changes it.
    c.audit.landed(l, [p]);
    expect(c.proposals.get(p.id)?.status).toBe("landed");
    // A broken table costs the sample, never the landing.
    c.sql.exec("DROP TABLE decide_audit_strata");
    c.sql.exec("CREATE TABLE decide_audit_strata (layer TEXT)");
    const next = c.land("R3 innate+autonomy", "reflex");
    expect(() => c.audit.landed(next.l, [next.p])).not.toThrow();
    expect(c.proposals.get(next.p.id)?.status).toBe("landed");
  });

  it("leaves out what a person approved, vaccines, and landings with no review", () => {
    const c = new Colonyish();
    const approved = c.land("P1 danger pattern", "deterministic", "src", { approvedAt: 9 });
    c.store.recordHuman(approved.p.id, "src", approved.p.headSha, "approve", 9);
    c.audit.landed(approved.l, [approved.p]);
    const unreviewed = c.land("", "deterministic", "src", { evidence: { checks: [] } });
    c.sql.exec("DELETE FROM decide_outcomes WHERE proposal_id = ?", unreviewed.p.id);
    c.audit.landed(unreviewed.l, [unreviewed.p]);
    const off = new Colonyish();
    off.store.setPolicy({ auditRate: 0 });
    const model = off.land("L3 innate+llm", "llm");
    off.audit.landed(model.l, [model.p]);
    expect(c.audit.store.pending(10)).toEqual([]);
    expect(off.audit.store.pending(10)).toEqual([]);
    expect(off.audit.measures().line).toBe("audit sample off: 1 landing without a person, none put in front of a person");
  });
});

describe("the baseline stream in the review queue", () => {
  it("shows audit items among the escalations, marked and with the change that landed", async () => {
    const c = new Colonyish();
    const escalations = Array.from({ length: 7 }, () => c.escalate());
    const proof = c.land("D3 innate+proof", "deterministic");
    c.audit.landed(proof.l, [proof.p]);
    const model = c.land("L3 innate+llm", "llm");
    c.audit.landed(model.l, [model.p]);
    await c.settle();
    const queue = c.audit.queue(escalations.map((p) => c.proposal(p.id)!)) as Item[];
    expect(queue.map((p) => p.id)).toEqual([...escalations.slice(0, 5).map((p) => p.id), proof.p.id, ...escalations.slice(5).map((p) => p.id), model.p.id]);
    const item = queue[5]!;
    expect(item.status).toBe("landed");
    expect(item.audit).toMatchObject({ kind: "audit", layer: "deterministic", rule: "D3 innate+proof", landedBy: "Already landed by D3 innate+proof (a deterministic proof).", landingId: proof.l.id });
    expect(item.review?.files[0]?.path).toBe("src/app.ts");
    expect(item.review?.files[0]?.hunks).toContain("+export const n");
    expect(queue.filter((p) => !(p as Item).audit).every((p) => p.status === "escalated")).toBe(true);
  });

  it("shows them when nothing else waits, and the queue as it was when the audit cannot be read", () => {
    const c = new Colonyish();
    const { p, l } = c.land("R3 innate+autonomy", "reflex");
    c.audit.landed(l, [p]);
    expect((c.audit.queue([]) as Item[]).map((x) => x.audit?.layer)).toEqual(["autonomy"]);
    const e = c.escalate();
    c.sql.exec("DROP TABLE decide_audit");
    c.sql.exec("CREATE TABLE decide_audit (proposal_id TEXT)");
    expect(c.audit.queue([e]).map((x) => x.id)).toEqual([e.id]);
  });
});

describe("a person's answer", () => {
  it("records fine, and refuses a second answer or an id the sample never took", async () => {
    const c = new Colonyish();
    const { p, l } = c.land("L3 innate+llm", "llm");
    c.audit.landed(l, [p]);
    const fine = await c.audit.answer(p.id, { verdict: "fine", by: "lee" });
    expect(fine).toEqual({ proposalId: p.id, verdict: "fine", layer: "model", rule: "L3 innate+llm", sentence: `Recorded as fine: ${p.id} landed by L3 innate+llm (a model's approval) and should have.` });
    await expect(c.audit.answer(p.id, { verdict: "fine" })).rejects.toThrow(/already answered fine by lee/);
    await expect(c.audit.answer("prp_nope", { verdict: "fine" })).rejects.toThrow(/not in the audit queue/);
    await expect(c.audit.answer(p.id, { verdict: "maybe" })).rejects.toThrow(/verdict must be one of: fine, should-not-have-landed/);
    expect(c.audit.queue([])).toEqual([]);
    expect(c.audit.measures()).toMatchObject({ audited: 1, fine: 1, wrong: 0, pending: 0 });
  });

  it("should not have landed: needs a reason, offers the revert, and takes back earned autonomy when autonomy landed it", async () => {
    const c = new Colonyish();
    const auto = c.land("R3 innate+autonomy", "reflex", "src/api");
    c.audit.landed(auto.l, [auto.p]);
    await expect(c.audit.answer(auto.p.id, { verdict: "should-not-have-landed" })).rejects.toThrow(/say why it should not have landed/);
    const res = await c.audit.answer(auto.p.id, { verdict: "should-not-have-landed", reason: "it drops the rate limit", by: "lee" });
    expect(res.revoked).toBe("src/api");
    expect(res.revert).toEqual({
      command: `ft revert c1 ${auto.p.id} --reason "it drops the rate limit"`,
      route: `POST /api/colonies/c1/landings/${auto.l.id}/revert {"reason": ..., "proposal": "${auto.p.id}"}`,
    });
    expect(res.sentence).toBe(
      `Recorded: ${auto.p.id} should not have landed by R3 innate+autonomy (earned autonomy). Earned autonomy in src/api is taken back: its changes need a proof, a model's approval or a person again until it earns it back. To undo it: ft revert c1 ${auto.p.id} --reason "it drops the rate limit"`,
    );
    const row = c.store.autonomyTable(3).find((r) => r.region === "src/api");
    expect(row?.reason).toBe(`audit: ${auto.p.id} should not have landed (lee): it drops the rate limit`);
    expect(c.reverts).toEqual([]);
    // Recorded per confirming layer.
    expect(c.audit.measures().layers.autonomy).toMatchObject({ audited: 1, wrong: 1, wrongRate: 1 });
  });

  it("reverts on request, keeps the verdict when the revert is refused, and leaves autonomy alone for a model's landing", async () => {
    const c = new Colonyish();
    const model = c.land("L3 innate+llm", "llm", "src/web");
    c.audit.landed(model.l, [model.p]);
    const res = await c.audit.answer(model.p.id, { verdict: "should-not-have-landed", reason: "wrong endpoint", by: "lee", revert: true });
    expect(res.revoked).toBeUndefined();
    expect(res.revert).toEqual({ landingId: "lnd_revert" });
    expect(c.reverts).toEqual([{ landingId: model.l.id, proposal: model.p.id, reason: "audit: should not have landed: wrong endpoint", by: "lee" }]);
    expect(c.store.autonomyTable(3).find((r) => r.region === "src/web")?.revokedAt ?? null).toBeNull();

    const proof = c.land("D3 innate+proof", "deterministic", "src/web");
    c.audit.landed(proof.l, [proof.p]);
    c.revertRefusal = `work landed on top of ${proof.l.id}: src/app.ts changed since`;
    const refused = await c.audit.answer(proof.p.id, { verdict: "should-not-have-landed", reason: "broke the build", revert: true });
    expect(refused.revert).toEqual({ error: `work landed on top of ${proof.l.id}: src/app.ts changed since` });
    expect(refused.sentence).toContain("The revert was refused: work landed on top of");
    expect(c.audit.store.get(proof.p.id)).toMatchObject({ verdict: "should-not-have-landed", revert: { error: expect.stringContaining("work landed on top") } });
    await expect(c.audit.answer(c.land("D3 innate+proof", "deterministic").p.id, { verdict: "fine", revert: true })).rejects.toThrow(/not in the audit queue|revert goes with/);
  });
});

describe("blind canaries", () => {
  it("make a sealed change of a class a person must see, as the canary agent, kept out of the vaccination meter", async () => {
    const c = new Colonyish();
    const id = await c.audit.injectCanary("prp_trigger");
    expect(id).toBe(c.proposed[0]!.id);
    const p = c.proposed[0]!;
    expect(p).toMatchObject({ agentId: "agt_canary", workspace: { name: "c1--vaccine" }, declared: { footprint: ["src/app.ts"] } });
    // Sealed the way a vaccine is: nothing can land it.
    expect(c.store.vaccineByIntent(p.intentId)).toMatchObject({ batch: "canary", proposalId: p.id });
    expect(c.store.vaccines()).toEqual([]);
    const text = c.blobs.get(p.writeSet[0]!.blob!)!;
    expect(text).toMatch(/process\.env\.|child_process/);
    expect(c.audit.measures().canaries).toMatchObject({ made: 1, waiting: 1, decided: 0 });
  });

  it("an approved canary is revealed at once and sealed, so it never lands; a rejection is a catch", async () => {
    const c = new Colonyish();
    c.store.setPolicy({ canaryRate: 0.1 });
    await c.audit.injectCanary("prp_one");
    const approved = c.proposed[0]!;
    c.save({ ...approved, status: "escalated" });
    const reveal = c.audit.canaryDecision(c.proposal(approved.id)!, "approve", "", "lee");
    expect(reveal?.canary).toMatchObject({ proposalId: approved.id, outcome: "approved" });
    expect(reveal?.canary.sentence).toMatch(/^This was a canary, not a real change: a sealed known-bad change that .+ You approved it, so it counts as missed; it was sealed and can never land, so nothing changed\./);
    expect(c.proposals.get(approved.id)?.status).toBe("rejected");
    expect(c.sealed[0]?.reason).toBe(`canary (sealed): ${reveal!.canary.sentence}`);

    await c.audit.injectCanary("prp_two");
    const caught = c.proposed[1]!;
    c.save({ ...caught, status: "escalated" });
    const second = c.audit.canaryDecision(c.proposal(caught.id)!, "reject", "logs a token", "lee");
    expect(second?.canary.outcome).toBe("caught");
    expect(second?.canary.sentence).toMatch(/^Caught: this was a canary, not a real change: .+ Your rejection counts as a catch; it was discarded, no antibody was minted, and nothing changed\.$/);

    const m = c.audit.measures().canaries;
    expect(m).toMatchObject({ on: true, decided: 2, caught: 1, approved: 1, catchRate: 0.5, lo: 0.095, hi: 0.905 });
    expect(m.line).toBe("canaries: 1 of 2 caught (50%, 10–91%), 1 approved");
    expect(m.revealed.map((r) => r.proposalId)).toEqual([caught.id, approved.id]);
    // Any other proposal is decided as before.
    expect(c.audit.canaryDecision(c.escalate(), "approve", "", "lee")).toBeNull();
  });

  it("are drawn only when a person turned them on, from the escalation's id, one waiting at a time", async () => {
    const c = new Colonyish();
    c.audit.escalated({ id: "prp_x", intentId: "int_x" });
    expect(c.pending).toHaveLength(0);
    c.store.setPolicy({ canaryRate: 0.2 });
    // The draw is the escalation id's hash: find ids that draw one, as the colony would meet them.
    const ids = Array.from({ length: 200 }, (_, i) => `prp_${i}`);
    const { canaryDraw } = await import("../../src/decide/canary.ts");
    const drawing = ids.filter((id) => canaryDraw(id, 0.2));
    expect(drawing.length).toBeGreaterThan(20);
    expect(drawing.length).toBeLessThan(60);
    c.audit.escalated({ id: drawing[0]!, intentId: "int_a" });
    c.audit.escalated({ id: drawing[1]!, intentId: "int_b" });
    await c.settle();
    expect(c.proposed).toHaveLength(1);
    // One is waiting: the next draw makes none until it is decided.
    c.audit.escalated({ id: drawing[2]!, intentId: "int_c" });
    await c.settle();
    expect(c.proposed).toHaveLength(1);
    // A canary's own escalation never draws another.
    c.save({ ...c.proposed[0]!, status: "escalated" });
    c.audit.canaryDecision(c.proposal(c.proposed[0]!.id)!, "reject", "no", "lee");
    c.audit.escalated({ id: drawing[3]!, intentId: c.proposed[0]!.intentId });
    await c.settle();
    expect(c.proposed).toHaveLength(1);
    c.audit.escalated({ id: drawing[4]!, intentId: "int_d" });
    await c.settle();
    expect(c.proposed).toHaveLength(2);
  });
});

describe("the measures", () => {
  it("serves the line the card shows, per layer, with the canaries and people's decisions over time", async () => {
    const c = new Colonyish();
    const a = c.land("L3 innate+llm", "llm");
    c.audit.landed(a.l, [a.p]);
    await c.audit.answer(a.p.id, { verdict: "fine" });
    const m = c.audit.measures();
    expect(m).toMatchObject({ rate: 0.03, every: 5, landed: 1, audited: 1, wrong: 0, line: "audited 1 of 1 landing without a person: 0 should not have landed (0–79%)" });
    expect(Object.keys(m.layers)).toEqual(["deterministic", "reproduction", "model", "autonomy"]);
    expect(m.canaries.line).toBe("canaries off");
    expect(m.reviewers.weeks).toHaveLength(8);
    expect(c.audit.summary()).toMatchObject({ line: m.line, rate: 0.03, audited: 1, canaries: "canaries off" });
    expect(c.events.some((e) => e.t === "metric" && e.name === "audit.audited" && e.value === 1)).toBe(true);
  });
});
