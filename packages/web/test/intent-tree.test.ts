import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ColonyEvent, ColonySnapshot, RecordedEvent } from "@fire_trident/core";
import { IntentsTab } from "../src/components/IntentsTab.tsx";
import {
  GROUPS_PAGE,
  PAGE,
  buildTree,
  intentRegion,
  intentRow,
  itemsOf,
  itemsPage,
  paged,
  pagesFor,
  parseFocus,
  planFocus,
  regionKey,
  regionsPage,
  treeInput,
  whyChain,
  type GroupNode,
  type IntentTree,
} from "../src/intentTree.ts";
import { ColonySim } from "../src/mock.ts";
import { needsYou, stuckTarget } from "../src/needs.ts";
import { FieldSynth, ReplayEngine, Timeline, startingPoint } from "../src/replay.ts";
import { ColonyStore } from "../src/store.ts";

// The tab re-renders on a throttled store subscription; a static render needs none.
vi.mock("../src/useStore.ts", () => ({ useThrottledVersion: () => 0 }));

/** The Intents tab's tree: what asked for the work, then the region, then the intents, rolled up most urgent first. */

const NOW = 50_000_000;
const A = "a".repeat(40);

function loaded(opts: { intents?: unknown[]; rules?: unknown[]; depth?: number } = {}): ColonyStore {
  const s = new ColonyStore("web");
  s.now = () => NOW;
  s.applySnapshot({
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: A, createdAt: 0, regionDepth: opts.depth ?? 1 },
    files: [],
    intents: opts.intents ?? [],
    rules: opts.rules ?? [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
  } as unknown as ColonySnapshot);
  return s;
}

const rule = (id: string, description: string, extra: Record<string, unknown> = {}) => ({ id, colonyId: "web", kind: "forbid-pattern", spec: {}, description, approvedBy: "m", createdAt: 0, ...extra });
const intent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  colonyId: "web",
  title: `Intent ${id}`,
  why: "w",
  source: "human",
  footprint: [`src/${id}.ts`],
  priority: 1,
  status: "open",
  createdAt: 0,
  createdBy: "t",
  ...extra,
});
const ruleIntent = (id: string, ruleId: string, path: string, extra: Record<string, unknown> = {}) => intent(id, { source: "rule", ruleId, title: `Rule ${ruleId} in ${path}`, footprint: [path], ...extra });
const opened = (id: string, title: string, footprint: string[], at = NOW): ColonyEvent => ({ t: "intent", at, intentId: id, status: "open", title, footprint });
const returned = (intentId: string, n: number): ColonyEvent[] =>
  Array.from({ length: n }, (_, k): ColonyEvent => ({ t: "proposal", at: NOW, proposalId: `${intentId}-p${k}`, intentId, agentId: "a1", status: "returned", reason: "stale read" }));
const tree = (s: ColonyStore): IntentTree => buildTree(treeInput(s));
const group = (t: IntentTree, key: string): GroupNode => {
  const g = t.groups.find((x) => x.key === key);
  if (!g) throw new Error(`no group ${key}: ${t.groups.map((x) => x.key).join(", ")}`);
  return g;
};
const ids = (t: IntentTree, key: string, region: string): string[] => {
  const r = group(t, key).regions.find((x) => x.region === region);
  return r ? itemsOf(r).map((x) => x.intent.id) : [];
};

