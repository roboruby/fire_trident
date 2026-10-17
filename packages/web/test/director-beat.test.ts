import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { BEAT_MAX_MS, beatLimit, beatWaits, moveOnLine, watchBeat } from "../src/director/beat.ts";
import { loadScenes, probeBeat, type Awaiting, type Scene } from "../src/director/Director.tsx";
import script from "../src/director/script.json";
import { ColonyStore } from "../src/store.ts";

/** The hard timeout per beat: a scene still waiting for what it shows when its limit runs out moves on by itself. */

const T = 1_791_797_000_000;
const sha = (c: string) => c.repeat(40);

function colony(): ColonyStore {
  const store = new ColonyStore("c");
  const snap: ColonySnapshot = {
    colony: { id: "c", name: "c", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: sha("1"), createdAt: T, regionDepth: 1 },
    files: [
      { path: "src/a.ts", size: 100 },
      { path: "src/b.ts", size: 200 },
    ],
    intents: [],
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { proof: 0, reflex: 0, llm: 0, human: 0 },
    metrics: {},
  };
  store.applySnapshot(snap);
  return store;
}

const fresh = (select: boolean, focus: string | string[] | null = null): Awaiting => ({ select, focus, insets: { top: 0, left: 0, right: 0, bottom: 0 }, appliedAt: Date.now() });

/** The director's beat on `scene`, as Director.tsx runs it: probeBeat every poll, moving on through `moveOn`. */
function runBeat(scene: Scene, store: ColonyStore, w: Awaiting, moveOn: (waits: string[]) => void) {
  const from = Date.now();
  return watchBeat({ from, limitMs: beatLimit(scene), now: () => Date.now(), probe: () => probeBeat(scene, store, w, null, false, Date.now()), onExpire: moveOn });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a beat's limit", () => {
  it("is the scene's maxMs, else the default, and the shipped script parses with it", () => {
    expect(beatLimit({})).toBe(BEAT_MAX_MS);
    expect(beatLimit({ maxMs: 5_000 })).toBe(5_000);
    expect(beatLimit({ maxMs: -1 })).toBe(BEAT_MAX_MS);
    const scenes = loadScenes({ scenes: [{ id: "a", caption: "A", maxMs: 8_000 }, { id: "b", caption: "B", maxMs: "soon" }, { id: "c", caption: "C", maxMs: 0 }] });
    expect(scenes.map((s) => s.maxMs)).toEqual([8_000, undefined, undefined]);
    expect(loadScenes(script).length).toBe(script.scenes.length);
  });

  it("says what a beat waits for in plain words", () => {
    expect(beatWaits({})).toEqual([]);
    expect(beatWaits({ requires: "landing", select: ["@landing", "@hot"], focus: ["@selected"], reading: true })).toEqual([
      "the colony has no landing yet",
      "no file to select yet (@landing, @hot)",
      "the camera's target is not on the map yet (@selected)",
      "the Why tab's read has not answered",
    ]);
    expect(moveOnLine(10, 14, "why", 30_000, ["the colony has no landing yet"])).toBe(
      'Director: scene 11/14 "why" waited 30 s and moved on: the colony has no landing yet. Space holds a beat; → moves on by hand.',
    );
  });
});

describe("the director's hard timeout per beat (fake timers)", () => {
  it("moves on when a scene's wait never resolves: the why scene with no landing to appear", () => {
    const why = loadScenes(script).find((s) => s.id === "why");
    expect(why).toBeDefined();
    const store = colony();
    const moved = vi.fn();
    runBeat(why as Scene, store, fresh(true), moved);
    vi.advanceTimersByTime(BEAT_MAX_MS - 500);
    expect(moved).not.toHaveBeenCalled();
    vi.advanceTimersByTime(750);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(moved.mock.calls[0]?.[0]).toEqual(["the colony has no landing yet", "no file to select yet (@landing, @hot)"]);
    vi.advanceTimersByTime(10 * BEAT_MAX_MS);
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it("uses a scene's own maxMs, and counts a camera target that never reaches the map", () => {
    const [scene] = loadScenes({ scenes: [{ id: "sense", caption: "Sense", focus: ["@hot"], maxMs: 4_000 }] });
    const moved = vi.fn();
    runBeat(scene as Scene, colony(), fresh(false, ["@hot"]), moved);
    vi.advanceTimersByTime(3_750);
    expect(moved).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(moved).toHaveBeenCalledWith(["the camera's target is not on the map yet (@hot)"]);
  });

  it("selects the landing once it appears and then holds for the presenter", () => {
    const [scene] = loadScenes({ scenes: [{ id: "why", caption: "Why", tab: "why", select: ["@landing"], requires: "landing", maxMs: 5_000 }] });
    const store = colony();
    const moved = vi.fn();
    runBeat(scene as Scene, store, fresh(true), moved);
    vi.advanceTimersByTime(2_000);
    store.applyEvents([{ t: "landing", at: T + 2_000, landingId: "l1", trunkSha: sha("2"), proposalIds: ["p1"], paths: ["src/b.ts"] }]);
    vi.advanceTimersByTime(300);
    expect(store.selectedPath).toBe("src/b.ts");
    vi.advanceTimersByTime(60_000);
    expect(moved).not.toHaveBeenCalled();
  });

  it("never moves a beat that waits for nothing, or one that was held or left", () => {
    const [plain, waiting] = loadScenes({ scenes: [{ id: "map", caption: "Map", focus: null }, { id: "why", caption: "Why", select: ["@landing"], maxMs: 1_000 }] });
    const moved = vi.fn();
    runBeat(plain as Scene, colony(), fresh(false), moved);
    const stop = runBeat(waiting as Scene, colony(), fresh(true), moved);
    vi.advanceTimersByTime(500);
    stop();
    vi.advanceTimersByTime(5 * BEAT_MAX_MS);
    expect(moved).not.toHaveBeenCalled();
  });

  it("counts from when the beat began, so a held beat resumes with the time it had left", () => {
    const moved = vi.fn();
    // Held 20 s into a 30 s beat for a minute: resumed, its clock starts 20 s in (Director moves `from` later by the hold).
    const resumedAt = Date.now();
    watchBeat({ from: resumedAt - 20_000, limitMs: 30_000, now: () => Date.now(), probe: () => ["no file to select yet (@landing)"], onExpire: moved });
    vi.advanceTimersByTime(9_750);
    expect(moved).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it("skips the title cards: a title waits for nothing", () => {
    const open = loadScenes(script).find((s) => s.title);
    expect(probeBeat(open as Scene, colony(), fresh(true, ["@hot"]), null, true, Date.now())).toEqual([]);
  });
});
