import { describe, expect, it } from "vitest";
import type { StuckItem } from "@fire_trident/core";
import {
  CHECK_CAP,
  CLAIMED_MS,
  LIST_MAX,
  RED_MS,
  STALLED_MS,
  StuckDetector,
  WAITING_MS,
  claimedItem,
  clip,
  ledgerDiff,
  redItem,
  repairState,
  reportItem,
  returnsItem,
  reviewItem,
  sortStuck,
  stalledItem,
  toReport,
  type RepairRow,
  type ReturnedProposal,
} from "../../src/colony/stuck.ts";

/** The stuck-work detector's checks, its ordering, and the ledger that publishes each item once. */

const NOW = 10_000_000_000;
const MIN = 60_000;

describe("an intent claimed with no change", () => {
  const row = { id: "int_1", title: "Fix the router", since: NOW - 11 * MIN, agentId: "agt_7", agentName: "forager-7", note: "reading src/router.ts", noteAt: NOW - 5 * MIN };

  it("is stuck after ten minutes, naming the agent and what it says it is doing", () => {
    expect(claimedItem({ ...row, since: NOW - CLAIMED_MS + 1 }, NOW)).toBeNull();
    expect(claimedItem(row, NOW)).toEqual({
      key: `claimed:int_1:agt_7:${NOW - 11 * MIN}`,
      kind: "claimed",
      since: NOW - 11 * MIN,
      text: "“Fix the router” is claimed by forager-7 with no change proposed yet; it says “reading src/router.ts”",
      action: "agent",
      intentId: "int_1",
      title: "Fix the router",
      agentId: "agt_7",
      note: "reading src/router.ts",
    });
  });

  it("quotes no note from before the claim, and says so", () => {
    const item = claimedItem({ ...row, noteAt: NOW - 20 * MIN }, NOW);
    expect(item?.text).toBe("“Fix the router” is claimed by forager-7 with no change proposed yet; it has not said what it is doing");
    expect(item?.note).toBeUndefined();
    expect(claimedItem({ ...row, agentName: null, note: null, noteAt: null }, NOW)?.text).toMatch(/claimed by agt_7 with/);
  });

  it("keeps untrusted text on one line, without control characters", () => {
    expect(clip("a\u001b[31m red\nline\u202e here", 100)).toBe("a [31m red line here");
    expect(clip("x".repeat(10), 5)).toBe("xxxx…");
    expect(clip(null, 5)).toBe("");
  });
});

describe("an intent whose changes keep coming back", () => {
  const back = (n: number, reason: string, extra: Partial<ReturnedProposal> = {}): ReturnedProposal => ({ status: "returned", createdAt: NOW - n * MIN, updatedAt: NOW - n * MIN + 1_000, reason, supersededBy: null, ...extra });

  it("counts returns and rejections, not changes of direction or lost contests, with the latest reasons", () => {
    const proposals = [
      back(1, "stale: src/a.ts changed on trunk"),
      back(2, "withdrawn: no longer needed"),
      back(3, "intent revised: r1 → r2, why changed (clearer)"),
      back(4, "superseded: recalled by its agent"),
      back(5, "superseded: contest for x won by prp_w", { supersededBy: "prp_w" }),
      back(6, "a person: this breaks the cookie", { status: "rejected" }),
      back(7, "llm: does not handle an empty slug"),
    ];
    const item = returnsItem({ id: "int_2", title: "Shorten links", revision: 1, revisedAt: null, proposals });
    expect(item).toMatchObject({
      key: "returns:int_2:1",
      kind: "returns",
      action: "intent",
      returns: 3,
      reasons: ["stale: src/a.ts changed on trunk", "a person: this breaks the cookie", "llm: does not handle an empty slug"],
      text: "Changes for “Shorten links” came back 3 times; the latest: stale: src/a.ts changed on trunk",
    });
    // Stuck since the third return, the one that reached the threshold.
    expect(item?.since).toBe(NOW - 1 * MIN + 1_000);
  });

  it("starts counting again after a landing or a substantive amendment", () => {
    const three = [back(1, "a"), back(2, "b"), back(3, "c")];
    expect(returnsItem({ id: "i", title: "t", revision: 1, revisedAt: null, proposals: [...three.slice(0, 2), { ...back(3, ""), status: "landed" }, back(4, "d")] })).toBeNull();
    expect(returnsItem({ id: "i", title: "t", revision: 2, revisedAt: NOW - 2.5 * MIN, proposals: three })).toBeNull();
    expect(returnsItem({ id: "i", title: "t", revision: 2, revisedAt: NOW - 9 * MIN, proposals: three })).toMatchObject({ key: "returns:i:2", returns: 3 });
  });
});

