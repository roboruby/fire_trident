import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, EventsPage, Rule } from "@fire_trident/core";
import type { SnapshotWithSeries } from "../../src/colony/metrics.ts";
import { addAgent, api, colony, newColony, proposeEdit, take, tick } from "./helpers.ts";

const RULE = { kind: "forbid-pattern", spec: { pattern: "console\\.log", hint: "use the logger" }, description: "No console.log" };

/** A colony with one rule (one violation), and one agent that fixes it and lands. */
async function oneRun() {
  const c = await newColony();
  const rule = await api<{ rule: Rule; violations: number }>("POST", `/colonies/${c.id}/rules`, RULE);
  expect(rule.body.violations).toBe(1);
  const agent = await addAgent(c.id, "fixer");
  const a = await take(c.id, agent.id);
  await proposeEdit(c.id, a, agent.id);
  await tick(c.id, "src");
  return { c, rule: rule.body.rule, agent, a };
}

const kinds = (events: ColonyEvent[]) =>
  events.map((e) => (e.t === "intent" || e.t === "proposal" ? `${e.t}:${e.status}` : e.t === "agent" ? `agent:${e.state}` : e.t === "violations" ? `violations:${e.total}` : e.t));

describe("GET /colonies/:id/events", () => {
  it("records a run at the source, with no one watching, and pages it oldest first", async () => {
    const { c, agent, a } = await oneRun();
    const page = (await api<EventsPage>("GET", `/colonies/${c.id}/events`)).body;
    expect(page.source).toBe("recorded");
    expect(page.next).toBeNull();
    expect(page.total).toBe(page.events.length);
    const seqs = page.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(page.first).toBe(page.events[0]?.at);
    expect(page.last).toBe(Math.max(...page.events.map((e) => e.at)));

    const k = kinds(page.events);
    expect(k).not.toContain("mark");
    for (const want of ["intent:open", "violations:1", "agent:idle", "intent:claimed", "agent:working", "proposal:ready", "proposal:landed", "intent:landed", "violations:0", "landing"]) {
      expect(k).toContain(want);
    }
    // In the order they happened: the rule's need, the agent joining, the claim, the landing, the fix.
    expect(k.indexOf("intent:open")).toBeLessThan(k.indexOf("intent:claimed"));
    expect(k.indexOf("intent:claimed")).toBeLessThan(k.indexOf("proposal:ready"));
    expect(k.indexOf("proposal:ready")).toBeLessThan(k.indexOf("landing"));
    expect(k.indexOf("violations:1")).toBeLessThan(k.indexOf("violations:0"));
    expect(page.events.find((e) => e.t === "agent" && e.state === "idle")).toMatchObject({ agentId: agent.id, kind: "synthetic" });
    expect(page.events.find((e) => e.t === "landing")).toMatchObject({ paths: a.intent.footprint });

    // Pages: `next` continues where a page stopped, and the pages add up to the whole record.
    const first = (await api<EventsPage>("GET", `/colonies/${c.id}/events?limit=3`)).body;
    expect(first.events).toHaveLength(3);
    expect(first.next).toBe(first.events[2]?.seq);
    const rest = (await api<EventsPage>("GET", `/colonies/${c.id}/events?after=${first.next}&limit=5000`)).body;
    expect(rest.next).toBeNull();
    // The colony keeps recording (field and metric samples settle after a landing): the pages are a prefix of the record.
    const paged = [...first.events, ...rest.events].map((e) => e.seq);
    expect(paged.slice(0, seqs.length)).toEqual(seqs);
    const later = (await api<EventsPage>("GET", `/colonies/${c.id}/events?limit=5000`)).body;
    expect(later.events.map((e) => e.seq).slice(0, paged.length)).toEqual(paged);
    expect((await api<EventsPage>("GET", `/colonies/${c.id}/events?after=${later.events.at(-1)?.seq}`)).body.events.length).toBeLessThanOrEqual(later.total);
  });

  it("samples live metrics into the record while the colony works", async () => {
    const { c } = await oneRun();
    // The trailing sample after the last write lands within a few seconds; read it as soon as it is there.
    let names: string[] = [];
    const start = Date.now();
    while (Date.now() - start < 6_000) {
      const page = (await api<EventsPage>("GET", `/colonies/${c.id}/events?limit=5000`)).body;
      names = page.events.filter((e) => e.t === "metric").map((e) => (e as { name: string }).name);
      if (names.includes("agentsActive") && names.includes("landings")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(names).toContain("agentsActive");
    expect(names).toContain("landings");
    expect(names).toContain("landingsPerMin");
  });

  it("reconstructs a replay for a run that has no record", async () => {
    const { c, agent } = await oneRun();
    // As if the run happened before recording began: no record, and nothing recorded from here on.
    await runInDurableObject(colony(c.id), (instance, state) => {
      const recorder = (instance as unknown as { recorder: { clear(): void; add(e: unknown): void } }).recorder;
      recorder.add = () => undefined;
      recorder.clear();
      state.storage.sql.exec("DELETE FROM events");
    });
    const page = (await api<EventsPage>("GET", `/colonies/${c.id}/events`)).body;
    expect(page.source).toBe("reconstructed");
    expect(page.next).toBeNull();
    const k = kinds(page.events);
    for (const want of ["intent:open", "violations:1", "agent:idle", "intent:claimed", "agent:working", "proposal:ready", "proposal:landed", "landing", "intent:landed", "violations:0"]) {
      expect(k).toContain(want);
    }
    expect(page.events.map((e) => e.seq)).toEqual(page.events.map((_, i) => i + 1));
    expect(page.events.find((e) => e.t === "agent" && e.state === "working")).toMatchObject({ agentId: agent.id });
    // A record that begins after the colony's first activity (work from before recording) does not
    // tell the whole story: "auto" still serves the reconstruction, and the record stays available.
    await runInDurableObject(colony(c.id), (_instance, state) => {
      const later = Date.now() + 60_000;
      state.storage.sql.exec("INSERT INTO events (at, t, data) VALUES (?, 'metric', ?)", later, JSON.stringify({ t: "metric", at: later, name: "landings", value: 1 }));
    });
    expect((await api<EventsPage>("GET", `/colonies/${c.id}/events`)).body.source).toBe("reconstructed");
    expect((await api<EventsPage>("GET", `/colonies/${c.id}/events?source=recorded`)).body).toMatchObject({ source: "recorded", total: 1 });
    // A recorded run can still be asked for its reconstruction.
    const forced = (await api<EventsPage>("GET", `/colonies/${c.id}/events?source=reconstructed&limit=2`)).body;
    expect(forced.source).toBe("reconstructed");
    expect(forced.events).toHaveLength(2);
    expect(forced.next).toBe(2);
    expect((await api("GET", "/colonies/no-such-colony/events")).status).toBe(404);
  });
});

describe("hero numbers and the funnel", () => {
  it("reports violations fixed since the latest rule change, and when the colony converged", async () => {
    const { c, rule } = await oneRun();
    const snap = (await api<SnapshotWithSeries>("GET", `/colonies/${c.id}`)).body;
    expect(snap.convergence).toMatchObject({ since: rule.createdAt, initial: 1, fixed: 1 });
    expect(snap.convergence?.convergedAt).toBeGreaterThanOrEqual(rule.createdAt);
    const m = (await api<{ convergence: SnapshotWithSeries["convergence"] }>("GET", `/colonies/${c.id}/metrics`)).body;
    expect(m.convergence).toEqual(snap.convergence);

    // A second rule is a new change: the count starts again from what it found.
    const second = await api<{ rule: Rule; violations: number }>("POST", `/colonies/${c.id}/rules`, { ...RULE, spec: { pattern: "TODO", hint: "finish it" }, description: "No TODOs" });
    const after = (await api<SnapshotWithSeries>("GET", `/colonies/${c.id}`)).body;
    expect(after.convergence).toEqual({ since: second.body.rule.createdAt, initial: second.body.violations, fixed: 0, convergedAt: second.body.violations > 0 ? null : null });
  });

  it("counts each proposal once, at the stage that settled it", async () => {
    const c = await newColony();
    await runInDurableObject(colony(c.id), (instance, state) => {
      (instance as unknown as { decider(): unknown }).decider();
      const add = (id: string, layer: string, action: string, human: string | null, vaccine = 0) =>
        state.storage.sql.exec(
          "INSERT INTO decide_outcomes (proposal_id, region, head, layer, action, risk, detectors, vaccine, state, at, human, human_at) VALUES (?, 'src', 'h', ?, ?, 0, '[]', ?, NULL, 1, ?, NULL)",
          id,
          layer,
          action,
          vaccine,
          human,
        );
      add("p1", "deterministic", "land", null);
      add("p2", "deterministic", "return", null);
      add("p3", "reflex", "land", null);
      add("p4", "llm", "land", null);
      add("p5", "reflex", "escalate", null);
      add("p6", "llm", "escalate", "approve");
      add("p7", "human", "none", "reject");
      add("p8", "reflex", "escalate", null, 1);
    });
    const snap = (await api<SnapshotWithSeries>("GET", `/colonies/${c.id}`)).body;
    expect(snap.funnel).toEqual({ proof: 2, reflex: 1, llm: 1, human: 3 });
    expect(snap.metrics).toMatchObject({ "funnel.proof": 2, decisions: 7 });
  });
});
