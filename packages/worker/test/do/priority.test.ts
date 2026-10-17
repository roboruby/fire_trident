import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonySnapshot, Intent, LineageNote } from "@fire_trident/core";
import { REPAIR_PRIORITY } from "../../src/certify/repair.ts";
import type { ColonyDO } from "../../src/colony/ColonyDO.ts";
import { SPLIT_PRIORITY } from "../../src/colony/megafile.ts";
import { migratePriority } from "../../src/colony/priority.ts";
import { FireTridentTools, type McpColonyRpc, type Session, type ToolContext } from "../../src/mcp/tools.ts";
import { addAgent, api, colony, eventually, newColony, proposeEdit, region, rows, take } from "./helpers.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * Agent-declared priority (colony/priority.ts) through the real ColonyDO and RegionDO: an agent's intent takes at most
 * its parent's priority, or 1 with no parent, so an agent that asks for 1000 never puts its work above a red trunk's
 * repair, in take order or in its region's lane; a person, a rule and the platform are not capped, and only a person's
 * amendment raises an agent's intent. What the agent asked is kept, returned with the intent, told in the declare
 * answers (POST /intents and MCP declare) and carried into the lineage note.
 */

type Declared = Intent & { priorityNote?: string };

/** What an agent declares through POST /intents: source agent, created by the agent (`by`, agt_declarer unless named). */
async function agentDeclare(colonyId: string, footprint: string[], priority: number, parentId?: string, by = "agt_declarer"): Promise<Declared> {
  const res = await api<Declared>("POST", `/colonies/${colonyId}/intents`, {
    title: `Change ${footprint.join(", ")}`,
    why: "An agent found this while working.",
    footprint,
    source: "agent",
    createdBy: by,
    priority,
    ...(parentId ? { parentId } : {}),
  });
  expect(res.status).toBe(201);
  return res.body;
}

/** A red trunk's repair intent, declared as the certifier declares it (ColonyDO.addIntent, source certify). */
async function repairIntent(colonyId: string, footprint = ["src/math.ts"]): Promise<Intent> {
  return colony(colonyId).addIntent({
    colonyId,
    title: "Make the failing tests pass: subtracts",
    why: "Trunk fails 1 of its 4 tests.",
    source: "certify",
    footprint,
    acceptance: ["The tests pass"],
    priority: REPAIR_PRIORITY,
    createdBy: "certify",
  });
}

async function intentOf(colonyId: string, id: string): Promise<Intent> {
  const res = await api<{ intent: Intent }>("GET", `/colonies/${colonyId}/intents/${id}`);
  expect(res.status).toBe(200);
  return res.body.intent;
}

const NO_PARENT = (asked: number) => `You asked for priority ${asked}; an agent's intent with no parent takes at most the default priority (1), so it was declared at 1. A person can raise it.`;
const UNDER = (asked: number, cap: number) => `You asked for priority ${asked}; an agent's intent takes at most its parent's priority (${cap}), so it was declared at ${cap}. A person can raise it.`;
const NOT_YOURS = (asked: number) => `You asked for priority ${asked}; its parent is not an intent you hold or declared, so it was declared at 1. A person can raise it.`;

