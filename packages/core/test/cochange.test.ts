import { describe, expect, it } from "vitest";
import {
  COCHANGE_DEFAULTS,
  CoChangeGraph,
  changeFiles,
  edgeWeights,
  followUps,
  learnChange,
  neighborRepulsion,
  rankNeighbors,
  repulsionCoupling,
} from "../src/cochange.ts";
import type { CoChangeReader, CoEdge, CoFile, Neighbor } from "../src/cochange.ts";

const empty: CoChangeReader = { file: () => undefined, edge: () => undefined };

/** Hebbian weight a -> b in a graph. */
const hebb = (g: CoChangeGraph, a: string, b: string): number => edgeWeights(g.file(a), g.edge(a, b), g.params).hebb;
const stdp = (g: CoChangeGraph, a: string, b: string): number => edgeWeights(g.file(a), g.edge(a, b), g.params).stdp;

describe("changeFiles", () => {
  it("keeps distinct files in first-seen order and drops empties, directories and globs", () => {
    expect(changeFiles(["b.ts", "a.ts", "b.ts", "", "src/", "src/*.ts", "x/{a,b}.ts", "c?.ts", "c.ts"])).toEqual(["b.ts", "a.ts", "c.ts"]);
  });

  it("is null for an empty change and for a mass edit", () => {
    expect(changeFiles([])).toBeNull();
    expect(changeFiles(["src/"])).toBeNull();
    const many = Array.from({ length: 31 }, (_, i) => `f${i}.ts`);
    expect(changeFiles(many)).toBeNull();
    expect(changeFiles(many.slice(0, 30))).toHaveLength(30);
    expect(changeFiles(["a", "b", "c"], 2)).toBeNull();
  });
});

describe("learnChange (Hebbian)", () => {
  it("advances each file's clock and wires every ordered pair with one unit", () => {
    const u = learnChange(empty, ["a", "b", "c"]);
    expect(u.files).toEqual([
      { path: "a", file: { n: 1, mass: 1 } },
      { path: "b", file: { n: 1, mass: 1 } },
      { path: "c", file: { n: 1, mass: 1 } },
    ]);
    expect(u.edges).toHaveLength(6);
    for (const e of u.edges) expect(e.edge).toEqual({ hebb: 1, stdp: 0, at: 1 });
  });

  it("learns nothing from a single file, a mass edit, or nothing", () => {
    expect(learnChange(empty, ["a"]).edges).toEqual([]);
    expect(learnChange(empty, ["a"]).files).toEqual([{ path: "a", file: { n: 1, mass: 1 } }]);
    expect(learnChange(empty, Array.from({ length: 40 }, (_, i) => `f${i}`))).toEqual({ files: [], edges: [] });
    expect(learnChange(empty, [])).toEqual({ files: [], edges: [] });
  });

  it("estimates P(b changes | a changes), shrunk by the prior", () => {
    const g = new CoChangeGraph({ retain: 1 });
    g.learn(["a", "b"]);
    expect(hebb(g, "a", "b")).toBeCloseTo(1 / 2, 12);
    g.learn(["a", "b"]);
    expect(hebb(g, "a", "b")).toBeCloseTo(2 / 3, 12);
    g.learn(["a"]);
    g.learn(["a"]);
    // a changed 4 times, twice with b: 2 / (4 + 1).
    expect(hebb(g, "a", "b")).toBeCloseTo(2 / 5, 12);
    // b changed twice, both times with a: 2 / (2 + 1).
    expect(hebb(g, "b", "a")).toBeCloseTo(2 / 3, 12);
  });

  it("decays a file's evidence only as that file changes again", () => {
    const g = new CoChangeGraph({ retain: 0.5 });
    g.learn(["a", "b"]);
    const before = hebb(g, "a", "b");
    for (let i = 0; i < 20; i++) g.learn(["x", "y"]);
    expect(hebb(g, "a", "b")).toBe(before);
    g.learn(["a", "c"]);
    // a's mass: 1 * 0.5 + 1 = 1.5; a -> b carried one step: 0.5.
    expect(hebb(g, "a", "b")).toBeCloseTo(0.5 / (1.5 + 1), 12);
    expect(hebb(g, "a", "c")).toBeCloseTo(1 / 2.5, 12);
    // b never changed again, so b -> a is untouched.
    expect(hebb(g, "b", "a")).toBeCloseTo(0.5, 12);
  });

  it("forgets old partners and learns new ones under steady change", () => {
    const g = new CoChangeGraph({ retain: 0.8 });
    for (let i = 0; i < 10; i++) g.learn(["a", "old"]);
    for (let i = 0; i < 30; i++) g.learn(["a", "new"]);
    expect(hebb(g, "a", "new")).toBeGreaterThan(0.75);
    expect(hebb(g, "a", "old")).toBeLessThan(0.01);
  });

  it("never mutates the records it reads", () => {
    const file: CoFile = { n: 3, mass: 2 };
    const edge: CoEdge = { hebb: 1.5, stdp: -0.2, at: 1 };
    const reader: CoChangeReader = { file: (p) => (p === "a" ? file : undefined), edge: (s, d) => (s === "a" && d === "b" ? edge : undefined) };
    const u = learnChange(reader, ["a", "b"], [], { retain: 0.5 });
    expect(file).toEqual({ n: 3, mass: 2 });
    expect(edge).toEqual({ hebb: 1.5, stdp: -0.2, at: 1 });
    const ab = u.edges.find((e) => e.src === "a" && e.dst === "b")!;
    // Carried from clock 1 to clock 4 (3 steps at 0.5), then +1.
    expect(ab.edge.hebb).toBeCloseTo(1.5 * 0.125 + 1, 12);
    expect(ab.edge.stdp).toBeCloseTo(-0.2 * 0.125, 12);
    expect(ab.edge.at).toBe(4);
  });

  it("keeps Hebbian weights in [0, 1)", () => {
    const g = new CoChangeGraph();
    for (let i = 0; i < 500; i++) g.learn(["a", "b"]);
    const w = hebb(g, "a", "b");
    expect(w).toBeGreaterThan(0.95);
    expect(w).toBeLessThan(1);
  });
});

