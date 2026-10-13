import { describe, expect, it } from "vitest";
import type { ColonySnapshot, StuckItem } from "@fire_trident/core";
import { EVENT_TYPES, parseCommand } from "../src/args.ts";
import { colors, formatEvent, formatStatus, stuckCommand } from "../src/format.ts";

/** Stuck work in `ft status` and `ft watch`: each item, how long, and the command that deals with it. */

const plain = colors(false);
const NOW = 1_000_000_000;
const MIN = 60_000;
const colony = { id: "web", name: "web", trunk: { namespace: "n", name: "x", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 } as ColonySnapshot["colony"];

const red: StuckItem = {
  key: `red:${"b".repeat(40)}`,
  kind: "red",
  since: NOW - 31 * MIN,
  text: "Trunk tests have been red since bbbbbbb (5 failing); the change for repair “Make the failing tests pass” waits for a person's review",
  action: "review",
  intentId: "int_r",
  proposalId: "prp_r",
  repair: "review",
};
const report: StuckItem = { key: "report:int_1:1", kind: "report", since: NOW - 22 * MIN, text: "forager-7 reported a broken test on “Fix the router”; it waits for a person's answer", action: "answer", intentId: "int_1", agentId: "agt_7" };
const claimed: StuckItem = {
  key: "claimed:int_2:agt_9:1",
  kind: "claimed",
  since: NOW - 14 * MIN,
  text: "“Add a cache” is claimed by forager-9 with no change proposed yet; it says “reading \u001b[31msrc/cache.ts”",
  action: "agent",
  intentId: "int_2",
  agentId: "agt_9",
};

describe("ft status: stuck work", () => {
  it("lists each item with how long it has been stuck, what is stuck and the command that deals with it", () => {
    const text = formatStatus({ colony, stuck: { at: NOW, items: [red, report, claimed], total: 3 } }, plain, NOW);
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("stuck"));
    expect(lines.slice(at)).toEqual([
      "stuck      3 items, the oldest for 31m",
      "   31m  Trunk tests have been red since bbbbbbb (5 failing); the change for repair “Make the failing tests pass” waits for a person's review",
      "        → review the change: ft review web",
      "   22m  forager-7 reported a broken test on “Fix the router”; it waits for a person's answer",
      "        → answer the report: ft escalation web int_1 amend|withdraw|dismiss --note <text>",
      "   14m  “Add a cache” is claimed by forager-9 with no change proposed yet; it says “reading  [31msrc/cache.ts”",
      '        → look at the agent: ft agents web  (steer it: ft direct web agt_9 "<message>")',
    ]);
  });

  it("says none when nothing is stuck, counts what the list left out, and shows nothing for a server without the detector", () => {
    expect(formatStatus({ colony, stuck: { at: NOW, items: [], total: 0 } }, plain, NOW).split("\n").at(-1)).toBe("stuck      none");
    const cut = formatStatus({ colony, stuck: { at: NOW, items: [claimed], total: 4 } }, plain, NOW).split("\n");
    expect(cut.find((l) => l.startsWith("stuck"))).toBe("stuck      4 items, the oldest for 14m");
    expect(cut.at(-1)).toBe("  +3 more");
    expect(formatStatus({ colony }, plain, NOW)).not.toContain("stuck");
  });

  it("names the command for each action", () => {
    expect(stuckCommand({ action: "intent", intentId: "int_5" }, "web")).toBe("ft intent show web int_5");
    expect(stuckCommand({ action: "tests" }, "web")).toBe("ft certify web");
    expect(stuckCommand({ action: "agent" }, "web")).toBe("ft agents web");
    expect(stuckCommand({ action: "answer" }, "web")).toBe("ft escalation web <intentId> amend|withdraw|dismiss --note <text>");
  });
});

describe("ft watch: stuck events", () => {
  it("prints one line per stuck event, and accepts --only stuck", () => {
    expect(formatEvent({ t: "stuck", at: 0, item: report }, plain, () => "12:00:00")).toBe(
      "12:00:00 stuck      report forager-7 reported a broken test on “Fix the router”; it waits for a person's answer → answer the report",
    );
    expect(formatEvent({ t: "stuck", at: 0, item: red }, plain, () => "12:00:00")).toMatch(/^12:00:00 stuck\s+red Trunk tests have been red since bbbbbbb .* → review the change$/);
    expect(EVENT_TYPES).toContain("stuck");
    const parsed = parseCommand(["watch", "web", "--only", "stuck"]);
    expect(parsed.ok && parsed.command).toEqual({ name: "watch", colony: "web", only: ["stuck"] });
  });
});