describe("an agent's priority is capped", () => {
  it("at 1 with no parent: asking for 1000 never outranks a repair intent, in take order or in the lane", async () => {
    const c = await newColony();
    // The agent's intent is declared first, so it is the older one: only priority can put the repair ahead of it.
    const mine = await agentDeclare(c.id, ["src/feature.ts"], 1000);
    expect(mine).toMatchObject({ source: "agent", priority: 1, requestedPriority: 1000, priorityNote: NO_PARENT(1000) });
    const repair = await repairIntent(c.id);
    expect(repair).toMatchObject({ source: "certify", priority: REPAIR_PRIORITY });
    expect(repair).not.toHaveProperty("requestedPriority");

    // Need marks carry the granted priority as their strength.
    const marks = await rows<{ strength: number }>(region(c.id, "src"), "SELECT strength FROM marks WHERE kind = 'need' AND intent_id = ?", mine.id);
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect(m.strength).toBe(1);

    // Take: the repair first, though it is newer.
    const fixer = await addAgent(c.id, "fixer");
    const builder = await addAgent(c.id, "builder");
    const first = await take(c.id, fixer.id);
    expect(first.intent.id).toBe(repair.id);
    const second = await take(c.id, builder.id);
    expect(second.intent.id).toBe(mine.id);

    // Lane: the agent's change is proposed first, the repair's after it; the repair's waits ahead of it.
    const late = await proposeEdit(c.id, second, builder.id);
    const fix = await proposeEdit(c.id, first, fixer.id);
    const lane = await eventually(
      () => rows<{ id: string; priority: number }>(region(c.id, "src"), "SELECT id, priority FROM lane ORDER BY priority DESC, created_at ASC"),
      (r) => r.length === 2,
    );
    expect(lane).toEqual([
      { id: fix.id, priority: REPAIR_PRIORITY },
      { id: late.id, priority: 1 },
    ]);
  });

  it("at its parent's priority under a parent it holds: an agent holding a repair intent may declare up to the repair's", async () => {
    const c = await newColony();
    const repair = await repairIntent(c.id);
    const fixer = await addAgent(c.id, "fixer");
    expect((await take(c.id, fixer.id)).intent.id).toBe(repair.id);
    const child = await agentDeclare(c.id, ["src/math-helpers.ts"], 1000, repair.id, fixer.id);
    expect(child).toMatchObject({ priority: REPAIR_PRIORITY, requestedPriority: 1000, priorityCap: "parent", parentId: repair.id, priorityNote: UNDER(1000, REPAIR_PRIORITY) });
    const under = await agentDeclare(c.id, ["src/math-format.ts"], 6, repair.id, fixer.id);
    expect(under.priority).toBe(6);
    expect(under).not.toHaveProperty("requestedPriority");
    expect(under).not.toHaveProperty("priorityNote");
    // Under an intent it declared (open, held by nobody), it takes at most that one's priority.
    const grandchild = await agentDeclare(c.id, ["src/math-parse.ts"], 1000, under.id, fixer.id);
    expect(grandchild).toMatchObject({ priority: 6, requestedPriority: 1000, priorityCap: "parent", priorityNote: UNDER(1000, 6) });
    // An agent's child of its own intent with no parent stays at 1.
    const root = await agentDeclare(c.id, ["docs/a.md"], 1, undefined, fixer.id);
    expect(await agentDeclare(c.id, ["docs/b.md"], 1000, root.id, fixer.id)).toMatchObject({ priority: 1, requestedPriority: 1000, priorityCap: "parent" });
  });

  it("at 1 under a parent it neither holds nor declared: naming someone else's repair borrows nothing", async () => {
    const c = await newColony();
    const repair = await repairIntent(c.id);
    const fixer = await addAgent(c.id, "fixer");
    expect((await take(c.id, fixer.id)).intent.id).toBe(repair.id);
    // Another agent names the repair the fixer holds as its parent.
    const other = await addAgent(c.id, "other");
    const borrowed = await agentDeclare(c.id, ["src/math-helpers.ts"], 1000, repair.id, other.id);
    expect(borrowed).toMatchObject({ priority: 1, requestedPriority: 1000, priorityCap: "other-parent", parentId: repair.id, priorityNote: NOT_YOURS(1000) });
    expect(await intentOf(c.id, borrowed.id)).toMatchObject({ priority: 1, requestedPriority: 1000, priorityCap: "other-parent" });
    // An open repair nobody holds is nobody's either; asking for 1 or less is granted as asked.
    const open = await repairIntent(c.id, ["src/other.ts"]);
    expect(await agentDeclare(c.id, ["src/other-helpers.ts"], 1000, open.id, other.id)).toMatchObject({ priority: 1, priorityCap: "other-parent" });
    const modest = await agentDeclare(c.id, ["src/other-format.ts"], 1, open.id, other.id);
    expect(modest.priority).toBe(1);
    expect(modest).not.toHaveProperty("priorityNote");
    // Once the fixer no longer holds the repair (released), its own child of it is capped at 1 too.
    await colony(c.id).abandon(fixer.id, "giving it back");
    const after = await agentDeclare(c.id, ["src/math-late.ts"], 1000, repair.id, fixer.id);
    expect(after).toMatchObject({ priority: 1, priorityCap: "other-parent" });
  });

  it("only for agents: a person, a rule, certification and the platform keep what they ask", async () => {
    const c = await newColony();
    const ask = (source: string) => api<Declared>("POST", `/colonies/${c.id}/intents`, { title: `From ${source}`, why: "w", footprint: [`docs/${source}.md`], source, priority: 1000 });
    for (const source of ["human", "rule"]) {
      const res = await ask(source);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ source, priority: 1000 });
      expect(res.body).not.toHaveProperty("requestedPriority");
      expect(res.body).not.toHaveProperty("priorityNote");
    }
    const agentRoot = await agentDeclare(c.id, ["docs/agent.md"], 1);
    // A person's child of an agent's intent is not capped either.
    const person = await api<Declared>("POST", `/colonies/${c.id}/intents`, { title: "A person's child", why: "w", footprint: ["docs/person.md"], parentId: agentRoot.id, priority: 1000 });
    expect(person.body).toMatchObject({ source: "human", priority: 1000 });
    for (const [source, priority] of [["certify", 1000], ["system", 1000], ["system", SPLIT_PRIORITY]] as const) {
      const i = await colony(c.id).addIntent({ colonyId: c.id, title: `From ${source}`, why: "w", source, footprint: [`docs/${source}-${priority}.md`], priority, createdBy: source });
      expect(i).toMatchObject({ source, priority });
      expect(i).not.toHaveProperty("requestedPriority");
    }
  });

  it("is raised only by a person's amendment, and what was asked stays visible until the intent has it", async () => {
    const c = await newColony();
    const mine = await agentDeclare(c.id, ["src/feature.ts"], 1000);
    const patch = (body: Record<string, unknown>, headers?: Record<string, string>) => api<{ intent: Intent }>("PATCH", `/colonies/${c.id}/intents/${mine.id}`, body, headers);
    expect((await patch({ priority: 50, reason: "worth more than the default" }, {})).status).toBe(401);
    const raised = await patch({ priority: 50, reason: "worth more than the default", by: "matt" });
    expect(raised.status).toBe(200);
    expect(raised.body.intent).toMatchObject({ priority: 50, requestedPriority: 1000 });
    const granted = await patch({ priority: 1000, reason: "as the agent asked", by: "matt" });
    expect(granted.body.intent.priority).toBe(1000);
    expect(granted.body.intent).not.toHaveProperty("requestedPriority");
  });
});