describe("learnChange (STDP)", () => {
  it("potentiates earlier -> later and depresses later -> earlier", () => {
    const g = new CoChangeGraph({ retain: 1, stdpPlus: 0.5, stdpMinus: 0.5 });
    g.learn(["a"]);
    g.learn(["b"], [{ paths: ["a"], lag: 1 }]);
    // a: mass 1; a -> b: +0.5 / (1 + 1). b: mass 1; b -> a: -0.5 / (1 + 1).
    expect(stdp(g, "a", "b")).toBeCloseTo(0.25, 12);
    expect(stdp(g, "b", "a")).toBeCloseTo(-0.25, 12);
    expect(hebb(g, "a", "b")).toBe(0);
  });

  it("weakens with lag", () => {
    const g = new CoChangeGraph({ retain: 1, stdpPlus: 0.5 });
    g.learn(["a"]);
    g.learn(["b"], [{ paths: ["a"], lag: 2 }]);
    expect(stdp(g, "a", "b")).toBeCloseTo(0.125, 12);
    const h = new CoChangeGraph({ retain: 1, stdpLagDecay: 0 });
    h.learn(["a"]);
    h.learn(["b"], [{ paths: ["a"], lag: 2 }]);
    expect(h.edge("a", "b")).toBeUndefined();
  });

  it("ignores files present in both changes, bad lags, and mass-edit predecessors", () => {
    const g = new CoChangeGraph({ retain: 1, stdpPlus: 0.5 });
    g.learn(["a", "s"]);
    g.learn(["b", "s"], [
      { paths: ["a", "s"], lag: 1 },
      { paths: ["a"], lag: 0 },
      { paths: Array.from({ length: 50 }, (_, i) => `m${i}`), lag: 1 },
    ]);
    expect(g.edge("s", "b")?.stdp ?? 0).toBe(0);
    expect(g.edge("a", "s")?.stdp ?? 0).toBe(0);
    expect(g.edge("a", "b")?.stdp).toBeCloseTo(0.5, 12);
    expect(g.edge("m0", "b")).toBeUndefined();
  });

  it("clamps the STDP weight to [-1, 1]", () => {
    const g = new CoChangeGraph({ retain: 1, stdpPlus: 10 });
    g.learn(["a"]);
    g.learn(["b"], [{ paths: ["a"], lag: 1 }]);
    expect(stdp(g, "a", "b")).toBe(1);
  });
});

