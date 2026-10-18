import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { closureBadge, closureEventText, closureFrom } from "../src/closure.ts";
import { ColonyStore } from "../src/store.ts";

/** The closure ledger on the page: the label on an intent's row and the words on its events log line. */

const name = (id: string) => (id === "agt_walker" ? "walker" : id);
const NOW = 1_000_000;

function loaded(): ColonyStore {
  const s = new ColonyStore("walk");
  const snap = {
    colony: { id: "walk", name: "walk", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
    files: [{ path: "src/values.ts", size: 10 }],
    intents: [
      { id: "int_1", colonyId: "walk", title: "Set v2", why: "", source: "human", footprint: ["src/values.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t",
        closure: { cause: "reaped_silent", at: 900_000, status: "open", agentId: "agt_walker", agentKind: "external", gapMs: 97_000 } },
      { id: "int_2", colonyId: "walk", title: "Old", why: "", source: "human", footprint: ["src/values.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t", closure: { cause: "vanished", at: 1 } },
    ],
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
  } as unknown as ColonySnapshot;
  s.applySnapshot(snap);
  return s;
}

describe("closures on the page", () => {
  it("reads a closure field by field, from the snapshot and from intent events", () => {
    expect(closureFrom({ cause: "released", at: 5, agentId: "agt_1", agentKind: "robot", gapMs: -2 }, "open")).toEqual({ cause: "released", at: 5, status: "open", agentId: "agt_1" });
    for (const bad of [null, "x", { cause: "gone", at: 1, status: "open" }, { cause: "landed", at: "now", status: "landed" }, { cause: "landed", at: 1 }]) expect(closureFrom(bad)).toBeNull();
    const s = loaded();
    expect(s.intents.get("int_1")?.closure).toEqual({ cause: "reaped_silent", at: 900_000, status: "open", agentId: "agt_walker", agentKind: "external", gapMs: 97_000 });
    expect(s.intents.get("int_2")?.closure).toBeUndefined();
    // A claim carries no cause and keeps the last closure; a landing replaces it.
    s.applyEvents([{ t: "intent", at: 910_000, intentId: "int_1", status: "claimed", title: "Set v2", footprint: ["src/values.ts"] }]);
    expect(s.intents.get("int_1")?.closure?.cause).toBe("reaped_silent");
    s.applyEvents([{ t: "intent", at: 920_000, intentId: "int_1", status: "landed", title: "Set v2", footprint: ["src/values.ts"], cause: "landed", agentId: "agt_second", agentKind: "synthetic", gapMs: 1_000 }]);
    expect(s.intents.get("int_1")?.closure).toEqual({ cause: "landed", at: 920_000, status: "landed", agentId: "agt_second", agentKind: "synthetic", gapMs: 1_000 });
  });

  it("labels a reopened intent's row, and leaves landed and withdrawn ones to their status", () => {
    const reaped = closureBadge({ cause: "reaped_silent", at: 880_000, status: "open", agentId: "agt_walker", gapMs: 97_000 }, name, NOW);
    expect(reaped).toEqual({
      label: "reaped · 1 min 37 s silent",
      title: "Taken back 2m ago: walker was silent for 1 min 37 s, past the colony's limit, so the colony reopened it with a failure mark for the next taker.",
    });
    expect(closureBadge({ cause: "released", at: NOW, status: "open", agentId: "agt_walker", gapMs: 0 }, name, NOW)).toEqual({ label: "given back", title: "walker gave it back just now; it reopened with a failure mark." });
    expect(closureBadge({ cause: "stopped", at: NOW, status: "open" }, name, NOW)?.title).toBe("A person stopped its agent just now, so it reopened with a failure mark.");
    expect(closureBadge({ cause: "gave_up", at: NOW, status: "open", agentId: "a" }, name, NOW)?.label).toBe("gave up");
    expect(closureBadge({ cause: "landed", at: NOW, status: "landed" }, name, NOW)).toBeNull();
    expect(closureBadge({ cause: "withdrawn", at: NOW, status: "withdrawn" }, name, NOW)).toBeNull();
    expect(closureBadge(undefined, name, NOW)).toBeNull();
  });

  it("says the cause on the intent's events log line", () => {
    expect(closureEventText({ cause: "reaped_silent", at: 1, status: "open", gapMs: 92_000 })).toBe(" · reaped after 1 min 32 s silent");
    expect(closureEventText({ cause: "released", at: 1, status: "open" })).toBe(" · given back");
    expect(closureEventText({ cause: "landed", at: 1, status: "landed" })).toBe("");
    expect(closureEventText(null)).toBe("");
  });

  it("reads and labels an intent closed as already on trunk (FT_ALREADY_ON_TRUNK), naming where the content came from", () => {
    const raw = { cause: "already_on_trunk", at: 900_000, status: "landed", agentId: "agt_walker", onTrunk: { trunkSha: "b".repeat(40), landingId: "lnd_7", agentId: "agt_first", odd: 1 } };
    const c = closureFrom(raw);
    expect(c).toEqual({ cause: "already_on_trunk", at: 900_000, status: "landed", agentId: "agt_walker", onTrunk: { trunkSha: "b".repeat(40), landingId: "lnd_7", agentId: "agt_first" } });
    expect(closureBadge(c, name, NOW)?.label).toBe("already on trunk");
    expect(closureBadge(c, name, NOW)?.title).toContain("walker's change was already on trunk");
    expect(closureBadge(c, name, NOW)?.title).toContain("(from lnd_7)");
    expect(closureEventText(c)).toBe(" · already on trunk from lnd_7");
    expect(closureEventText({ cause: "already_on_trunk", at: 1, status: "landed" })).toBe(" · already on trunk");
  });
});