describe("what the agent asked for", () => {
  it("round-trips: returned with the intent everywhere, and handed to the lineage note", async () => {
    const c = await newColony();
    const mine = await agentDeclare(c.id, ["src/feature.ts"], 1000);
    const repair = await repairIntent(c.id);
    expect(await intentOf(c.id, mine.id)).toMatchObject({ priority: 1, requestedPriority: 1000 });
    expect(await colony(c.id).getIntent(mine.id)).toMatchObject({ priority: 1, requestedPriority: 1000 });
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.intents.find((i) => i.id === mine.id)).toMatchObject({ priority: 1, requestedPriority: 1000 });
    expect(snap.intents.find((i) => i.id === repair.id)).not.toHaveProperty("requestedPriority");
    const ctx = await colony(c.id).landContext([mine.id, repair.id], []);
    expect(ctx.intents[mine.id]).toMatchObject({ priority: 1, requestedPriority: 1000 });
    expect(ctx.intents[repair.id]).not.toHaveProperty("requestedPriority");
    expect(ctx.intents[repair.id]).not.toHaveProperty("priority");
  });

  it("reads fine from an older table without the column, and from rows written before it", async () => {
    const c = await newColony();
    const mine = await agentDeclare(c.id, ["src/feature.ts"], 1000);
    await runInDurableObject(colony(c.id), async (instance: ColonyDO, state: DurableObjectState) => {
      const sql = state.storage.sql;
      // A colony from before the cap: no column, and an agent's row asked at 1000 that nothing capped.
      sql.exec("ALTER TABLE intents DROP COLUMN requested_priority");
      sql.exec("ALTER TABLE intents DROP COLUMN priority_cap");
      sql.exec(
        `INSERT INTO intents (id, title, why, source, rule_id, parent_id, footprint, acceptance, priority, status, created_at, created_by, assigned_to, violations, updated_at)
         VALUES ('int_before', 'Older', '', 'agent', NULL, NULL, '["docs/old.md"]', NULL, 1000, 'open', 0, 'agt_old', NULL, 0, 0)`,
      );
      const old = (await instance.getIntent("int_before")) as Intent;
      expect(old).toMatchObject({ id: "int_before", priority: 1000 });
      expect(old).not.toHaveProperty("requestedPriority");
      expect((await instance.getIntent(mine.id))?.priority).toBe(1);
      // The migration the object runs when it starts adds the column back, once; the rows keep what they had.
      migratePriority(sql);
      migratePriority(sql);
      const cols = sql.exec<{ name: string }>("PRAGMA table_info(intents)").toArray().filter((r) => r.name === "requested_priority" || r.name === "priority_cap");
      expect(cols.map((r) => r.name)).toEqual(["requested_priority", "priority_cap"]);
      expect(await instance.getIntent("int_before")).not.toHaveProperty("requestedPriority");
    });
    // New declarations keep what they asked again.
    expect(await agentDeclare(c.id, ["docs/new.md"], 7)).toMatchObject({ priority: 1, requestedPriority: 7 });
  });

  it("is a line in the lineage note's intent only when it differs from the priority granted", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const sql = (w.trunk as unknown as { sql: SqlStorage }).sql;
      const stored = (id: string): LineageNote => JSON.parse(sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", id).one().note) as LineageNote;
      const capped = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      const one = landed(await w.trunk.land([capped], { intents: { [capped.intentId]: { title: "Capped", why: "w", priority: 1, requestedPriority: 1000 } } }));
      expect(stored(one.id).proposals[0]?.intent).toEqual({ id: capped.intentId, title: "Capped", why: "w", priority: 1, requestedPriority: 1000 });
      const plain = await w.proposal({ "src/b.ts": "export const b = 1;\n" });
      const two = landed(await w.trunk.land([plain], { intents: { [plain.intentId]: { title: "Plain", why: "w" } } }));
      expect(stored(two.id).proposals[0]?.intent).toEqual({ id: plain.intentId, title: "Plain", why: "w" });
    });
  });
});