describe("grouping by what asked for the work, then by region", () => {
  it("makes a group per rule (by its title) and one each for people, repairs, splits, follow-ups", () => {
    const s = loaded({
      rules: [rule("r1", "No console.log in server code."), rule("r2", "UI must not import db", { retractedAt: 5 })],
      intents: [
        ruleIntent("i1", "r1", "src/a.ts"),
        ruleIntent("i2", "r1", "src/b.ts"),
        ruleIntent("i3", "r2", "ui/x.tsx", { status: "withdrawn" }),
        intent("h1", { title: "Add search", footprint: ["src/search.ts", "ui/search.tsx", "ui/search.css"] }),
        intent("c1", { source: "certify", title: "Make the failing tests pass: router > matches" }),
        intent("m1", { source: "system", title: "Split src/big.ts into smaller modules", footprint: ["src/big.ts", "src/big/*", "src/big/big/**"] }),
        intent("f1", { source: "agent", parentId: "i1", title: "Add a regression test for a.ts", footprint: ["test/a.test.ts"] }),
      ],
    });
    const t = tree(s);
    // Most urgent first: more open intents first, then by name; a group with only a withdrawn intent last.
    expect(t.groups.map((g) => [g.key, g.origin.label, g.total])).toEqual([
      ["rule:r1", "No console.log in server code", 2],
      ["agent", "Agents' follow-ups", 1],
      ["certify", "Certification repairs", 1],
      ["human", "People and the spec", 1],
      ["system", "The colony's own splits", 1],
      ["rule:r2", "UI must not import db", 1],
    ]);
    expect(group(t, "rule:r1").origin).toMatchObject({ kind: "rule", ruleId: "r1", description: "No console.log in server code." });
    expect(group(t, "rule:r2").origin.retracted).toBe(true);
    // A footprint across regions belongs to the region holding most of it.
    expect(group(t, "human").regions.map((r) => r.region)).toEqual(["ui"]);
    expect(group(t, "system").regions.map((r) => r.region)).toEqual(["src"]);
    expect(t.total).toBe(7);
  });

  it("finds regions with core regionOf at the colony's depth", () => {
    expect(intentRegion(["src/a.ts"])).toBe("src");
    expect(intentRegion(["README.md"])).toBe(".");
    expect(intentRegion([])).toBe(".");
    expect(intentRegion(["ui/a.tsx", "src/b.ts", "src/c.ts"])).toBe("src");
    // A tie goes to the region that appears first, as a proposal's lane is chosen.
    expect(intentRegion(["ui/a.tsx", "src/b.ts"])).toBe("ui");
    // A glob ends the region at its static directory.
    expect(intentRegion(["src/*", "src/stem/**"])).toBe("src");
    expect(intentRegion(["src/middleware/cors.ts"], 2)).toBe("src/middleware");
    expect(intentRegion(["src/hono.ts"], 2)).toBe("src");
    const deep = loaded({ depth: 2, intents: [intent("x", { footprint: ["src/middleware/cors.ts"] }), intent("y", { footprint: ["src/hono.ts"] })] });
    expect(
      group(tree(deep), "human")
        .regions.map((r) => r.region)
        .sort(),
    ).toEqual(["src", "src/middleware"]);
  });

  it("places intents whose events carry no origin by the titles the colony writes for its own", () => {
    const s = loaded({
      rules: [rule("r1", "No console.log in server code."), rule("r2", "UI must not import db", { retractedAt: 5 }), rule("r3", "No console.log in server code", { createdAt: NOW - 500 })],
      // A person's intent titled like a rule's stays a person's: a recorded source wins.
      intents: [intent("h1", { title: "No console.log in server code in src/h.ts", footprint: ["src/h.ts"] })],
    });
    s.applyEvents([
      opened("e1", "No console.log in server code in src/z.ts", ["src/z.ts"]),
      opened("e0", "No console.log in server code in src/y.ts", ["src/y.ts"], 10),
      opened("e2", "Make the failing tests pass: router > matches", ["src/router.ts", "test/router.test.ts"]),
      opened("e3", "Restore the lost tests: cache > ttl", ["src/cache.ts"]),
      opened("e4", "Split src/big.ts into smaller modules", ["src/big.ts", "src/big/*", "src/big/big/**"]),
      opened("e5", "Redo after revert: No console.log in server code in src/q.ts", ["src/q.ts"]),
      opened("e6", "Redo after revert: UI must not import db in ui/q.tsx", ["ui/q.tsx"]),
      opened("e7", "Fix the header", ["ui/header.tsx"]),
      // Colonies made before titles dropped the trailing period wrote the whole description.
      opened("e8", "No console.log in server code. in src/old.ts", ["src/old.ts"], 10),
    ]);
    expect(s.unsourcedBorn).toBe(9);
    const t = tree(s);
    const keyOf = (id: string) => t.groups.find((g) => g.regions.some((r) => r.items.some((x) => x.intent.id === id)))?.key;
    // Of two rules sharing a title, the newest declared by the time the intent was.
    expect(keyOf("e1")).toBe("rule:r3");
    expect(keyOf("e0")).toBe("rule:r1");
    expect(keyOf("e2")).toBe("certify");
    expect(keyOf("e3")).toBe("certify");
    expect(keyOf("e4")).toBe("system");
    expect(keyOf("e5")).toBe("rule:r3");
    // A redo of a retracted rule's intent is a person's, as the colony declares it.
    expect(keyOf("e6")).toBe("human");
    expect(keyOf("e7")).toBe("unknown");
    expect(keyOf("e8")).toBe("rule:r1");
    expect(keyOf("h1")).toBe("human");
    expect(group(t, "unknown").origin.label).toBe("Origin not known");
  });
});