describe("edgeWeights and repulsionCoupling", () => {
  it("are zero without records", () => {
    expect(edgeWeights(undefined, { hebb: 1, stdp: 1, at: 1 })).toEqual({ hebb: 0, stdp: 0 });
    expect(edgeWeights({ n: 1, mass: 1 }, undefined)).toEqual({ hebb: 0, stdp: 0 });
  });

  it("uses the stronger Hebbian direction plus forward potentiation only", () => {
    expect(repulsionCoupling({ hebb: 0.2, stdp: 0 }, { hebb: 0.6, stdp: 0 })).toBeCloseTo(0.6, 12);
    expect(repulsionCoupling({ hebb: 0.6, stdp: 0 }, { hebb: 0.2, stdp: 0 })).toBeCloseTo(0.6, 12);
    expect(repulsionCoupling({ hebb: 0.3, stdp: 0 }, { hebb: 0.1, stdp: 0.25 })).toBeCloseTo(0.55, 12);
    // g -> f depressed: f is upstream of g; the Hebbian part stays.
    expect(repulsionCoupling({ hebb: 0.3, stdp: 0.9 }, { hebb: 0.1, stdp: -0.5 })).toBeCloseTo(0.3, 12);
    expect(repulsionCoupling({ hebb: 0.9, stdp: 0 }, { hebb: 0.9, stdp: 1 })).toBe(1);
    expect(repulsionCoupling({ hebb: Number.NaN, stdp: 0 }, { hebb: 0, stdp: Number.NaN })).toBe(0);
  });

  it("gives direction: a claim on the upstream file repels the downstream file more", () => {
    const g = new CoChangeGraph({ retain: 1, stdpPlus: 0.5, stdpMinus: 0.5 });
    for (let i = 0; i < 3; i++) {
      g.learn(["types", "router"]);
      g.learn(["types"]);
      g.learn(["router"], [{ paths: ["types"], lag: 1 }]);
    }
    const onRouter = g.neighbors("router", 5).find((n) => n.path === "types")!.weight;
    const onTypes = g.neighbors("types", 5).find((n) => n.path === "router")!.weight;
    expect(onRouter).toBeGreaterThan(onTypes);
  });
});

describe("rankNeighbors", () => {
  const file = (n: number): CoFile => ({ n, mass: n });
  const e = (hebb: number, stdp = 0, at = 1): CoEdge => ({ hebb, stdp, at });

  it("ranks by coupling, keeps at most k, honors minWeight, and breaks ties by path", () => {
    const edges = {
      file: file(3),
      out: [
        { path: "b", edge: e(3) },
        { path: "c", edge: e(1) },
        { path: "d", edge: e(1) },
        { path: "self", edge: e(3) },
      ],
      in: [
        { path: "c", edge: e(1, 1), file: file(1) },
        { path: "e", edge: e(1), file: file(9) },
      ],
    };
    // a's mass 3, prior 1: b 3/4, c max(1/4, 1/2) + 1/2 = 1, d 1/4, e 1/10.
    const all = rankNeighbors("self", edges, 10, 0, { retain: 1 });
    expect(all.map((n) => n.path)).toEqual(["c", "b", "d", "e"]);
    expect(all[0]!.weight).toBe(1);
    expect(all[1]!.weight).toBeCloseTo(0.75, 12);
    expect(rankNeighbors("self", edges, 2, 0, { retain: 1 }).map((n) => n.path)).toEqual(["c", "b"]);
    expect(rankNeighbors("self", edges, 10, 0.2, { retain: 1 }).map((n) => n.path)).toEqual(["c", "b", "d"]);
    expect(rankNeighbors("self", edges, 0)).toEqual([]);
    const tie = rankNeighbors("x", { file: file(1), out: [{ path: "z", edge: e(1) }, { path: "y", edge: e(1) }], in: [] }, 5);
    expect(tie.map((n) => n.path)).toEqual(["y", "z"]);
  });

  it("drops neighbors whose only evidence is depression", () => {
    const g = new CoChangeGraph({ retain: 1, stdpPlus: 0.5, stdpMinus: 0.5 });
    g.learn(["a"]);
    g.learn(["b"], [{ paths: ["a"], lag: 1 }]);
    expect(g.neighbors("b", 5).map((n) => n.path)).toEqual(["a"]);
    expect(g.neighbors("a", 5)).toEqual([]);
  });
});

describe("neighborRepulsion", () => {
  const table: Record<string, Neighbor[]> = {
    "a.ts": [
      { path: "x.ts", weight: 0.5 },
      { path: "b.ts", weight: 0.9 },
      { path: "y.ts", weight: 0.2 },
    ],
    "b.ts": [
      { path: "x.ts", weight: 0.5 },
      { path: "lib/z.ts", weight: 0.8 },
    ],
  };
  const nb = (p: string) => table[p];

  it("weights each neighbor's claim by the noisy-or of its couplings to the footprint", () => {
    const claims: Record<string, number> = { "x.ts": 1, "y.ts": 2, "b.ts": 5 };
    const claimOn = (p: string) => claims[p] ?? 0;
    // Footprint [a]: x 0.5*1 + y 0.2*2 + b 0.9*5.
    expect(neighborRepulsion(["a.ts"], nb, claimOn)).toBeCloseTo(0.5 + 0.4 + 4.5, 12);
    // Footprint [a, b]: b is inside (repelled directly); x couples twice: 1 - 0.5 * 0.5 = 0.75.
    expect(neighborRepulsion(["a.ts", "b.ts"], nb, claimOn)).toBeCloseTo(0.75 + 0.4, 12);
  });

  it("is zero without claims, neighbors, or a footprint", () => {
    expect(neighborRepulsion(["a.ts"], nb, () => 0)).toBe(0);
    expect(neighborRepulsion(["q.ts"], nb, () => 1)).toBe(0);
    expect(neighborRepulsion([], nb, () => 1)).toBe(0);
  });

  it("skips neighbors covered by a directory or glob entry, and ignores bad values", () => {
    const claimOn = (p: string) => (p === "lib/z.ts" ? 1 : p === "x.ts" ? Number.NaN : 0);
    expect(neighborRepulsion(["b.ts"], nb, claimOn)).toBeCloseTo(0.8, 12);
    expect(neighborRepulsion(["b.ts", "lib/"], nb, claimOn)).toBe(0);
    expect(neighborRepulsion(["b.ts", "lib/*.ts"], nb, claimOn)).toBe(0);
    const bad = (p: string) => (p === "a.ts" ? [{ path: "q", weight: Number.NaN }, { path: "r", weight: -1 }, { path: "s", weight: 7 }] : undefined);
    expect(neighborRepulsion(["a.ts"], bad, () => 1)).toBe(1);
  });
});

