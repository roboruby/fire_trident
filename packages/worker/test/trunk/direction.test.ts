import { describe, expect, it } from "vitest";
import type { Landing } from "@fire_trident/core";
import type { DirectionInfo } from "../../src/colony/direction.ts";
import { directionReturns, fenceAnswer, mergeDirection, parseDirection, pushDelayMs, settlesWithin } from "../../src/trunk/direction.ts";

/** A change for `intentId`, built on `intentRevision` (omitted: none recorded), proposed at `createdAt`. */
function change(id: string, intentId: string, intentRevision?: number, createdAt = 0) {
  return { id, intentId, createdAt, ...(intentRevision !== undefined ? { intentRevision } : {}) };
}

function landing(id: string, proposalIds: string[]): Landing {
  return { id, colonyId: "c", trunkSha: id.replace(/\D/g, "").padEnd(40, "0"), parentSha: "0".repeat(40), proposalIds, intentIds: [], paths: [], regions: [], at: 1 };
}

describe("directionReturns: the trunk writer's direction check (its commit point)", () => {
  const withdrawn: DirectionInfo = { status: "withdrawn", revision: 1, withdrawnReason: "not needed" };
  const revised: DirectionInfo = { status: "claimed", revision: 2, revisions: [{ revision: 2, changed: ["why"], reason: "do it the other way", at: 1_000 }] };
  const priorityOnly: DirectionInfo = { status: "proposed", revision: 2, revisions: [] };
  const direction = new Map<string, DirectionInfo>([
    ["int_w", withdrawn],
    ["int_r", revised],
    ["int_p", priorityOnly],
  ]);

  it("sends back a change whose intent was withdrawn", () => {
    expect(directionReturns([change("p1", "int_w", 1)], direction)).toEqual(new Map([["p1", "withdrawn: not needed"]]));
  });

  it("sends back a change built on r1 when a substantive r2 came after it, and lets a change built on r2 through", () => {
    const out = directionReturns([change("p1", "int_r", 1), change("p2", "int_r", 2), change("p3", "int_r", undefined, 500), change("p4", "int_r", undefined, 1_500)], direction);
    expect(out.get("p1")).toBe("intent revised: r1 → r2, why changed (do it the other way)");
    expect(out.has("p2")).toBe(false);
    // No recorded revision: judged by when it was proposed.
    expect(out.get("p3")).toBe("intent revised: r2, why changed (do it the other way)");
    expect(out.has("p4")).toBe(false);
  });

  it("lets a change through when only the priority moved", () => {
    expect(directionReturns([change("p1", "int_p", 1)], direction).size).toBe(0);
  });

  it("lets a change through when its intent has no record (nobody changed its direction)", () => {
    expect(directionReturns([change("p1", "int_unknown", 1)], direction).size).toBe(0);
    expect(directionReturns([change("p1", "int_w", 1)], new Map()).size).toBe(0);
  });

  it("never judges a change that already landed: it stays landed", () => {
    const out = directionReturns([change("p1", "int_w", 1), change("p2", "int_w", 1)], direction, new Set(["p1"]));
    expect(out.has("p1")).toBe(false);
    expect(out.get("p2")).toBe("withdrawn: not needed");
  });
});

describe("the fence's record", () => {
  it("reads stored JSON and drops what is malformed", () => {
    expect(parseDirection(JSON.stringify({ status: "withdrawn", revision: 1, withdrawnReason: "x" }))).toEqual({ status: "withdrawn", revision: 1, withdrawnReason: "x" });
    expect(parseDirection("{not json")).toBeUndefined();
    expect(parseDirection(null)).toBeUndefined();
    expect(parseDirection("[1]")).toBeUndefined();
    expect(
      parseDirection({
        status: "nonsense",
        revision: "2",
        revisions: [{ revision: 2, changed: ["why", "colour"], reason: "r", at: 5 }, { revision: "x" }, null, { revision: 3, at: 6 }],
      }),
    ).toEqual({ revisions: [{ revision: 2, changed: ["why"], reason: "r", at: 5 }, { revision: 3, changed: [], reason: "", at: 6 }] });
  });

  it("only moves forward: a withdrawal stays, otherwise the higher revision wins", () => {
    const w: DirectionInfo = { status: "withdrawn", revision: 2, withdrawnReason: "gone" };
    const r2: DirectionInfo = { status: "claimed", revision: 2 };
    const r3: DirectionInfo = { status: "claimed", revision: 3 };
    expect(mergeDirection(undefined, r2)).toBe(r2);
    expect(mergeDirection(r2, r3)).toBe(r3);
    expect(mergeDirection(r3, r2)).toBe(r3); // an older call that arrives late changes nothing
    expect(mergeDirection(r3, w)).toBe(w);
    expect(mergeDirection(w, r3)).toBe(w);
    const again: DirectionInfo = { status: "withdrawn", revision: 2, withdrawnReason: "gone, really" };
    expect(mergeDirection(w, again)).toBe(again);
  });
});

describe("fenceAnswer", () => {
  const l1 = landing("lnd_1", ["p1", "p2"]);

  it("names each change that landed, each landing once, and vouches for the rest once the cycles are over", () => {
    const out = fenceAnswer(["p1", "p2", "p3", "p1"], new Map([["p1", l1], ["p2", l1]]), true, new Set());
    expect(out.landed).toEqual([
      { proposalId: "p1", landingId: "lnd_1", trunkSha: l1.trunkSha },
      { proposalId: "p2", landingId: "lnd_1", trunkSha: l1.trunkSha },
    ]);
    expect(out.landings).toEqual([l1]);
    expect(out.undetermined).toEqual([]);
  });

  it("cannot vouch when the wait ran out, or for a change in a push whose outcome is unknown", () => {
    expect(fenceAnswer(["p1", "p3"], new Map([["p1", l1]]), false, new Set()).undetermined).toEqual(["p3"]);
    expect(fenceAnswer(["p3", "p4"], new Map(), true, new Set(["p4"])).undetermined).toEqual(["p4"]);
    expect(fenceAnswer(["p3", "p4"], new Map(), true, null).undetermined).toEqual(["p3", "p4"]);
  });
});

describe("settlesWithin and the push delay test hook", () => {
  it("tells whether a promise settled in time (a rejection counts as settled)", async () => {
    expect(await settlesWithin(Promise.resolve(1), 50)).toBe(true);
    expect(await settlesWithin(Promise.reject(new Error("x")), 50)).toBe(true);
    expect(await settlesWithin(new Promise(() => undefined), 10)).toBe(false);
  });

  it("reads FT_TEST_PUSH_DELAY_MS only when it is a positive number, at most 60 s", () => {
    expect(pushDelayMs(undefined)).toBe(0);
    expect(pushDelayMs("")).toBe(0);
    expect(pushDelayMs("soon")).toBe(0);
    expect(pushDelayMs("-5")).toBe(0);
    expect(pushDelayMs("2500")).toBe(2500);
    expect(pushDelayMs("999999")).toBe(60_000);
  });
});