describe("a red trunk", () => {
  const repair = (over: Partial<RepairRow> = {}): RepairRow => ({ id: "int_r", title: "Make the failing tests pass", status: "open", reported: false, agentId: null, agentName: null, proposal: null, ...over });
  const red = (rep: RepairRow | null, firstAt = NOW - 20 * MIN) => ({ latest: { trunkSha: "b".repeat(40), status: "red", failing: 5 }, first: { trunkSha: "a".repeat(40), at: firstAt }, repair: rep });

  it("is stuck after fifteen minutes red, and only while the newest result is red", () => {
    expect(redItem(red(null, NOW - RED_MS + 1), NOW)).toBeNull();
    expect(redItem({ ...red(null), latest: { trunkSha: "c".repeat(40), status: "green", failing: 0 } }, NOW)).toBeNull();
    expect(redItem({ latest: null, first: null, repair: null }, NOW)).toBeNull();
    expect(redItem(red(null), NOW)).toEqual({
      key: `red:${"a".repeat(40)}`,
      kind: "red",
      since: NOW - 20 * MIN,
      text: "Trunk tests have been red since aaaaaaa (5 failing); no repair intent is open",
      action: "tests",
      trunkSha: "a".repeat(40),
    });
  });

  it("says whether the repair is open, worked on, being checked, escalated to review or reported to a person", () => {
    expect(redItem(red(repair()), NOW)).toMatchObject({ repair: "open", action: "tests", intentId: "int_r", text: expect.stringMatching(/repair “Make the failing tests pass” waits for an agent to take it$/) });
    expect(redItem(red(repair({ status: "claimed", agentId: "agt_3", agentName: "forager-3" })), NOW)).toMatchObject({ repair: "working", action: "agent", agentId: "agt_3", text: expect.stringMatching(/forager-3 is working on repair/) });
    expect(redItem(red(repair({ status: "proposed", proposal: { id: "prp_1", status: "checking" } })), NOW)).toMatchObject({ repair: "proposed", action: "tests", proposalId: "prp_1" });
    expect(redItem(red(repair({ status: "proposed", proposal: { id: "prp_2", status: "escalated" } })), NOW)).toMatchObject({
      repair: "review",
      action: "review",
      proposalId: "prp_2",
      text: expect.stringMatching(/the change for repair “Make the failing tests pass” waits for a person's review$/),
    });
    expect(redItem(red(repair({ reported: true })), NOW)).toMatchObject({ repair: "reported", action: "answer", text: expect.stringMatching(/cannot be done as written, and a person must answer$/) });
    expect(repairState(repair({ reported: true, status: "open" }))).toBe("reported");
  });
});

describe("waiting for a person", () => {
  const escalation = (at: number, extra: Record<string, unknown> = {}) => JSON.stringify({ kind: "broken-test", report: "the test expects 405", by: "agt_5", at, ...extra });

  it("reports an agent's report after ten minutes without an answer", () => {
    const row = { id: "int_3", title: "Return 404", escalation: escalation(NOW - 12 * MIN), updatedAt: NOW - 12 * MIN, agentName: "forager-5" };
    expect(reportItem(row, NOW)).toEqual({
      key: `report:int_3:${NOW - 12 * MIN}`,
      kind: "report",
      since: NOW - 12 * MIN,
      text: "forager-5 reported a broken test on “Return 404”; it waits for a person's answer",
      action: "answer",
      intentId: "int_3",
      title: "Return 404",
      agentId: "agt_5",
    });
    expect(reportItem({ ...row, escalation: escalation(NOW - WAITING_MS + 1) }, NOW)).toBeNull();
    expect(reportItem({ ...row, escalation: escalation(NOW - 12 * MIN, { resolved: { by: "m", at: NOW, decision: "dismiss", note: "n" } }) }, NOW)).toBeNull();
    // An unreadable report still counts, from the intent's own time.
    expect(reportItem({ ...row, escalation: "{not json" }, NOW)).toMatchObject({ since: NOW - 12 * MIN, text: "forager-5 reported a problem on “Return 404”; it waits for a person's answer" });
  });

  it("reports a change waiting ten minutes for review", () => {
    const row = { id: "prp_9", intentId: "int_9", agentId: "agt_9", since: NOW - 11 * MIN, title: "Add a cache", agentName: "forager-9" };
    expect(reviewItem({ ...row, since: NOW - WAITING_MS + 1 }, NOW)).toBeNull();
    expect(reviewItem(row, NOW)).toEqual({
      key: "review:prp_9",
      kind: "review",
      since: NOW - 11 * MIN,
      text: "A change for “Add a cache” by forager-9 waits for a person's review",
      action: "review",
      intentId: "int_9",
      title: "Add a cache",
      agentId: "agt_9",
      proposalId: "prp_9",
    });
  });
});

describe("an agent alive but not progressing", () => {
  const row = {
    id: "agt_4",
    name: "forager-4",
    intentId: "int_4",
    title: "Split the store",
    note: "proposing",
    noteAt: NOW - 30 * MIN,
    createdAt: NOW - 60 * MIN,
    claimAt: NOW - 25 * MIN,
    proposal: { id: "prp_4", status: "checking", createdAt: NOW - 24 * MIN, updatedAt: NOW - 24 * MIN },
  };

  it("is stuck when nothing about its work moved for ten minutes", () => {
    expect(stalledItem(row, NOW, new Set())).toEqual({
      key: `agent:agt_4:${NOW - 24 * MIN}`,
      kind: "agent",
      since: NOW - 24 * MIN,
      text: "forager-4 is alive but its work on “Split the store” has not moved: its change prp_4 is still being checked; it last said “proposing”",
      action: "agent",
      agentId: "agt_4",
      intentId: "int_4",
      title: "Split the store",
      proposalId: "prp_4",
      note: "proposing",
    });
    expect(stalledItem({ ...row, proposal: { ...row.proposal, status: "ready" } }, NOW, new Set())?.text).toMatch(/its change prp_4 still waits for its lane;/);
  });

  it("moves with a note, a change, an outcome or a claim, and leaves agents other items name", () => {
    expect(stalledItem({ ...row, noteAt: NOW - STALLED_MS + 1 }, NOW, new Set())).toBeNull();
    expect(stalledItem({ ...row, proposal: { ...row.proposal, updatedAt: NOW - 2 * MIN } }, NOW, new Set())).toBeNull();
    expect(stalledItem({ ...row, claimAt: NOW - MIN }, NOW, new Set())).toBeNull();
    expect(stalledItem(row, NOW, new Set(["agt_4"]))).toBeNull();
    expect(stalledItem({ ...row, proposal: { ...row.proposal, status: "escalated" } }, NOW, new Set())).toBeNull();
    expect(stalledItem({ ...row, proposal: null, note: null }, NOW, new Set())?.text).toBe("forager-4 is alive but its work on “Split the store” has not moved; it has not said what it is doing");
  });
});

describe("the report and the ledger", () => {
  const item = (kind: StuckItem["kind"], key: string, since: number): StuckItem => ({ key, kind, since, text: key, action: "agent" });

  it("lists the kinds most in need of a person first, oldest first, cut to the cap with the total", () => {
    const items = [item("agent", "g", 1), item("claimed", "c2", 5), item("red", "r", 9), item("claimed", "c1", 2), item("review", "v", 3), item("report", "p", 4), item("returns", "t", 0)];
    expect(sortStuck(items).map((i) => i.key)).toEqual(["r", "p", "v", "c1", "c2", "t", "g"]);
    const many = Array.from({ length: LIST_MAX + 5 }, (_, n) => item("claimed", `k${n}`, n));
    const report = toReport(many, NOW);
    expect(report.at).toBe(NOW);
    expect(report.total).toBe(LIST_MAX + 5);
    expect(report.items).toHaveLength(LIST_MAX);
  });

  it("publishes each item once, clears what cleared, and publishes it again when it comes back", () => {
    const all = new Set<StuckItem["kind"]>(["claimed", "returns", "red", "report", "review", "agent"]);
    const a = item("claimed", "claimed:i:a:1", 1);
    const b = item("review", "review:p", 2);
    // First look: both are new.
    let ledger: Array<{ key: string; kind: string }> = [];
    let d = ledgerDiff([a, b], ledger, all);
    expect(d.publish.map((i) => i.key)).toEqual(["review:p", "claimed:i:a:1"]);
    expect(d.clear).toEqual([]);
    ledger = d.publish.map((i) => ({ key: i.key, kind: i.kind }));
    // Still stuck: nothing more.
    expect(ledgerDiff([a, b], ledger, all)).toEqual({ publish: [], clear: [] });
    // The claim cleared: it leaves the ledger and nothing is published for it.
    d = ledgerDiff([b], ledger, all);
    expect(d).toEqual({ publish: [], clear: ["claimed:i:a:1"] });
    ledger = ledger.filter((r) => !d.clear.includes(r.key));
    // It comes back later: published again.
    expect(ledgerDiff([a, b], ledger, all).publish.map((i) => i.key)).toEqual(["claimed:i:a:1"]);
  });

  it("keeps the keys of a check that was cut short, and drops keys of kinds it does not know", () => {
    const ledger = [
      { key: "claimed:i:a:1", kind: "claimed" },
      { key: "review:p", kind: "review" },
      { key: "later:x", kind: "later" },
    ];
    expect(ledgerDiff([], ledger, new Set(["review"])).clear).toEqual(["review:p", "later:x"]);
    // Duplicate keys publish once.
    const dup = item("agent", "agent:a:1", 1);
    expect(ledgerDiff([dup, dup], [], new Set()).publish).toHaveLength(1);
  });
});

describe("the detector", () => {
  /** A stand-in for a colony's SQLite: canned rows per query, and a query that fails. */
  function fakeSql(rows: (query: string) => unknown[], fail: RegExp | null = null): SqlStorage {
    return {
      exec(query: string) {
        if (fail && fail.test(query)) throw new Error("malformed JSON");
        const out = rows(query);
        return { toArray: () => out, one: () => out[0] ?? { at: null }, [Symbol.iterator]: () => out[Symbol.iterator]() };
      },
    } as unknown as SqlStorage;
  }

  it("reports what the other checks find when one of them fails, and marks only the finished checks complete", () => {
    const claimed = { id: "int_1", title: "Fix the router", since: NOW - 11 * MIN, agent_id: "agt_7", agent_name: "forager-7", note: null, note_at: null };
    const sql = fakeSql((q) => (q.includes("i.status = 'claimed'") ? [claimed] : []), /FROM certifications/);
    const found = new StuckDetector(sql, 10 * MIN).find(NOW);
    expect(found.items.map((i) => i.kind)).toEqual(["claimed"]);
    expect([...found.complete].sort()).toEqual(["agent", "claimed", "report", "returns", "review"]);
  });

  it("treats a check that fills its cap as cut short", () => {
    const claimed = Array.from({ length: CHECK_CAP }, (_, n) => ({ id: `int_${n}`, title: "t", since: NOW - 11 * MIN, agent_id: null, agent_name: null, note: null, note_at: null }));
    const found = new StuckDetector(fakeSql((q) => (q.includes("i.status = 'claimed'") ? claimed : [])), 10 * MIN).find(NOW);
    expect(found.items).toHaveLength(CHECK_CAP);
    expect(found.complete.has("claimed")).toBe(false);
  });
});