describe("roll-ups, most urgent first", () => {
  function colony(): ColonyStore {
    const s = loaded({
      rules: [rule("r1", "Rule one"), rule("r2", "Rule two"), rule("r3", "Rule three")],
      intents: [
        ruleIntent("land1", "r1", "src/a.ts", { status: "landed", createdAt: 1 }),
        ruleIntent("land2", "r1", "src/b.ts", { status: "landed", createdAt: 2 }),
        ruleIntent("wd", "r1", "src/c.ts", { status: "withdrawn", createdAt: 3 }),
        ruleIntent("open1", "r1", "src/d.ts", { priority: 1, createdAt: 4 }),
        ruleIntent("open2", "r1", "src/e.ts", { priority: 3, createdAt: 9 }),
        ruleIntent("open3", "r1", "src/f.ts", { priority: 3, createdAt: 5 }),
        ruleIntent("fly", "r1", "src/g.ts", { status: "claimed", createdAt: 6 }),
        ruleIntent("prop", "r1", "src/h.ts", { status: "proposed", createdAt: 8 }),
        ruleIntent("ret3", "r1", "src/i.ts", { status: "claimed" }),
        ruleIntent("ret4", "r1", "src/j.ts", { status: "open" }),
        ruleIntent("rep", "r1", "src/k.ts", { escalation: { kind: "impossible", report: "cannot", by: "a2", at: 7 } }),
        ruleIntent("gone", "r1", "src/l.ts", { status: "abandoned" }),
        ruleIntent("r2a", "r2", "lib/a.ts", { status: "claimed" }),
        ruleIntent("r2b", "r2", "lib/b.ts", { status: "open" }),
        ruleIntent("r3a", "r3", "app/a.ts", { status: "claimed" }),
        ruleIntent("r3b", "r3", "app/b.ts", { status: "claimed" }),
        ruleIntent("r3c", "r3", "docs/c.md", { status: "landed" }),
      ],
    });
    s.applyEvents([...returned("ret3", 3), ...returned("ret4", 4)]);
    return s;
  }

  it("gives each intent one state and counts it in its region, its group and the whole tree", () => {
    const t = tree(colony());
    const r1 = group(t, "rule:r1");
    expect(r1.counts).toEqual({ report: 1, returned: 2, flight: 2, open: 3, landed: 2, withdrawn: 1 });
    expect(r1.top).toBe("report");
    expect(r1.total).toBe(11);
    // The abandoned intent (a sealed vaccine) is left out.
    expect(t.total).toBe(16);
    expect(t.counts).toEqual({ report: 1, returned: 2, flight: 5, open: 4, landed: 3, withdrawn: 1 });
    expect(group(t, "rule:r3").regions.map((r) => [r.region, r.top, r.total])).toEqual([
      ["app", "flight", 2],
      ["docs", "landed", 1],
    ]);
  });

  it("sorts groups and regions most urgent first, and a region's intents within each state", () => {
    const t = tree(colony());
    // r1 holds a report; r3 has more in flight than r2.
    expect(t.groups.map((g) => [g.key, g.top])).toEqual([
      ["rule:r1", "report"],
      ["rule:r3", "flight"],
      ["rule:r2", "flight"],
    ]);
    // Report first; most returns first; latest move first; highest priority then oldest; latest landed first.
    expect(ids(t, "rule:r1", "src")).toEqual(["rep", "ret4", "ret3", "prop", "fly", "open3", "open2", "open1", "land2", "land1", "wd"]);
  });

  it("moves an intent as its state changes: a report answered, a landing", () => {
    const s = colony();
    s.applyEvents([
      { t: "escalation", at: NOW, intentId: "rep", agentId: "a2", kind: "impossible", report: "cannot", title: "x", resolved: { by: "m", at: NOW, decision: "dismiss", note: "it can" } },
      { t: "intent", at: NOW, intentId: "ret4", status: "landed", title: "Rule r1 in src/j.ts", footprint: ["src/j.ts"] },
    ]);
    const r1 = group(tree(s), "rule:r1");
    expect(r1.counts).toMatchObject({ report: 0, returned: 1, open: 4, landed: 3 });
    expect(r1.top).toBe("returned");
  });
});

