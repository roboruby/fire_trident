import { describe, expect, it } from "vitest";
import { colonyIdsFromTrunks, flag, isUnsupportedRpc, journalFields, mapLimit, messageOf, repoBelongsTo } from "../../src/api/logic.ts";

describe("mapLimit", () => {
  it("keeps input order, settles every item, and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      if (n === 4) throw new Error(`boom ${i}`);
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : (r.reason as Error).message))).toEqual([50, 10, "boom 2", 20, 30, 0]);
  });

  it("handles empty input and silly limits", async () => {
    expect(await mapLimit([], 10, async () => 1)).toEqual([]);
    expect((await mapLimit([1, 2], 0, async (n) => n)).map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});

describe("repo ownership", () => {
  it("matches a colony's own repos only", () => {
    for (const name of ["web--trunk", "web--seed", "web--ws-12", "web--lane-src"]) expect(repoBelongsTo(name, "web")).toBe(true);
    for (const name of ["web-app--trunk", "webby--ws-1", "web--", "web", "other--trunk", "xweb--trunk"]) expect(repoBelongsTo(name, "web")).toBe(false);
    expect(repoBelongsTo("a--b--trunk", "a--b")).toBe(false);
    expect(repoBelongsTo("anything--trunk", "")).toBe(false);
  });

  it("reads colony ids from trunk repo names", () => {
    expect(colonyIdsFromTrunks(["web--trunk", "web--lane-src", "openspec-e2e--trunk", "Bad_Name--trunk", "web--trunk", "x--y--trunk", "z--seed"])).toEqual(["openspec-e2e", "web"]);
  });
});

describe("errors and replies", () => {
  it("strips status tags and never throws", () => {
    expect(messageOf(new Error("[ft:404] unknown agent agt_1"))).toBe("unknown agent agt_1");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(undefined)).toBe("error");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(messageOf(cyclic)).toBe("error");
  });

  it("recognizes an RPC to a method the class lacks", () => {
    expect(isUnsupportedRpc(new TypeError('The RPC receiver does not implement the method "destroy".'))).toBe(true);
    expect(isUnsupportedRpc(new TypeError("x.map is not a function"))).toBe(false);
    expect(isUnsupportedRpc(new Error("Network connection lost."))).toBe(false);
  });

  it("picks journal fields from an agent status reply", () => {
    expect(
      journalFields({
        id: "agt_1",
        running: true,
        step: "commit",
        attempts: 2,
        proposalId: "prp_1",
        lastError: "push refused",
        intentTitle: "Fix it",
        counters: { landed: 3, bad: "x" },
        history: [{}],
        token: "never-copied",
      }),
    ).toEqual({ running: true, step: "commit", attempts: 2, proposalId: "prp_1", lastError: "push refused", intentTitle: "Fix it", counters: { landed: 3 } });
    expect(journalFields(null)).toEqual({});
    expect(journalFields("x")).toEqual({});
  });

  it("reads truthy query flags", () => {
    expect([flag("1"), flag("true"), flag("YES"), flag(" yes ")]).toEqual([true, true, true, true]);
    expect([flag(undefined), flag("0"), flag("no"), flag("")]).toEqual([false, false, false, false]);
  });
});
