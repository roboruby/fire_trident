import { afterEach, describe, expect, it, vi } from "vitest";
import type { ColonyEvent, ColonySnapshot, Proposal, RecordedEvent } from "@fire_trident/core";
import { recordColony } from "../../../scripts/record_colony.ts";
import { sceneData } from "../../../scripts/scene_project.ts";
import { loadScenes } from "../src/director/Director.tsx";
import { recipeFills, sceneHref, sceneRun } from "../src/director/recipeScenes.ts";
import script from "../src/director/script.json";
import { RECORDING_FORMAT, RECORDING_VERSION, installRecording, type Recording } from "../src/playback/recording.ts";
import { ReplayBackend } from "../src/replay.ts";
import { ColonyStore } from "../src/store.ts";

/**
 * The director's recipe scenes (script.json "rename" and "smuggle", director/recipeScenes.ts): each opens its own
 * recording, the rename caption counts what the run has shown, and a replay shows the review card of a change that waits
 * for a person (the recorder keeps the review queue).
 */

const T = 1_791_797_000_000;
const sha = (c: string) => c.repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
});

function snapshot(paths: string[]): ColonySnapshot {
  return {
    colony: { id: "c", name: "c", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: sha("1"), createdAt: T, regionDepth: 1 },
    files: paths.map((path) => ({ path, size: 100 })),
    intents: [],
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { proof: 0, reflex: 0, llm: 0, human: 0 },
    metrics: {},
  };
}

describe("the recipe scenes in the director script", () => {
  const scenes = loadScenes(script);
  const at = (id: string) => scenes.findIndex((s) => s.id === id);

  it("come after the existing scenes, each playing its own recording, with a speed and a maxMs", () => {
    expect(scenes.slice(-2).map((s) => s.id)).toEqual(["rename", "smuggle"]);
    expect(at("close")).toBeLessThan(at("rename"));
    for (const id of ["rename", "smuggle"]) {
      expect(scenes[at(id)]).toMatchObject({ recording: id, speed: 4, maxMs: 45_000 });
      // A scene the colony could skip would never open its recording from another run.
      expect(scenes[at(id)]!.requires).toBeUndefined();
    }
    // Every placeholder of the rename scene is one the recipe fills give.
    const rename = scenes[at("rename")]!;
    const keys = Object.keys(recipeFills(new ColonyStore("c")));
    for (const [, k] of `${rename.caption} ${rename.sub}`.matchAll(/\{(\w+)\}/g)) expect(keys).toContain(k);
  });

  it("says how many lines the smuggled change has, as the scene's project makes it: the rename's lines and the one added", () => {
    const data = sceneData();
    const word = new RegExp(`(?<![\\w$])${data.from}(?![\\w$])`);
    const renamed = data.users.reduce((n, path) => n + data.files[path]!.split("\n").filter((l) => word.test(l)).length, 0);
    const smuggle = scenes[at("smuggle")]!;
    expect(smuggle.caption).toBe(`One line hides in an ${(renamed + 1).toLocaleString("en-US")}-line change: everything else is reproduced, and the one line goes to a person.`);
    expect(smuggle.tab).toBe("review");
  });
});

describe("a scene that plays its own recording", () => {
  const rename = { id: "rename", recording: "rename", speed: 4 };

  it("opens it from another run or a live colony, at its speed, keeping the page's delay and debug", () => {
    expect(sceneHref(rename, { pathname: "/c/hono", search: "?director=1&replay=1&recording=hono&speed=2&delay=3" })).toBe("/c/rename?director=1&replay=1&recording=rename&scene=rename&speed=4&delay=3");
    expect(sceneHref(rename, { pathname: "/c/hono", search: "?director=1&debug=1" })).toBe("/c/rename?director=1&replay=1&recording=rename&scene=rename&speed=4&debug=1");
    expect(sceneHref({ id: "smuggle", recording: "smuggle" }, { pathname: "/c/rename", search: "?director=1&replay=1&recording=rename&speed=8" })).toBe("/c/smuggle?director=1&replay=1&recording=smuggle&scene=smuggle&speed=8");
  });

  it("stays on the page that plays it, and a scene with no recording never moves", () => {
    expect(sceneHref(rename, { pathname: "/c/rename", search: "?director=1&replay=1&recording=rename&scene=rename" })).toBeNull();
    expect(sceneHref(rename, { pathname: "/c/anything", search: "?replay=1&director=1&recording=rename" })).toBeNull();
    expect(sceneHref({ id: "map" }, { pathname: "/c/hono", search: "?director=1" })).toBeNull();
  });

  it("keeps only a recording name and a replay speed from the script", () => {
    expect(sceneRun({ recording: "rename", speed: 4 })).toEqual({ recording: "rename", speed: 4 });
    expect(sceneRun({ recording: "../etc", speed: 3 })).toEqual({});
    expect(sceneRun({ recording: 7, speed: "4" })).toEqual({});
  });
});