describe("paging", () => {
  it("shows 50 rows at a time at every level", () => {
    const many = Array.from({ length: 120 }, (_, i) => intent(`n${String(i).padStart(3, "0")}`, { createdAt: i }));
    const t = tree(loaded({ intents: many }));
    const region = group(t, "human").regions[0];
    if (!region) throw new Error("no region");
    const all = itemsOf(region);
    expect(paged(all, undefined).rows).toHaveLength(PAGE);
    expect(paged(all, undefined).more).toBe(70);
    expect(paged(all, 100)).toMatchObject({ more: 20 });
    expect(paged(all, 150)).toMatchObject({ more: 0 });
    expect(paged(all, 150).rows).toHaveLength(120);
    // Oldest open first at equal priority.
    expect(paged(all, undefined).rows[0]?.intent.id).toBe("n000");
    expect([pagesFor(0), pagesFor(49), pagesFor(50), pagesFor(73), pagesFor(149)]).toEqual([50, 50, 100, 100, 150]);
  });

  it("pages groups and a group's regions the same way", () => {
    const rules = Array.from({ length: 60 }, (_, i) => rule(`r${i}`, `Rule ${String(i).padStart(2, "0")}`));
    const intents = rules.map((r, i) => ruleIntent(`i${i}`, r.id, `d${i}/x.ts`, { status: i % 2 ? "landed" : "open" }));
    const wide = Array.from({ length: 70 }, (_, i) => intent(`w${i}`, { footprint: [`dir${String(i).padStart(2, "0")}/f.ts`] }));
    const t = tree(loaded({ rules, intents: [...intents, ...wide] }));
    expect(paged(t.groups, undefined)).toMatchObject({ more: 11 });
    const human = group(t, "human");
    expect(human.regions).toHaveLength(70);
    expect(paged(human.regions, undefined).more).toBe(20);
  });
});

