import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { ColonyStore } from "../src/store.ts";

/** The vaccination meter's numbers: catches split by where they stopped, when the colony reports the split. */

function store(metrics: Record<string, number>): ColonyStore {
  const s = new ColonyStore("web");
  s.applySnapshot({
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
    files: [],
    intents: [],
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics,
  } as unknown as ColonySnapshot);
  return s;
}

const OVERALL = { "vaccine.all.n": 28, "vaccine.all.caught": 28, "vaccine.all.recall": 1, "vaccine.all.lo": 0.879, "vaccine.all.hi": 1 };

describe("vaccination split", () => {
  it("reads returned and sent-to-a-person catches apart, overall numbers over per-class ones", () => {
    const v = store({ ...OVERALL, "vaccine.all.escalated": 21, "vaccine.all.returned": 7, "vaccine.secret-log.escalated": 7, "vaccine.secret-log.returned": 0 }).vaccination();
    expect(v).toMatchObject({ seeded: 28, caught: 28, recall: 1, escalated: 21, returned: 7, low: 0.879, high: 1 });
  });

  it("folds nothing apart when the colony does not report the split, or reports only half of it", () => {
    expect(store(OVERALL).vaccination()).toMatchObject({ seeded: 28, caught: 28, recall: 1, escalated: null, returned: null });
    expect(store({ ...OVERALL, "vaccine.all.escalated": 21 }).vaccination()).toMatchObject({ escalated: null, returned: null });
  });

  it("follows live metric events", () => {
    const s = store(OVERALL);
    s.applyEvents([
      { t: "metric", at: 1, name: "vaccine.all.escalated", value: 21 },
      { t: "metric", at: 1, name: "vaccine.all.returned", value: 7 },
    ]);
    expect(s.vaccination()).toMatchObject({ escalated: 21, returned: 7 });
  });
});