describe("followUps", () => {
  const H = 3_600_000;

  it("links an author's recent commits as predecessors, most recent at lag 1", () => {
    const commits = [
      { paths: ["a"], author: "x", at: 0 },
      { paths: ["b"], author: "y", at: H },
      { paths: ["c"], author: "x", at: 2 * H },
      { paths: ["d"], author: "x", at: 3 * H },
      { paths: ["e"] },
    ];
    expect(followUps(commits, 3, 24 * H)).toEqual([
      [],
      [],
      [{ paths: ["a"], lag: 1 }],
      [
        { paths: ["c"], lag: 1 },
        { paths: ["a"], lag: 2 },
      ],
      [],
    ]);
  });

  it("defaults to the last 3 commits within 6 hours", () => {
    const commits = [0, 1, 2, 3, 4].map((i) => ({ paths: [`f${i}`], author: "x", at: i * H }));
    expect(followUps(commits)[4]!.map((p) => p.lag)).toEqual([1, 2, 3]);
    const spread = [0, 7].map((i) => ({ paths: [`f${i}`], author: "x", at: i * H }));
    expect(followUps(spread)[1]).toEqual([]);
  });

  it("honors the window and the horizon", () => {
    const commits = [0, 1, 2, 3].map((i) => ({ paths: [`f${i}`], author: "x", at: i * 10 * H }));
    expect(followUps(commits, 1, 24 * H)[3]).toEqual([{ paths: ["f2"], lag: 1 }]);
    expect(followUps(commits, 3, 5 * H)[3]).toEqual([]);
    expect(followUps(commits, 3, Number.POSITIVE_INFINITY)[3]).toHaveLength(3);
    expect(followUps(commits, 0)[3]).toEqual([]);
  });
});

describe("CoChangeGraph", () => {
  it("learns a small history and ranks the strongest partners first", () => {
    const g = new CoChangeGraph();
    const history = [
      ["src/app.ts", "src/types.ts"],
      ["src/app.ts", "src/types.ts", "src/router.ts"],
      ["src/app.ts", "src/types.ts"],
      ["docs/a.md", "docs/b.md"],
      ["src/router.ts", "test/router.test.ts"],
    ];
    for (const c of history) g.learn(c);
    const nb = g.neighbors("src/app.ts", 2);
    expect(nb.map((n) => n.path)).toEqual(["src/types.ts", "src/router.ts"]);
    expect(nb[0]!.weight).toBeGreaterThan(0.7);
    expect(g.neighbors("docs/a.md", 5).map((n) => n.path)).toEqual(["docs/b.md"]);
    expect(g.stats()).toEqual({ changes: 5, files: 6, edges: 10 });
    expect(g.paths()).toContain("test/router.test.ts");
  });

  it("is deterministic", () => {
    const run = () => {
      const g = new CoChangeGraph();
      for (let i = 0; i < 50; i++) g.learn([`f${i % 7}`, `f${(i * 3) % 5}`, `f${(i * 5) % 11}`], i > 0 ? [{ paths: [`f${(i - 1) % 7}`], lag: 1 }] : []);
      return JSON.stringify(g.paths().map((p) => g.neighbors(p, 4)));
    };
    expect(run()).toBe(run());
  });

  it("uses the documented defaults", () => {
    expect(new CoChangeGraph().params).toEqual({ ...COCHANGE_DEFAULTS });
    expect(new CoChangeGraph({ retain: 2, prior: -1, maxFiles: 0 }).params).toEqual({ ...COCHANGE_DEFAULTS });
  });
});