describe("the needs-you strip opens the group that holds what needs a person", () => {
  function colony(): ColonyStore {
    const rules = [rule("r1", "Rule one"), rule("r2", "Rule two")];
    const lots = Array.from({ length: 80 }, (_, i) => ruleIntent(`l${i}`, "r2", `lib/${i}.ts`, { status: "open", priority: 5, createdAt: i }));
    const s = loaded({
      rules,
      intents: [...lots, ruleIntent("stuck", "r2", "lib/stuck.ts", { status: "claimed" }), ruleIntent("calm", "r1", "src/calm.ts", { status: "landed" }), ruleIntent("bounce", "r1", "src/bounce.ts", { status: "claimed" })],
    });
    s.applyEvents(returned("bounce", 3));
    return s;
  }

  it("opens every group and region holding an intent that keeps coming back", () => {
    const s = colony();
    const need = needsYou(s).find((n) => n.key === "returns");
    expect(need).toMatchObject({ tab: "intents", focus: "returned" });
    const t = tree(s);
    const focus = parseFocus(need?.focus);
    expect(focus).toEqual({ state: "returned" });
    const plan = focus ? planFocus(t, focus) : null;
    expect(plan?.open).toEqual(["rule:r1", regionKey("rule:r1", "src")]);
    expect(plan?.scroll).toBe("g:rule:r1");
    // Nothing in a state opens nothing.
    expect(planFocus(t, { state: "report" })).toBeNull();
  });

  it("opens one intent's group and region for a stuck item, with pages enough to show its row", () => {
    const s = colony();
    // The colony's detector found the intent stuck: amend or withdraw it.
    const target = stuckTarget(s, { key: "returns:l73", kind: "returns", action: "intent", intentId: "l73", since: NOW, text: "back 3 times", seenAt: NOW });
    expect(target).toEqual({ tab: "intents", focus: "intent:l73" });
    const t = tree(s);
    const plan = planFocus(t, parseFocus(target.focus) ?? { intent: "" });
    const lib = regionKey("rule:r2", "lib");
    expect(plan?.open).toEqual(["rule:r2", lib]);
    // l73 is the 75th row of its region (the claimed intent and l0..l72 come first): two pages.
    expect(itemsOf(group(t, "rule:r2").regions[0]!).findIndex((x) => x.intent.id === "l73")).toBe(74);
    expect(plan?.shown).toEqual({ [GROUPS_PAGE]: 50, [regionsPage("rule:r2")]: 50, [itemsPage(lib)]: 100 });
    expect(plan?.scroll).toBe(intentRow("l73"));
    expect(planFocus(t, { intent: "nowhere" })).toBeNull();
  });

  it("reads the strip's focus: a state (old segment names too), a group, or an intent", () => {
    expect(parseFocus("claimed")).toEqual({ state: "flight" });
    expect(parseFocus("open")).toEqual({ state: "open" });
    expect(parseFocus("report")).toEqual({ state: "report" });
    expect(parseFocus("group:rule:r1")).toEqual({ group: "rule:r1" });
    expect(parseFocus("intent:i1")).toEqual({ intent: "i1" });
    expect(parseFocus("intent:")).toBeNull();
    expect(parseFocus("certify")).toBeNull();
    expect(parseFocus(undefined)).toBeNull();
  });

  it("brings a group beyond the first page on screen", () => {
    const rules = Array.from({ length: 60 }, (_, i) => rule(`r${i}`, `Rule ${String(i).padStart(2, "0")}`));
    const t = tree(loaded({ rules, intents: rules.map((r, i) => ruleIntent(`i${i}`, r.id, `d/x${i}.ts`, { status: "landed" })) }));
    const last = t.groups[57];
    if (!last) throw new Error("no group");
    expect(planFocus(t, { group: last.key })?.shown).toEqual({ [GROUPS_PAGE]: 100 });
  });
});

describe("the why chain", () => {
  it("lists parents nearest first, then the rule that started the chain", () => {
    const s = loaded({
      rules: [rule("r1", "No console.log in server code.")],
      intents: [
        ruleIntent("i1", "r1", "src/a.ts", { title: "No console.log in server code in src/a.ts" }),
        intent("f1", { source: "agent", parentId: "i1", title: "Add a regression test for a.ts" }),
        intent("f2", { source: "agent", parentId: "f1", title: "Cover the empty case" }),
        intent("lost", { source: "agent", parentId: "int_00000000gone00", title: "Orphan" }),
        intent("a", { parentId: "b" }),
        intent("b", { parentId: "a" }),
        intent("h", { title: "Add search" }),
      ],
    });
    const t = tree(s);
    const chain = (id: string) => {
      const it = s.intents.get(id);
      if (!it) throw new Error(id);
      return whyChain(it, s.intents, t.book).map((l) => (l.kind === "rule" ? `rule:${l.origin.label}` : `${l.id}:${l.title ?? "?"}`));
    };
    expect(chain("i1")).toEqual(["rule:No console.log in server code"]);
    expect(chain("f1")).toEqual(["i1:No console.log in server code in src/a.ts", "rule:No console.log in server code"]);
    expect(chain("f2")).toEqual(["f1:Add a regression test for a.ts", "i1:No console.log in server code in src/a.ts", "rule:No console.log in server code"]);
    expect(chain("lost")).toEqual(["int_00000000gone00:?"]);
    expect(chain("a")).toEqual(["b:Intent b"]);
    expect(chain("h")).toEqual([]);
  });
});

