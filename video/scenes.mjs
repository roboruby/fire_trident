// The picture for each narration scene (ids are slugs of the `##` headings in narration.md).
//
// A scene is a list of shots. Each shot starts `at` a phrase of that scene's narration (the
// cut lands just before the phrase is spoken) or at a number of seconds from the scene start,
// and runs until the next shot. Inside a shot, `actions`, `cues`, `beats` and `scroll` keys take
// the same anchors, resolved relative to the shot.
//
// Kinds:
//   page      any URL, recorded frame by frame (director mode, the landing page, the chart page)
//   terminal  video/terminal.html replaying a real transcript from video/transcripts/
//   card      video/cards.html (title, end, queue, nature, stat, pending, stack)
//
// Page options: ready (director | landing | why | complete), prep (keys before the clock
// freezes), skipMs (fast-forward the simulator), actions (keys during the shot), scroll (keys of
// {at, y | to: selector or "text:<heading>", offset, dur}), camera ({on: selector, scale: [a, b]}
// moves in on one element), drift (slow push-in; on by default for production director pages),
// css (extra styles), hideSub (hide the director's sub-caption), badge.
//
// Honesty: simulator footage carries a SIMULATOR badge; production pages a PRODUCTION badge;
// stat cards say MEASURED or SIMULATED and name the result file the numbers come from. Other git
// hosts are never named on screen: the import transcript elides the source host, and the
// bring-your-own-agent shot frames only the MCP column of the landing page.

export const PROD = "https://firetrident.mattsolt.workers.dev";
const BENCH = "/bench/2026-10-12/index.html";

/** The in-browser simulator in director mode (80 agents, fixed seed). */
const sim = (scene, extra = {}) => `${PROD}/c/demo?${new URLSearchParams({ mock: "1", director: "1", agents: "80", seed: "7", ...extra, scene })}`;
/** A production colony in director mode. */
const dir = (colony, scene) => `${PROD}/c/${colony}?director=1&scene=${scene}`;

const SIMULATOR = { kind: "sim", text: "Simulator · in-browser simulation, not a live run" };
const prod = (what) => ({ kind: "prod", text: `Production · ${what}` });

export const VOICE = "electra";
export const FPS = 30;
/** Seconds of air before the first paragraph, between paragraphs, and after the last. */
export const PACE = { lead: 0.55, gap: 0.5, tail: 0.85, cutLead: 0.22, fade: 0.28 };

/** Cards outside the narration. */
export const OPENING = { kind: "card", card: "title", dur: 3.4 };

