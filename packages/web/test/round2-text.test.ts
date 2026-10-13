import { describe, expect, it } from "vitest";
import type { LineageNote } from "@fire_trident/core";
import { amendOf, answeredText, blockedAnswer, parseFootprint } from "../src/escalation.ts";
import { contestText, escalationText, firstLine, listOf, noticeText, revalidatedText } from "../src/eventText.ts";
import { guideAtStart, GUIDE_STEPS } from "../src/guide.ts";
import { alternativesOf, revalidatedOf } from "../src/lineage.ts";

/** The words the round-2 features put on screen, the amend form, the guide's start rule, and lineage notes read defensively. */

describe("event lines", () => {
  it("joins lists for sentences", () => {
    expect(listOf([])).toBe("");
    expect(listOf(["a"])).toBe("a");
    expect(listOf(["a", "b"])).toBe("a and b");
    expect(listOf(["a", "b", "c", "d"])).toBe("a, b and 2 more");
    expect(listOf(["a", "b", "c"], 4)).toBe("a, b and c");
  });

  it("keeps the first line of untrusted text, cut short", () => {
    expect(firstLine("\n\n  first   line \nsecond")).toBe("first line");
    expect(firstLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("says who reported what, and who answered how", () => {
    const e = { kind: "broken-test" as const, title: "Use utils/money in billing/tax.ts" };
    expect(escalationText(e, "forager-007")).toBe("forager-007 reports a broken test: Use utils/money in billing/tax.ts");
    expect(escalationText({ ...e, resolved: { by: "matt", at: 1, decision: "amend", note: "point it at core/money.ts" } }, "x")).toBe("matt amended “Use utils/money in billing/tax.ts” after a report: point it at core/money.ts");
    expect(escalationText({ ...e, resolved: { by: "matt", at: 1, decision: "withdraw", note: "" } }, "x")).toBe("matt withdrew “Use utils/money in billing/tax.ts” after a report");
    expect(escalationText({ ...e, resolved: { by: "matt", at: 1, decision: "dismiss", note: "the test is right" } }, "x")).toBe("matt dismissed the report on “Use utils/money in billing/tax.ts”: the test is right");
  });

  it("describes contests, revalidation and landing notices", () => {
    expect(contestText({ t: "contest", at: 1, intentId: "i", title: "Add gift cards", winner: "prp_000123abcdef9", losers: ["p1", "p2"], reason: "passed first" })).toBe("Add gift cards: prp_bcdef9 won over 2 other attempts · passed first");
    expect(revalidatedText({ t: "revalidated", at: 1, proposalId: "p", intentId: "i", paths: ["src/app.ts"], names: ["Context", "Router"] })).toBe(
      "landed on revalidation: src/app.ts changed after it was read; the imports it relies on (Context and Router) are still exported",
    );
    expect(revalidatedText({ t: "revalidated", at: 1, proposalId: "p", intentId: "i", paths: ["a.ts", "b.ts"], names: [] })).toBe("landed on revalidation: a.ts and b.ts changed after it was read; it imports nothing from them");
    expect(noticeText({ agents: ["a", "b", "c"], paths: ["src/context.ts"], message: "m" })).toBe("told 3 agents: src/context.ts changed");
    expect(noticeText({ agents: ["a"], paths: [], message: "src/x.ts changed on trunk\nmore" })).toBe("told 1 agent: src/x.ts changed on trunk");
    // Malformed events read as text instead of breaking the log.
    expect(contestText({ t: "contest", at: 1 } as unknown as Parameters<typeof contestText>[0])).toBe("An intent: one attempt won over 0 other attempts");
    expect(revalidatedText({ t: "revalidated", at: 1 } as unknown as Parameters<typeof revalidatedText>[0])).toBe("landed on revalidation: files it read changed after it read them; it imports nothing from them");
  });
});

describe("the answer form on a report", () => {
  const current = { title: "Fix rounding", why: "Invoices are off by a cent", footprint: ["billing/tax.ts", "test/billing/tax.test.ts"] };

  it("reads a footprint typed one path per line or with commas", () => {
    expect(parseFootprint(" ./billing/tax.ts\n\n/core/money.ts, billing/tax.ts ")).toEqual(["billing/tax.ts", "core/money.ts"]);
    expect(parseFootprint("")).toEqual([]);
  });

  it("amends only what changed, and nothing when nothing did", () => {
    const same = { title: " Fix rounding ", why: "Invoices are off by a cent", footprint: "billing/tax.ts\ntest/billing/tax.test.ts" };
    expect(amendOf(current, same)).toBeNull();
    expect(amendOf(current, { ...same, title: "Fix rounding half up" })).toEqual({ title: "Fix rounding half up" });
    expect(amendOf(current, { ...same, footprint: "core/money.ts" })).toEqual({ footprint: ["core/money.ts"] });
    // Emptied fields are not amendments: the intent keeps its title, why and footprint.
    expect(amendOf(current, { title: "", why: "", footprint: "" })).toBeNull();
    expect(amendOf({ title: "T", footprint: [] }, { title: "T", why: "now with a why", footprint: "" })).toEqual({ why: "now with a why" });
  });

  it("needs a note for every answer, and a change for an amendment", () => {
    expect(blockedAnswer("dismiss", "  ", null)).toMatch(/note/);
    expect(blockedAnswer("dismiss", "the test is right", null)).toBeNull();
    expect(blockedAnswer("amend", "point it elsewhere", null)).toMatch(/Change the title/);
    expect(blockedAnswer("amend", "point it elsewhere", { title: "x" })).toBeNull();
    expect(answeredText("withdraw")).toMatch(/^Withdrawn/);
  });
});

describe("the first-visit guide", () => {
  it("opens once, never on the recording stage, a lineage link or a timed replay, unless forced", () => {
    expect(guideAtStart("", false, false)).toBe(true);
    expect(guideAtStart("", false, true)).toBe(false);
    expect(guideAtStart("?director=1", true, false)).toBe(false);
    expect(guideAtStart("?guide=1", true, false)).toBe(false);
    expect(guideAtStart("?path=src/index.ts", false, false)).toBe(false);
    expect(guideAtStart("?replay=1&delay=3", false, false)).toBe(false);
    expect(guideAtStart("?replay=1", false, false)).toBe(true);
    expect(guideAtStart("?guide=1", false, true)).toBe(true);
    expect(guideAtStart("?guide=0", false, false)).toBe(false);
  });

  it("walks through the field, agents, lanes, the trunk bar, the reflex arc and the tabs", () => {
    expect(GUIDE_STEPS.map((s) => s.target)).toEqual(["field", "agents", "lanes", "trunk", "funnel", "tabs"]);
    for (const s of GUIDE_STEPS) expect(s.text.split(/\s+/).length).toBeLessThan(60);
  });
});

describe("lineage notes", () => {
  const p = (extra: Record<string, unknown>) => ({ id: "p", agentId: "a", agentKind: "internal", intent: { id: "i", title: "t", why: "w" }, writeSet: [], readSet: [], decisions: [], evidence: { checks: [] }, ...extra }) as unknown as LineageNote["proposals"][number];

  it("reads contest alternatives and revalidation, and nothing from older or malformed notes", () => {
    expect(alternativesOf(p({}))).toEqual([]);
    expect(revalidatedOf(p({}))).toEqual([]);
    expect(alternativesOf(p({ alternatives: [{ proposalId: "p2", agentId: "a2", model: "m", reason: "slower" }, null, { reason: "no id" }, "x"] }))).toEqual([{ proposalId: "p2", agentId: "a2", model: "m", reason: "slower" }]);
    expect(revalidatedOf(p({ revalidated: [{ path: "src/app.ts", read: "r1", landedOn: "r2", names: ["Router", 3] }, { path: "" }, { read: "x" }] }))).toEqual([{ path: "src/app.ts", read: "r1", landedOn: "r2", names: ["Router"] }]);
    expect(revalidatedOf(p({ revalidated: "nope" }))).toEqual([]);
  });
});