describe("origins the page learns", () => {
  it("fills intents placed from events from a snapshot's intents and rules", () => {
    const s = loaded({ rules: [rule("r1", "Rule one")] });
    s.applyEvents([opened("x1", "Add search", ["src/search.ts"]), opened("x2", "New rule in lib/a.ts", ["lib/a.ts"])]);
    expect(s.unsourcedBorn).toBe(2);
    expect(tree(s).groups.map((g) => [g.key, g.total])).toEqual([["unknown", 2]]);
    const version = s.intentsVersion;
    // A rule added after the page loaded: its intents follow it by title once the page knows the rule.
    expect(s.learnRules([rule("r1", "Rule one"), rule("r9", "New rule", { createdAt: 1 })])).toBe(1);
    expect(s.learnIntents([intent("x1", { title: "Add search", source: "human", priority: 4, parentId: "p1" }), { id: "zz" }, null])).toBe(1);
    expect(s.intentsVersion).toBeGreaterThan(version);
    expect(s.intents.get("x1")).toMatchObject({ source: "human", priority: 4, parentId: "p1" });
    expect(
      tree(s)
        .groups.map((g) => [g.key, g.total])
        .sort(),
    ).toEqual([
      ["human", 1],
      ["rule:r9", 1],
    ]);
    // An intent that already knows its origin keeps it.
    expect(s.learnIntents([intent("x1", { source: "agent" })])).toBe(0);
    expect(s.intents.get("x1")?.source).toBe("human");
  });

  it("uses origin fields an intent event carries, and keeps learned origins across a replay's restart", () => {
    const s = loaded();
    s.applyEvents([{ ...opened("f1", "Follow up", ["src/f.ts"]), source: "agent", parentId: "i0", priority: 2 } as unknown as ColonyEvent]);
    expect(s.intents.get("f1")).toMatchObject({ source: "agent", parentId: "i0", priority: 2 });
    expect(s.unsourcedBorn).toBe(0);
    s.learnIntents([intent("later", { source: "certify" })]);
    s.reset();
    s.applyEvents([opened("later", "Make it pass", ["src/x.ts"])]);
    expect(s.intents.get("later")?.source).toBe("certify");
  });
});