export const SCENES = {
  "cold-open": {
    shots: [
      { at: 0, kind: "page", url: sim("converge", { speed: "2" }), prep: [{ key: "c" }], skipMs: 9000, badge: SIMULATOR },
      { at: "This is FireTrident", kind: "page", url: `${PROD}/`, ready: "landing" },
    ],
  },

  "the-problem": {
    shots: [
      { at: 0, kind: "card", card: "queue", beats: [0, "Agents can propose", "Put a thousand", "takes a branch", "opens a pull request", "waits for review", "lines up in a merge queue"] },
      { at: "Nature solved this", kind: "card", card: "nature", beats: ["An ant colony", "A slime mold", "Your immune system", "None of them use a queue", "signals left in the environment", "they decide locally", "they work in parallel"] },
      { at: "FireTrident brings those ideas", kind: "card", card: "queue", mode: "compare", beats: [0.5, "Sense, decide", "decide, land", "land, remember", "remember."] },
    ],
  },

  "import-and-declare": {
    shots: [
      { at: 0, kind: "terminal", t: "hono-import", cues: [0.3] },
      { at: "Every tile on this map", kind: "page", url: dir("hono", "map"), badge: prod("finished run on honojs/hono, 2026-10-12") },
      { at: "One rule", kind: "terminal", t: "hono-rule", cues: [0.2], maxType: 3.6, mark: ["958 violations → 282 intents in the field"] },
    ],
  },

  sense: {
    shots: [
      { at: 0, kind: "page", url: sim("sense"), skipMs: 14000, badge: SIMULATOR, actions: [{ at: "When an agent claims", key: "z" }] },
      {
        at: "But the claim decays",
        kind: "card",
        card: "stat",
        kicker: "Sense · a claim is not a lock",
        title: "The claim decays. Nothing to unlock, nothing to deadlock.",
        items: [
          { value: "20<small>/20</small>", label: "rounds a second agent was turned away", sub: "while the first agent's claim was fresh" },
          { value: "218<small> s</small>", label: "until it took the work", sub: "after the first agent went silent; the claim's half-life is 208 s", tone: "green" },
        ],
        beats: [0.6, "If an agent goes quiet"],
        tag: { kind: "measured", text: "Measured · preview deployment, 2026-10-12" },
        source: "packages/bench/results/2026-10-12-inhibition/summary.json",
      },
      {
        at: "The colony also learns",
        kind: "card",
        card: "stat",
        kicker: "Sense · co-change",
        title: "Files that changed together push agents apart.",
        items: [
          { value: "53%", label: "of next co-changes predicted by a file's top neighbor", sub: "on hono's real history (13% for the most-changed file)" },
          { value: "18<small>/20</small>", label: "rounds an agent steered away from coupled work", sub: "with the co-change map, live on a preview (4 of 20 without it)", tone: "green" },
        ],
        beats: [0.6, "so two agents"],
        tag: { kind: "measured", text: "Measured · hono history and a preview deployment" },
        source: "packages/bench/results/2026-10-12-cochange/summary.json",
      },
    ],
  },

  land: {
    shots: [
      { at: 0, kind: "page", url: sim("land"), skipMs: 16000, badge: SIMULATOR, hideSub: true },
      { at: "The writer lands them", kind: "terminal", t: "git-land", cues: [0.3] },
      { at: "Sometimes one change", kind: "page", url: BENCH, local: true, ready: "complete", scroll: { keys: [{ at: 0, to: "text:The seizure detector", offset: -70 }, { at: "When that number climbs", to: "text:The seizure detector", offset: 60, dur: 2.4 }] } },
    ],
  },

  decide: {
    shots: [
      { at: 0, kind: "terminal", t: "why", cues: [0.3], mark: ["deterministic: imports resolve", "deterministic: mechanical proof"] },
      { at: "When proof", kind: "page", url: dir("openspec-w1", "decide"), badge: prod("OpenSpec run, 2026-10-12") },
      { at: "When a person rejects", kind: "page", url: dir("openspec-w1", "review"), badge: prod("OpenSpec run, 2026-10-12"), actions: [{ at: "And the immune system", key: "ArrowRight" }] },
    ],
  },

  remember: {
    shots: [
      { at: 0, kind: "page", url: `${PROD}/c/hono?path=src/index.ts`, ready: "why", badge: { ...prod("hono run, 2026-10-12"), pos: "tc" }, scroll: { el: "auto:.side", keys: [{ at: 0, y: 0 }, { at: 2.2, y: 260, dur: 2.5 }] } },
      { at: "carries trailers", kind: "terminal", t: "git-notes", cues: [0.2, "the agent and its model"], maxType: 2.6 },
    ],
  },

  "change-direction": {
    shots: [
      {
        at: 0,
        kind: "card",
        card: "pending",
        kicker: "Change direction",
        title: "People change their minds mid-flight.",
        lines: ["A person amends an intent while agents work on it", "Agents holding it get the new direction on their next heartbeat", "Work built on the old version goes back", "The lineage records revision two"],
        beats: ["Here a person amends", "The agents holding it", "work built on the old", "the lineage records"],
        pending: "Footage pending · direction stream",
        source: "Rough cut placeholder: replace with a recording of an intent amended mid-run.",
      },
    ],
  },

  "a-new-project": {
    shots: [
      { at: 0, kind: "terminal", t: "shortlinks-new", cues: [0.3, "Agents wait for"], blockLps: [30, 3.2] },
      { at: "and the colony converges", kind: "page", url: dir("shortlinks", "map"), badge: prod("grown from a spec, 2026-10-12") },
      { at: "Clone the result", kind: "terminal", t: "shortlinks-test", lps: 6, mark: ["node --test: 60 tests, 60 pass, 0 fail", "reference acceptance: 7/7 pass"] },
    ],
  },

  "bring-your-own-agent": {
    shots: [
      { at: 0, kind: "page", url: `${PROD}/`, ready: "landing", css: ".run-grid > .run-col:first-child,.l-foot,#run .l-section-head{visibility:hidden}", scroll: { el: ".landing", keys: [{ at: 0, to: "#run", offset: -40 }] }, camera: { on: ".run-grid > .run-col:last-child", scale: [1.8, 1.9], move: 1.8 } },
      {
        at: "Here Claude Code joins",
        kind: "card",
        card: "pending",
        kicker: "Bring your own agent",
        title: "Claude Code joins a colony over MCP.",
        lines: ["Takes work from the field", "Pushes with plain git", "Is reviewed like every other agent"],
        beats: [0.5, 1.1, 1.7],
        pending: "Footage pending · MCP stream",
        source: "Rough cut placeholder: replace with Claude Code joining a colony and landing a change.",
      },
    ],
  },

  scale: {
    shots: [
      { at: 0, kind: "page", url: BENCH, local: true, ready: "complete", scroll: { keys: [{ at: 0, y: 0 }, { at: "In simulation", to: "text:Throughput on the live workload", offset: 200, dur: 1.6 }] } },
      {
        at: "Optimism has a cost",
        kind: "card",
        card: "stat",
        kicker: "Scale · the cost of optimism",
        title: "Agents redo some work when trunk moves under them.",
        items: [
          { value: "42.5%<span class='to'>→</span>31.2%", label: "rework with inhibition and co-change learning", sub: "1,000 agents on hono's history; 85.6 → 86.4 landed per minute", tone: "accent" },
          { value: "21.7%", label: "rework with file locks and one merge queue", sub: "the same workload at 51.9 landed per minute", tone: "blue" },
        ],
        beats: [0.6, "cut that rework"],
        tag: { kind: "simulated", text: "Simulated · calibrated on live runs, mean of 3 seeds" },
        source: "packages/bench/results/2026-10-12-inhibition/summary.json",
      },
    ],
  },

  close: {
    tail: 3.6,
    shots: [
      {
        at: 0,
        kind: "card",
        card: "stack",
        title: "FireTrident runs entirely on Cloudflare.",
        rows: [
          { name: "Artifacts", text: "holds every repository <span>· trunk, agent workspaces, git notes</span>" },
          { name: "Durable Objects", text: "run the colony, its regions, the trunk writer <span>and every agent</span>" },
          { name: "Workers AI", text: "powers the reflexes <span>and the agents</span>" },
          { name: "Open source", text: "MIT license" },
        ],
        beats: ["Artifacts holds", "Durable Objects run", "Workers AI powers", "open source"],
      },
      { at: "A colony, not a queue.", kind: "card", card: "end" },
    ],
  },
};