describe("the MCP declare answer", () => {
  it("says when the cap lowered the priority, with no parent and under the intent the agent holds, and again on a replay", async () => {
    const c = await newColony();
    const repair = await repairIntent(c.id);
    let session: Session = { reads: {}, proposals: [] };
    const ctx: ToolContext = {
      colony: (id) => colony(id) as unknown as McpColonyRpc,
      region: () => {
        throw new Error("not used");
      },
      trunk: () => ({ why: async () => [] }),
      repo: async () => {
        throw new Error("not used");
      },
      load: async () => structuredClone(session),
      save: async (s) => {
        session = structuredClone(s);
      },
      now: () => Date.now(),
      sleep: async () => undefined,
    };
    const tools = new FireTridentTools(ctx);
    await tools.join({ colony: c.id, name: "outside" });
    const ask = { title: "Cache the parser", why: "Parsing is slow.", footprint: ["docs/parser.md"], priority: 1000 };

    const alone = (await tools.declare(ask)) as Record<string, unknown>;
    expect(alone).toMatchObject({ intent: { parentId: null, status: "open" }, priority: 1, requestedPriority: 1000, priorityNote: NO_PARENT(1000) });
    const again = (await tools.declare(ask)) as Record<string, unknown>;
    expect(again).toMatchObject({ replayed: true, priority: 1, requestedPriority: 1000, priorityNote: NO_PARENT(1000) });

    // Holding the repair intent, its child may take up to the repair's priority.
    expect(((await tools.take({})) as { intent: { id: string } }).intent.id).toBe(repair.id);
    const child = (await tools.declare({ ...ask, footprint: ["src/math-helpers.ts"] })) as Record<string, unknown>;
    expect(child).toMatchObject({ intent: { parentId: repair.id }, priority: REPAIR_PRIORITY, requestedPriority: 1000, priorityNote: UNDER(1000, REPAIR_PRIORITY) });
    // Naming an intent it neither holds nor declared as the parent: 1.
    const elsewhere = await colony(c.id).addIntent({ colonyId: c.id, title: "Someone else's urgent fix", why: "w", source: "human", footprint: ["docs/urgent.md"], priority: REPAIR_PRIORITY, createdBy: "matt" });
    const borrowed = (await tools.declare({ ...ask, footprint: ["docs/urgent-helper.md"], parentId: elsewhere.id })) as Record<string, unknown>;
    expect(borrowed).toMatchObject({ intent: { parentId: elsewhere.id }, priority: 1, requestedPriority: 1000, priorityNote: NOT_YOURS(1000) });
    const within = (await tools.declare({ ...ask, footprint: ["src/math-format.ts"], priority: 4 })) as Record<string, unknown>;
    expect(within).not.toHaveProperty("priorityNote");
    expect(within).not.toHaveProperty("requestedPriority");
    expect(await colony(c.id).getIntent((within.intent as { id: string }).id)).toMatchObject({ source: "agent", priority: 4, parentId: repair.id });
  });
});