describe("replays", () => {
  const T = 1_791_797_000_000;
  const sha = (c: string) => c.repeat(40);
  const DESCRIPTION = "Import from the package entry, not its internals.";
  const HEAD = "Import from the package entry, not its internals";
  const PATHS = ["src/adapter/a.ts", "src/adapter/b.ts", "src/middleware/c.ts", "src/helper.ts", "deno_dist/d.ts"];

  /** A rule run as the record holds it: the rule's intents open, each is claimed, proposed and lands. */
  function record(): RecordedEvent[] {
    const events: ColonyEvent[] = [];
    PATHS.forEach((p, i) => events.push({ t: "intent", at: T + 1_000, intentId: `i${i}`, status: "open", title: `${HEAD} in ${p}`, footprint: [p] }));
    PATHS.forEach((p, i) => {
      const at = T + 2_000 + i * 1_000;
      events.push(
        { t: "intent", at, intentId: `i${i}`, status: "claimed", title: `${HEAD} in ${p}`, footprint: [p] },
        { t: "proposal", at: at + 300, proposalId: `p${i}`, intentId: `i${i}`, agentId: "a1", status: "ready" },
        { t: "proposal", at: at + 600, proposalId: `p${i}`, intentId: `i${i}`, agentId: "a1", status: "landed" },
        { t: "intent", at: at + 600, intentId: `i${i}`, status: "landed", title: `${HEAD} in ${p}`, footprint: [p] },
        { t: "landing", at: at + 600, landingId: `l${i}`, trunkSha: sha(String(i)), proposalIds: [`p${i}`], paths: [p] },
      );
    });
    return events.map((e, i) => ({ ...e, seq: i + 1 }));
  }

  /** The finished colony lists only its newest landed intents (the snapshot keeps 200 done ones): two of five here. */
  function finished(): ColonySnapshot {
    return {
      colony: { id: "hono", name: "hono", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: sha("4"), createdAt: T, regionDepth: 1, source: { url: "https://example.com/r.git", branch: "main" } },
      files: PATHS.map((path) => ({ path, size: 100 })),
      intents: [3, 4].map((i) => ({
        id: `i${i}`,
        colonyId: "hono",
        title: `${HEAD} in ${PATHS[i]}`,
        why: DESCRIPTION,
        source: "rule",
        ruleId: "r1",
        footprint: [PATHS[i] ?? ""],
        priority: 1,
        status: "landed",
        createdAt: T + 1_000,
        createdBy: "m",
      })),
      rules: [{ id: "r1", colonyId: "hono", kind: "forbid-import", spec: {}, description: DESCRIPTION, approvedBy: "m", createdAt: T + 900 }],
      agents: [],
      recentLandings: [],
      violations: { total: 0, byRule: { r1: 0 } },
      funnel: { proof: 5, reflex: 0, llm: 0, human: 0 },
      metrics: {},
    } as ColonySnapshot;
  }

  it("shows the rule's group with every intent landed, region by region, as the run plays", () => {
    const store = new ColonyStore("hono");
    const snap = finished();
    store.learnIntents(snap.intents);
    const timeline = new Timeline(record());
    const { snapshot, newFiles } = startingPoint(snap, timeline);
    const e = new ReplayEngine(store, timeline, snapshot, newFiles, new FieldSynth());
    e.begin();
    e.advanceTo(T + 1_500);
    let t = tree(store);
    expect(t.groups.map((g) => [g.key, g.origin.label, g.counts.open])).toEqual([["rule:r1", HEAD, 5]]);
    e.advanceTo(e.end);
    t = tree(store);
    expect(t.groups).toHaveLength(1);
    const g = group(t, "rule:r1");
    expect(g.counts.landed).toBe(5);
    expect(g.top).toBe("landed");
    expect(g.regions.map((r) => [r.region, r.counts.landed])).toEqual([
      ["src", 4],
      ["deno_dist", 1],
    ]);
    // The learned ones carry their why; the others were placed by their titles.
    expect(store.intents.get("i3")?.why).toBe(DESCRIPTION);
    expect(store.intents.get("i0")?.source).toBeUndefined();
    // Seeking back starts the colony over; what the page learned stays.
    e.seek(e.start);
    e.advanceTo(e.end);
    expect(group(tree(store), "rule:r1").counts.landed).toBe(5);
    expect(store.intents.get("i4")?.source).toBe("rule");
  });
});

describe("the simulator", () => {
  it("names each intent's origin on its events, and the rules it declares while running reach the page", () => {
    const sim = new ColonySim("demo", { files: 0, agents: 64, speed: 20, seed: 7 });
    const store = new ColonyStore("demo");
    store.applySnapshot(sim.snapshot());
    const initialRules = sim.ruleCount;
    let rulesSent = initialRules;
    let now = Date.now();
    const events: ColonyEvent[] = [];
    for (let i = 0; i < 400; i++) {
      now += 250;
      const evs = sim.step(now);
      events.push(...evs);
      // What MockBackend does each tick.
      if (sim.ruleCount !== rulesSent) {
        rulesSent = sim.ruleCount;
        store.learnRules(sim.ruleList());
      }
      store.applyEvents(evs);
    }
    const intents = events.filter((e): e is Extract<ColonyEvent, { t: "intent" }> => e.t === "intent");
    expect(intents.length).toBeGreaterThan(0);
    expect(intents.every((e) => typeof (e as { source?: unknown }).source === "string")).toBe(true);
    expect(store.unsourcedBorn).toBe(0);
    // The run declared at least one rule of its own after the page loaded, and the page knows it by name.
    expect(sim.ruleCount).toBeGreaterThan(initialRules);
    expect(store.rules.size).toBe(sim.ruleCount);
    const t = tree(store);
    expect(t.groups.some((g) => g.key === "unknown")).toBe(false);
    const ruleGroups = t.groups.filter((g) => g.origin.kind === "rule");
    expect(ruleGroups.length).toBeGreaterThan(initialRules);
    expect(ruleGroups.every((g) => !!g.origin.description)).toBe(true);
    // Follow-ups name their parent, so their why chain leads back to it.
    const followUp = [...store.intents.values()].find((x) => x.source === "agent" && x.parentId && store.intents.has(x.parentId));
    if (followUp) expect(whyChain(followUp, store.intents, t.book)[0]).toMatchObject({ kind: "parent", id: followUp.parentId });
  });
});

