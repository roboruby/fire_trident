import { describe, expect, it } from "vitest";
import type { ColonyEvent, Proposal } from "@fire_trident/core";
import { ago, colorEnabled, colors, eventsFromMessage, formatEvent, formatReview, formatWhy, num, paths, regionOf } from "../src/format.ts";

const plain = colors(false);
const clock = () => "12:00:00";

describe("small helpers", () => {
  it("formats numbers, ages, paths, and regions", () => {
    expect(num(1284)).toBe("1,284");
    expect(ago(0, 3_000)).toBe("just now");
    expect(ago(0, 90_000)).toBe("1m ago");
    expect(ago(0, 7_200_000)).toBe("2h ago");
    expect(paths(["a", "b", "c", "d"])).toBe("a, b +2");
    expect(regionOf("README.md")).toBe(".");
    expect(regionOf("src/a/b.ts")).toBe("src");
    expect(regionOf("src/a/b.ts", 2)).toBe("src/a");
    expect(regionOf("src/b.ts", 2)).toBe("src");
  });

  it("decides when to use color", () => {
    expect(colorEnabled({}, true, false)).toBe(true);
    expect(colorEnabled({}, false, false)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1" }, true, false)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "1" }, true, true)).toBe(false);
    expect(colors(true).green("x")).toBe("\u001b[32mx\u001b[39m");
  });
});

describe("formatEvent", () => {
  const cases: Array<[ColonyEvent, RegExp]> = [
    [{ t: "agent", at: 0, agentId: "agt_1", kind: "internal", state: "working", intentId: "int_1", paths: ["src/a.ts"] }, /^12:00:00 agent\s+agt_1 working int_1 src\/a\.ts$/],
    [{ t: "mark", at: 0, region: "src", path: "src/a.ts", kind: "need", value: 1 }, /^12:00:00 mark\s+need 1\.00 src\/a\.ts \(src\)$/],
    [{ t: "intent", at: 0, intentId: "int_1", status: "claimed", title: "Fix it", footprint: ["src/a.ts"] }, /intent\s+int_1 claimed "Fix it" src\/a\.ts$/],
    [{ t: "proposal", at: 0, proposalId: "prp_1", intentId: "int_1", agentId: "agt_1", status: "returned", reason: "stale read: src/a.ts" }, /proposal\s+prp_1 returned int_1 by agt_1 stale read: src\/a\.ts$/],
    [{ t: "landing", at: 0, landingId: "l", trunkSha: "abcdef0123", proposalIds: ["a", "b"], paths: ["x", "y", "z"] }, /landing\s+abcdef0 2 proposals, 3 paths x, y \+1$/],
    [{ t: "decision", at: 0, decisionId: "d", kind: "collision", layer: "reflex", p: 0.9, action: "reroute", subject: "agt_1" }, /decision\s+reflex collision p=0\.90 → reroute agt_1$/],
    [{ t: "sigma", at: 0, region: "src", sigma: 0.95 }, /sigma\s+src 0\.95$/],
    [{ t: "violations", at: 0, total: 1284, byRule: { r1: 1284 } }, /violations 1,284 left \(r1 1,284\)$/],
    [{ t: "metric", at: 0, name: "lanes", value: 3 }, /metric\s+lanes 3$/],
  ];
  it.each(cases)("formats %o", (event, pattern) => {
    expect(formatEvent(event, plain, clock)).toMatch(pattern);
  });

  it("prints unknown event types instead of dropping them", () => {
    expect(formatEvent({ t: "future", at: 0 } as unknown as ColonyEvent, plain, clock)).toMatch(/future\s+\{"t":"future","at":0\}/);
  });
});

describe("eventsFromMessage", () => {
  it("accepts one event, an array, or an events wrapper, and skips junk", () => {
    expect(eventsFromMessage('{"t":"metric","at":0,"name":"x","value":1}')).toHaveLength(1);
    expect(eventsFromMessage('[{"t":"metric"},{"t":"sigma"}]')).toHaveLength(2);
    expect(eventsFromMessage('{"events":[{"t":"metric"}]}')).toHaveLength(1);
    expect(eventsFromMessage("not json")).toEqual([]);
    expect(eventsFromMessage('{"hello":1}')).toEqual([]);
  });
});

describe("formatReview", () => {
  it("shows each escalated proposal with its intent title and residual", () => {
    const p = {
      id: "prp_1",
      colonyId: "web",
      intentId: "int_1",
      agentId: "agt_1",
      workspace: { namespace: "n", name: "w", remote: "r" },
      baseSha: "a",
      headSha: "b",
      writeSet: [{ path: "src/a.ts", blob: "c" }],
      readSet: [],
      declared: { footprint: ["src/a.ts"], summary: "Swap console for logger" },
      evidence: { checks: [{ name: "tests", ok: false, ms: 300 }], residual: ["src/auth.ts"] },
      status: "escalated",
      createdAt: 0,
      reason: "residual touches auth",
    } as Proposal;
    const text = formatReview([p], [{ id: "int_1", title: "Remove console from src/a.ts" } as never], plain, 120_000);
    expect(text).toContain('prp_1  "Remove console from src/a.ts"  agt_1 · 1 file(s) · 2m ago');
    expect(text).toContain("residual src/auth.ts");
    expect(text).toContain("✗ tests 300ms");
  });
});

describe("formatWhy", () => {
  it("explains a file with no lineage yet", () => {
    expect(formatWhy({ path: "src/a.ts" }, [], {}, plain, 0)).toContain("no FireTrident landing touched this yet");
  });

  it("survives partial lineage notes", () => {
    const partial = [
      { landing: { id: "lnd_1", trunkSha: "abcdef0", parentSha: "1234567" }, note: { proposals: [{ id: "prp_1", agentId: "agt_1", agentKind: "internal", decisions: [{ layer: "reflex", kind: "triage", action: "land" }] }] } },
      { landing: undefined, note: undefined },
    ] as unknown as Parameters<typeof formatWhy>[1];
    const text = formatWhy({ path: "src/a.ts", line: 2 }, partial, {}, plain, 0);
    expect(text).toContain("src/a.ts:2  1 landing, newest first");
    expect(text).toContain("landing lnd_1  abcdef0 ← 1234567");
    expect(text).toContain('intent   ? "(intent not recorded)"');
    expect(text).toContain("decided  reflex triage → land");
  });

  // Two landings that each wrote src/a.ts with another proposal beside it; the older one wrote line 3.
  const landingOf = (id: string, at: number) => ({
    landing: { id, colonyId: "c", trunkSha: id.padEnd(40, "0"), parentSha: "p".padEnd(40, "0"), proposalIds: [`prp_${id}`, `prp_${id}b`], intentIds: [`int_${id}`, `int_${id}b`], paths: ["src/a.ts", "src/x.ts"], regions: ["src"], at },
    note: {
      schema: "firetrident.lineage/v1",
      landingId: id,
      colonyId: "c",
      proposals: [
        { id: `prp_${id}`, agentId: "a1", agentKind: "internal", intent: { id: `int_${id}`, title: `wrote src/a.ts in ${id}`, why: "" }, writeSet: [{ path: "src/a.ts", blob: null }], readSet: [], decisions: [], evidence: { checks: [] } },
        { id: `prp_${id}b`, agentId: "a2", agentKind: "internal", intent: { id: `int_${id}b`, title: `wrote src/x.ts in ${id}`, why: "" }, writeSet: [{ path: "src/x.ts", blob: null }], readSet: [], decisions: [], evidence: { checks: [] } },
      ],
    },
  });
  const ownerFirst = [landingOf("lnd_owner", 1_000), landingOf("lnd_newer", 2_000)] as unknown as Parameters<typeof formatWhy>[1];

  it("keeps the server's order for a line, so the landing that wrote it prints first", () => {
    const text = formatWhy({ path: "src/a.ts", line: 3 }, ownerFirst, {}, plain, 3_000);
    expect(text).toContain("src/a.ts:3  2 landings, the landing that wrote line 3 first, then newest first");
    expect(text.indexOf("landing lnd_owner")).toBeGreaterThan(-1);
    expect(text.indexOf("landing lnd_owner")).toBeLessThan(text.indexOf("landing lnd_newer"));
    expect(text).toContain('intent   int_lnd_owner "wrote src/a.ts in lnd_owner"');
    expect(text).not.toContain("wrote src/x.ts");
  });

  it("lists a whole file newest first, and a line whose landing is the newest as newest first", () => {
    const file = formatWhy({ path: "src/a.ts" }, ownerFirst, {}, plain, 3_000);
    expect(file).toContain("src/a.ts  2 landings, newest first");
    expect(file.indexOf("landing lnd_newer")).toBeLessThan(file.indexOf("landing lnd_owner"));
    const newest = [...(ownerFirst as unknown[])].reverse() as Parameters<typeof formatWhy>[1];
    const line = formatWhy({ path: "src/a.ts", line: 9 }, newest, {}, plain, 3_000);
    expect(line).toContain("src/a.ts:9  2 landings, newest first");
    expect(line.indexOf("landing lnd_newer")).toBeLessThan(line.indexOf("landing lnd_owner"));
  });
});