describe("the rename caption's counts", () => {
  const files = ["src/lib/price.ts", "src/a.ts", "src/b.ts", "src/c.ts", "README.md"];

  function run(events: ColonyEvent[]): ColonyStore {
    const store = new ColonyStore("c");
    store.applySnapshot(snapshot(files));
    store.applyEvents(events);
    return store;
  }

  const seed: ColonyEvent[] = [
    { t: "proposal", at: T + 1, proposalId: "p0", intentId: "i0", agentId: "seed", status: "landed" },
    { t: "landing", at: T + 1, landingId: "l0", trunkSha: sha("2"), proposalIds: ["p0"], paths: files },
    { t: "intent", at: T + 2, intentId: "i1", status: "claimed", title: "Edit a", footprint: ["src/a.ts"] },
    { t: "intent", at: T + 2, intentId: "i2", status: "claimed", title: "Edit b and c", footprint: ["src/b.ts", "src/c.ts"] },
    { t: "intent", at: T + 2, intentId: "i3", status: "claimed", title: "Edit the readme", footprint: ["README.md"] },
    // The recipe's own intent covers a directory, not a file.
    { t: "intent", at: T + 3, intentId: "ir", status: "proposed", title: "Recipe: rename-identifier formatPrice to formatAmount", footprint: ["src"] },
  ];
  const batches: ColonyEvent[] = [
    { t: "landing", at: T + 4, landingId: "lr1", trunkSha: sha("3"), proposalIds: [], paths: ["src/a.ts", "src/b.ts"] },
    { t: "landing", at: T + 5, landingId: "lr2", trunkSha: sha("4"), proposalIds: [], paths: ["src/c.ts", "src/lib/price.ts"] },
  ];

  it("counts nothing before a recipe lands", () => {
    expect(recipeFills(run(seed))).toEqual({ recipeFiles: "0", recipeCommits: "0 commits", recipeHeld: "0", recipeBack: "none goes back", recipeLanded: "0" });
  });

  it("counts the files the recipe's commits rewrote and the agents holding edits on them, then their changes as they land", () => {
    const during = recipeFills(run([...seed, ...batches]));
    expect(during).toEqual({ recipeFiles: "4", recipeCommits: "2 commits", recipeHeld: "2", recipeBack: "none goes back", recipeLanded: "0" });
    const after = recipeFills(
      run([
        ...seed,
        ...batches,
        { t: "proposal", at: T + 6, proposalId: "p1", intentId: "i1", agentId: "a1", status: "landed" },
        { t: "intent", at: T + 6, intentId: "i1", status: "landed", title: "Edit a", footprint: ["src/a.ts"] },
        { t: "landing", at: T + 6, landingId: "l1", trunkSha: sha("5"), proposalIds: ["p1"], paths: ["src/a.ts"] },
        { t: "proposal", at: T + 7, proposalId: "p2", intentId: "i2", agentId: "a2", status: "returned", reason: "stale: src/b.ts" },
        { t: "intent", at: T + 7, intentId: "i2", status: "open", title: "Edit b and c", footprint: ["src/b.ts", "src/c.ts"] },
      ]),
    );
    expect(after).toEqual({ recipeFiles: "4", recipeCommits: "2 commits", recipeHeld: "2", recipeBack: "1 goes back", recipeLanded: "1" });
  });
});

describe("review cards in a replay", () => {
  const card = (id: string): Proposal & { review: unknown } =>
    ({
      id,
      colonyId: "c",
      intentId: `i_${id}`,
      agentId: "a1",
      status: "escalated",
      writeSet: [],
      readSet: [],
      review: { files: [{ path: "src/a.ts", status: "modified", added: 1, removed: 0, hunks: "@@ -1 +1,2 @@\n a\n+fetch(x)" }], reproduction: { recipe: "rename-identifier@1", reproduced: { files: 2, lines: 9 }, residual: { files: 1, lines: 1 }, text: "9 lines reproduced by rename-identifier@1, 1 line to review" } },
    }) as unknown as Proposal & { review: unknown };

  it("shows each card of the recorded queue while the replay shows its change waiting for a person", async () => {
    const events: RecordedEvent[] = [{ t: "proposal", at: T + 1, proposalId: "p1", intentId: "i_p1", agentId: "a1", status: "checking", seq: 1 }];
    const rec: Recording = {
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      colonyId: "c",
      recordedAt: "",
      record: { source: "recorded", total: 1, first: T, last: T, events },
      reads: { "/api/colonies/c/review": [card("p1"), card("p2")] },
      refused: {},
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("the network was used"))));
    const restore = installRecording(rec);
    try {
      const store = new ColonyStore("c");
      store.applySnapshot(snapshot(["src/a.ts"]));
      const backend = new ReplayBackend("c");
      // Before the replay has started there is no run to show cards of.
      expect(await backend.review()).toEqual([]);
      (backend as unknown as { store: ColonyStore }).store = store;
      store.applyEvents([{ t: "proposal", at: T + 1, proposalId: "p1", intentId: "i_p1", agentId: "a1", status: "checking" }]);
      expect(await backend.review()).toEqual([]);
      store.applyEvents([{ t: "proposal", at: T + 2, proposalId: "p1", intentId: "i_p1", agentId: "a1", status: "escalated" }]);
      const shown = await backend.review();
      expect(shown.map((p) => p.id)).toEqual(["p1"]);
      expect((shown[0] as Proposal & { review: { reproduction: { text: string } } }).review.reproduction.text).toBe("9 lines reproduced by rename-identifier@1, 1 line to review");
    } finally {
      restore();
    }
  });

  it("are kept by the recorder: it reads the colony's review queue", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const p = new URL(String(input)).pathname;
      if (p === "/api/colonies/c") return json(snapshot(["src/a.ts"]));
      if (p === "/api/colonies/c/events") return json({ colonyId: "c", source: "recorded", events: [{ t: "colony", at: T, seq: 1 }], next: null, total: 1, first: T, last: T });
      if (p === "/api/colonies/c/review") return json([card("p1")]);
      return json({ error: "not here" }, 404);
    });
    const { recording } = await recordColony({ base: "https://staging.example.test", colonyId: "c", fetch: fetcher as unknown as typeof fetch, retryMs: 0, extraReads: [] });
    expect((recording.reads["/api/colonies/c/review"] as Array<{ id: string }>).map((p) => p.id)).toEqual(["p1"]);
  });
});