describe("scale", () => {
  it("builds the tree of 20,000 intents quickly, and sorts a region only when it is shown", () => {
    const rules = [rule("r1", "Rule one"), rule("r2", "Rule two"), rule("r3", "Rule three")];
    const statuses = ["open", "claimed", "proposed", "landed", "landed", "landed", "withdrawn"];
    const intents = Array.from({ length: 20_000 }, (_, i) =>
      ruleIntent(`i${i}`, `r${(i % 3) + 1}`, `region${i % 64}/f${i}.ts`, { status: statuses[i % statuses.length], createdAt: i, priority: i % 5 }),
    );
    const s = loaded({ rules, intents });
    const started = performance.now();
    const t = tree(s);
    const ms = performance.now() - started;
    expect(t.total).toBe(20_000);
    expect(t.groups).toHaveLength(3);
    expect(t.groups.every((g) => g.regions.length === 64)).toBe(true);
    // Generous: about 35 ms the first time and 7 ms a rebuild on a laptop; it only guards against a quadratic build.
    expect(ms).toBeLessThan(1_500);
  });
});

describe("the tab", () => {
  it("renders the rule's group with its counts, its regions underneath, and each intent's why", () => {
    const s = loaded({
      rules: [rule("r1", "Import from the package entry.")],
      intents: [
        ...Array.from({ length: 3 }, (_, i) => ruleIntent(`a${i}`, "r1", `src/a${i}.ts`, { status: "landed", title: `Import from the package entry in src/a${i}.ts` })),
        ruleIntent("d0", "r1", "deno_dist/d0.ts", { status: "landed" }),
        intent("h1", { title: "<b>Add</b> search", footprint: ["web/search.ts"] }),
      ],
    });
    const html = renderToStaticMarkup(createElement(IntentsTab, { store: s, onPick: () => undefined }));
    expect(html).toContain("5 intents");
    expect(html).toContain('<span class="ig-label">Import from the package entry</span>');
    expect(html).toContain('<span class="sc sc-landed is-top" title="Its change is on trunk."><b>4</b> landed</span>');
    expect(html).toContain('<span class="ir-name mono">src</span>');
    expect(html).toContain('<span class="ir-name mono">deno_dist</span>');
    // The people's group has one region, so its intents show, their titles as text.
    expect(html).toContain("&lt;b&gt;Add&lt;/b&gt; search");
    expect(html).not.toContain("<b>Add</b>");
    // A rule group with two regions keeps them closed until clicked.
    expect(html).not.toContain("src/a0.ts");
    const one = loaded({ rules: [rule("r1", "Import from the package entry.")], intents: [ruleIntent("a0", "r1", "src/a0.ts", { status: "landed" })] });
    const single = renderToStaticMarkup(createElement(IntentsTab, { store: one, onPick: () => undefined }));
    expect(single).toContain(">rule: Import from the package entry</button>");
  });

  it("says so when there is nothing yet", () => {
    const html = renderToStaticMarkup(createElement(IntentsTab, { store: loaded(), onPick: () => undefined }));
    expect(html).toContain("No intents yet.");
    expect(html).toContain("0 intents");
  });
});
