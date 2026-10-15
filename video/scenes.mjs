// The picture for each narration scene (ids are slugs of the `##` headings in narration.md).
//
// A scene is a list of shots. Each shot starts `at` a phrase of that scene's narration (the
// cut lands just before the phrase is spoken), at a number of seconds from the scene start, or at
// a paragraph mark ("@start:2", "@end:2+0.4": when paragraph 2 starts or ends, plus an offset),
// and runs until the next shot. Inside a shot, `actions`, `cues`, `beats` and `scroll` keys take
// the same anchors, resolved relative to the shot. A scene's `gaps` ({2: 4.5}) holds a longer
// pause after a paragraph, and `tail` the air after the last one.
//
// Kinds:
//   page      any URL, recorded frame by frame (director mode, the landing page, the chart page)
//   terminal  video/terminal.html replaying a real transcript from video/transcripts/
//   card      video/cards.html (title, end, queue, nature, stat, stack)
//   clip      a shot recorded ahead of the cut ($FT_VIDEO_OUT/<file>, from `from` seconds), for a
//             live state that does not last (an escalation waiting for a person)
//
// Page options: ready (director | landing | why | complete), prep (keys, js or a wait before the
// clock freezes), skipMs (fast-forward the simulator), actions (keys or js during the shot), scroll
// (keys of {at, y | to: selector, "text:<heading>" or "match:<selector>|<text>", offset, dur}),
// camera ({on: selector, scale: [a, b], move, delay} moves in on one element; alignRight keeps the
// side panel whole and y sets the page height at the middle of the frame), drift (the slow push-in
// every still picture gets by default, see driftOf in render.mjs), css (extra styles), hideSub
// (hide the director's sub-caption), badge, timeScale (a time-lapse: virtual time per frame in
// frame lengths).
//
// Replays (rep()): a finished run played from its record. render.mjs holds the replay while the page
// loads, pauses it, and resumes it on the shot's first frame. `sync: {at, run, offset}` puts the
// run's moment `run` (seconds after its first event) on screen when the phrase `at` is spoken (plus
// `offset` seconds) by choosing ?t=; actions can be timed to the run with {atRun}.
//
// Honesty: simulator footage carries a SIMULATOR badge; production pages a PRODUCTION badge that
// says replay or live, reconstructed (claim times estimated) or recorded, the speed, and who took a
// scripted action; stat cards say MEASURED or SIMULATED and name the result file the numbers come
// from. Other git hosts are never named on screen: the import transcript elides the source host,
// and the landing page's run section shows only its MCP column.

export const PROD = "https://firetrident.mattsolt.workers.dev";
const BENCH = "/bench/2026-10-12/index.html";

/** A production colony in director mode (its finished state, live). */
const dir = (colony, scene, extra = "") => `${PROD}/c/${colony}?director=1&scene=${scene}${extra}`;
/** A production colony's replay in director mode; render.mjs adds ?t= from the shot's `sync`. */
const rep = (colony, scene, { speed = 1, debug = false } = {}) => `${PROD}/c/${colony}?replay=1&director=1&scene=${scene}&speed=${speed}${debug ? "&debug=1" : ""}`;

const prod = (what) => ({ kind: "prod", text: `Production · ${what}` });
/** The badge on a replay: which run, when, and how it is shown. */
const replayOf = (what, ...how) => prod([`replay of ${what}, 2026-10-12`, ...how].join(" · "));
const HONO = (...how) => replayOf("the hono run", "reconstructed", ...how);
/** debug=1 exposes the store (window.ftStore) for selecting a file; its perf readout stays hidden. */
const DEBUG_CSS = ".perf{display:none!important}";
const select = (path) => `window.ftStore && window.ftStore.select(${JSON.stringify(path)})`;
/** The director's sub-caption stays hidden until SHOW_SUB runs (before then it would state what has not happened yet). */
const SUB_LATER = ".dir-sub{opacity:0!important}html.ftv-sub .dir-sub{opacity:1!important;transition:opacity .5s}";
const SHOW_SUB = 'document.documentElement.classList.add("ftv-sub")';
/** Certification shots frame the trunk bar's head (its test badge) and the events panel: right edge kept, 1.32x. */
const CERT_CAMERA = { on: ".side", scale: [1.32, 1.345], move: 0.001, alignRight: true, y: 500 };
const tab = (name) => `[...document.querySelectorAll('.side .tab')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(name)}))?.click()`;

export const VOICE = "electra";
export const FPS = 30;
/** Seconds of air before the first paragraph, between paragraphs, and after the last. */
export const PACE = { lead: 0.6, gap: 0.65, tail: 1.1, cutLead: 0.22, fade: 0.28 };

/** Cards outside the narration. */
export const OPENING = { kind: "card", card: "title", dur: 3.4 };

/**
 * Shots recorded ahead of the cut with `node video/precapture.mjs <name>`, used as `clip` shots.
 * decide-review-live was recorded on 2026-10-12 at about 20:21 EDT, while the escalated route waited
 * for a person; once it was approved the review queue emptied, so it cannot be recorded again.
 */
export const PRECAPTURES = {
  "decide-review-live": {
    url: `${PROD}/c/shortlinks-review?director=1&scene=review`,
    waitFor: "!!document.querySelector('.side .card .pill-escalated')",
    prep: [{ key: "c" }],
    seconds: 32,
    camera: { on: ".side .card", scale: [1.3, 1.345], move: 2.2, delay: 1.4, alignRight: true, margin: -12 },
    badge: { kind: "prod", text: "Production · shortlinks-review, live view, 2026-10-12 · waiting for a person" },
  },
};

// Moments of the production runs, in seconds after each run's first event (GET /api/colonies/:id/events).
const RUN = {
  hono: { rule: 21.0, swarm: 24.6, claims: 25.62, mid: 36.0, converged: 82.8 },
  retract: { retracted: 23.69 },
  steer: { amended: 5.12, directive: 6.04 },
  byo: { joined: 7.33, landed: 39.04 },
  review: { approved: 1243.61 },
  // shortlinks-review's trunk certification: red (5 of 67 failing) and, 67 minutes later, the fix landing and certifying green.
  certify: { red: 8769.74, fixed: 12789.04 },
};

export const SCENES = {
  "cold-open": {
    shots: [
      // 80 agents converge on the 958 violations (the run's own clock at 4x); captions off, the hero counter tells it.
      { at: 0, kind: "page", url: rep("hono", "converge", { speed: 4 }), sync: { at: 0, run: RUN.hono.rule + 0.3 }, prep: [{ key: "c" }], badge: HONO("4× speed") },
      // The landing page; its hero colony is the in-browser simulator (the page labels it too).
      { at: "This is FireTrident", kind: "page", url: `${PROD}/`, ready: "landing", badge: { kind: "sim", text: "Simulator · the landing page's hero colony runs in the browser" } },
    ],
  },

  "the-problem": {
    shots: [
      { at: 0, kind: "card", card: "queue", beats: [0, "Agents can propose", "Put a thousand", "takes a branch", "opens a pull request", "waits for review", "lines up in a merge queue"] },
      { at: "Nature solved this", kind: "card", card: "nature", systems: ["ants", "immune"], beats: [0.25, "Your immune system", "Neither uses a queue", "signals left in the environment", "they decide locally", "they work in parallel"] },
      { at: "FireTrident brings those ideas", kind: "card", card: "queue", mode: "compare", beats: [0.5, "Sense, decide", "decide, land", "land, remember", "remember."] },
    ],
  },

  "import-and-declare": {
    shots: [
      { at: 0, kind: "terminal", t: "hono-import", cues: [0.3] },
      // The map before the rule: one agent on the prerequisite, every tile a file.
      { at: "Every tile on this map", kind: "page", url: rep("hono", "map"), sync: { at: 0, run: 2.0 }, badge: HONO() },
      { at: "One rule", kind: "terminal", t: "hono-rule", cues: [0.2], maxType: 3.6, mark: ["958 violations → 282 intents in the field"] },
      // The rule lands in the field: 958 needs light up just after the cut.
      { at: "958 of them", kind: "page", url: rep("hono", "rule"), sync: { at: 0, run: RUN.hono.rule, offset: 0.35 }, badge: HONO() },
    ],
  },

  sense: {
    shots: [
      // Early in the run: needs, then claims, then the first trails. Whole map first; at "When an agent claims" the camera moves in on the hottest region.
      { at: 0, kind: "page", url: rep("hono", "sense"), sync: { at: 0, run: RUN.hono.swarm }, prep: [{ key: "z", wait: 2000 }], css: SUB_LATER, actions: [{ atRun: RUN.hono.claims + 0.3, js: SHOW_SUB }, { at: "When an agent claims", key: "z" }], badge: HONO() },
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
      // Mid-run: landings spark into trunk. The director's sub-caption (a stale read goes back "with the exact delta")
      // claims more than a return carries, the files that changed with their versions, so it stays hidden.
      { at: 0, kind: "page", url: rep("hono", "land"), sync: { at: 0, run: RUN.hono.mid }, hideSub: true, badge: HONO() },
      { at: "The writer lands every", kind: "terminal", t: "git-land", cues: [0.3] },
      {
        at: "Some of those returns",
        kind: "card",
        card: "stat",
        kicker: "Land · fewer returns",
        title: "Not every stale change has to go back.",
        items: [
          { value: "2<small>/2</small>", label: "edits to lines 2 and 11 of one file landed", sub: "with text merge, the second as a line-by-line merge holding both; with it off, the second went back" },
          { value: "30<small>/30</small>", label: "changes landed on their first proposal", sub: "after a shared hono file changed under them, with import-name revalidation; with it off, 30 of 30 went back", tone: "green" },
        ],
        beats: [0.6, "a change that is stale only"],
        tag: { kind: "measured", text: "Measured · preview deployments, 2026-10-13 and 2026-10-14 (revalidation is off in production)" },
        source: "packages/bench/results/2026-10-14-round5/ · 2026-10-13-round2/",
      },
      { at: "Sometimes one change", kind: "page", url: BENCH, local: true, ready: "complete", scroll: { keys: [{ at: 0, to: "text:The seizure detector", offset: -70 }, { at: "When that number climbs", to: "text:The seizure detector", offset: 60, dur: 2.4 }] } },
    ],
  },

  decide: {
    // After "...what it did not verify", a held moment: the person approves, it lands, and the lineage keeps the approval.
    gaps: { 2: 7.4 },
    shots: [
      { at: 0, kind: "terminal", t: "why", cues: [0.3], mark: ["deterministic: imports resolve", "deterministic: mechanical proof"] },
      // The finished hono run: the reflex arc's proof stage settled 282 (the rule's edits), a model 2 (the prerequisite and the follow-up).
      { at: "All 282", kind: "page", url: dir("hono", "decide"), badge: prod("hono run, 2026-10-12, finished") },
      { at: "When proof", kind: "page", url: dir("openspec-w1", "decide"), badge: prod("OpenSpec run, 2026-10-12") },
      // Recorded live while the escalation waited (tools: precapture of /c/shortlinks-review?director=1&scene=review, captions off, badge burned in).
      { at: "Some changes never land", kind: "clip", file: "precapture/decide-review-live.mp4", from: 0, badge: prod("shortlinks-review, live view, 2026-10-12 · waiting for a person") },
      // Matt approved it in the review tab (20:33:07 EDT); the record replays the approval and the landing 1.7 s later.
      {
        at: "@end:2+0.3",
        kind: "page",
        url: rep("shortlinks-review", "review"),
        sync: { at: "@end:2+0.3", run: RUN.review.approved, offset: 0.8 },
        prep: [{ key: "c" }, { key: "z" }, { js: tab("Events"), wait: 1200 }],
        camera: { on: ".side", scale: [1.32, 1.34], move: 0.001, alignRight: true, y: 534 },
        badge: replayOf("shortlinks-review", "recorded", "approved by a person"),
      },
      // The lineage of the landed file keeps the person's decision and reason.
      {
        at: "@end:2+4.1",
        kind: "page",
        url: dir("shortlinks-review", "why", "&debug=1"),
        css: DEBUG_CSS,
        prep: [{ key: "c" }, { js: select("src/routes/links.ts"), wait: 3000 }],
        scroll: { el: "auto:.side", keys: [{ at: 0, to: "match:.side .lin-k|Direction", offset: -60 }] },
        camera: { on: ".side", scale: [1.32, 1.35], move: 0.001, alignRight: true, y: 430 },
        badge: prod("shortlinks-review, 2026-10-12, finished · approved by ms"),
      },
      // The director's sub-caption calls the vaccination result recall; it measures routing (7 returned, 21 sent to a person), so it stays hidden.
      { at: "When a person rejects", kind: "page", url: dir("openspec-w1", "review"), hideSub: true, badge: prod("OpenSpec run, 2026-10-12"), actions: [{ at: "And the immune system", key: "ArrowRight" }] },
    ],
  },

  remember: {
    // The clone's output gets the moment it had as the scene's tail, before the sealed and signed notes.
    gaps: { 1: 2.6 },
    tail: 2.6,
    shots: [
      { at: 0, kind: "page", url: `${PROD}/c/hono?path=src/index.ts`, ready: "why", badge: { ...prod("hono run, 2026-10-12"), pos: "tc" }, scroll: { el: "auto:.side", keys: [{ at: 0, y: 0 }, { at: 2.2, y: 260, dur: 2.5 }] } },
      { at: "carries trailers", kind: "terminal", t: "git-notes", cues: [0.2, "the agent and its model"], maxType: 2.6 },
      // A plain clone of the production trunk, no account: the full output of `git log --notes=firetrident -3` scrolls by and ends on a note's intent, rule, model and files.
      { at: "It's plain git", kind: "terminal", t: "git-clone", cues: [0.15, "with any git client"], maxType: 1.1, blockLps: [10, 10, 200], mark: ['"ruleId": "rul_mv51663hu2jmz8"', '"model": "@cf/google/gemma-4-26b-a4b-it"'] },
      // A stock clone of the production signed-notes trunk (2026-10-15): the commit's FT-Note trailer seals its note, and the published key names the signer.
      { at: "Every note is also sealed", kind: "terminal", t: "verify-signed", cues: [0.15, "On a stock clone"], maxType: 1.4, mark: ["FT-Note: sha256:c8346183b984cc374baa7b1f2a49a0346b0947241e107decaeb40ce00cb65f3c", "intact, signed by 7980151ea697807b"] },
    ],
  },

  "change-direction": {
    shots: [
      // hexojs/hexo: the rule is retracted mid-run; its needs leave the map and the events tab fills with withdrawals.
      { at: 0, kind: "page", url: rep("direction-retract", "direction"), sync: { at: "In under a second", run: RUN.retract.retracted, offset: -0.35 }, css: SUB_LATER, actions: [{ atRun: RUN.retract.retracted + 0.2, js: SHOW_SUB }], badge: replayOf("direction-retract", "retraction by operator-script") },
      // An intent amended while its agent works on it (4x): r2, the restart, and the r2 change landing.
      { at: "Here a person amends", kind: "page", url: rep("direction-steer", "direction", { speed: 4 }), sync: { at: "amends an intent", run: RUN.steer.amended, offset: 0.2 }, css: SUB_LATER, actions: [{ atRun: RUN.steer.directive + 0.3, js: SHOW_SUB }], badge: replayOf("direction-steer", "actions by operator-script", "4× speed") },
      // A directive to the other agent (1x): its change in flight goes back, it re-plans and commits again.
      { at: "A person can also send", kind: "page", url: rep("direction-steer", "direction"), sync: { at: "send one agent a note", run: RUN.steer.directive, offset: 0.1 }, css: SUB_LATER, actions: [{ atRun: RUN.steer.directive + 0.3, js: SHOW_SUB }], badge: replayOf("direction-steer", "actions by operator-script") },
      // The finished colony's lineage: the r2 revision, then the directive.
      { at: "The lineage records", kind: "page", url: dir("direction-steer", "why", "&debug=1"), css: DEBUG_CSS, drift: 0.02, prep: [{ js: select("src/greeting.ts"), wait: 1500 }], actions: [{ at: "and every note", js: select("src/farewell.ts") }], badge: prod("direction-steer, 2026-10-12, finished") },
    ],
  },

  "a-new-project": {
    gaps: { 1: 3.2 },
    tail: 1.8,
    shots: [
      { at: 0, kind: "terminal", t: "shortlinks-new", blocks: 1, cues: [0.3], blockLps: [9], mark: ["5 rules and 13 intents painted into the field"] },
      // The run's 8 minutes as a time-lapse (16x replay, 3x time-lapse; the replay also skips idle minutes): files appear as they land.
      { at: "Agents wait for", kind: "page", url: rep("shortlinks", "map", { speed: 16 }), timeScale: 3, sync: { at: 0, run: 0 }, badge: replayOf("the shortlinks run", "reconstructed", "time-lapse of 8 minutes") },
      { at: "Eight minutes later", kind: "terminal", t: "shortlinks-test", lps: 6, mark: ["node --test: 60 tests, 60 pass, 0 fail", "reference acceptance: 7/7 pass"] },
      // Trunk certification (shipped to production on 2026-10-12): how it runs, then the second run of the spec going red and, 67 minutes of model work later, green.
      {
        at: "The colony also checks",
        kind: "card",
        card: "stack",
        kicker: "Certification",
        title: "The colony checks its own work.",
        top: 430,
        rows: [
          { name: "Dynamic Worker", text: "runs the project's own node:test files <span>on trunk, after changes land</span>" },
          { name: "Sealed off", text: "no network <span>(globalOutbound: null)</span>, CPU and time limits" },
        ],
        beats: ["it runs the project's tests", "sealed off from the network"],
      },
      // 22:38:33 EDT: red, 5 of 67 failing in 267 ms; the repair intent and its needs on the map appear the same instant. (The badge's
      // popover with the failing tests opens behind the director's side panel, so it stays closed.)
      {
        at: "A second run of this spec",
        kind: "page",
        url: rep("shortlinks-review", "review"),
        sync: { at: "five tests failing", run: RUN.certify.red, offset: -0.5 },
        prep: [{ key: "c" }, { key: "z" }, { js: tab("Events"), wait: 1200 }],
        camera: CERT_CAMERA,
        badge: { ...replayOf("shortlinks-review", "recorded"), note: "An operator started this certification at 22:38 (ft certify --now). The repair intent is the colony's own." },
      },
      // 23:45:33 EDT: the second fix lands (router.ts only) and certifies green, 67 of 67; the list below holds the first fix and the returned attempt.
      {
        at: "Agents landed two fixes",
        kind: "page",
        url: rep("shortlinks-review", "review"),
        sync: { at: "and trunk went green", run: RUN.certify.fixed, offset: -1.0 },
        prep: [{ key: "c" }, { key: "z" }, { js: tab("Events"), wait: 1200 }],
        camera: CERT_CAMERA,
        badge: { ...replayOf("shortlinks-review", "recorded", "67 minutes later"), note: "An operator started the two agents at 22:38. The fixes, the returned attempt and the green run are the colony's." },
      },
    ],
  },

  "bring-your-own-agent": {
    tail: 4.6,
    shots: [
      // The real session: the agent joins over MCP, takes an intent, clones, edits, pushes with git, proposes, and hears it landed.
      { at: 0, kind: "terminal", t: "byo-session", cues: [0.25], maxType: 1.6, blockLps: [5.2], mark: ["mcp:join", "mcp:take", "HEAD -> main", '"status": "landed"'] },
      // byo-demo at 4x: the outside agent claims benchmark.js beside the synthetic in-platform agent and lands; then its lineage.
      {
        at: "Here Claude Code joins",
        kind: "page",
        url: rep("byo-demo", "mcp", { speed: 4, debug: true }),
        sync: { at: "joins a colony", run: RUN.byo.joined },
        css: DEBUG_CSS + SUB_LATER,
        actions: [{ atRun: RUN.byo.landed, lag: 0.4, js: `${select("benchmark.js")};${SHOW_SUB}` }],
        badge: replayOf("byo-demo", "reconstructed", "4× speed"),
      },
    ],
  },

  scale: {
    shots: [
      {
        at: 0,
        kind: "card",
        card: "stat",
        kicker: "Scale · synthetic agents, one repository",
        title: "No model calls: the coordination layer alone.",
        items: [
          { value: "6,606", label: "changes landed in 145 s on the live service", sub: "2,000 synthetic agents, 1,350 trunk commits, 0 returned; time to land p50 9.6 s, p95 15.2 s" },
          { value: "2,730<small>/min</small>", label: "landed a minute on the live service", sub: "each change adds one new file, so none can conflict", tone: "green" },
          { value: "5,000", label: "agents started at once on a preview", sub: "2,778 landed a minute (2026-10-12)", tone: "accent" },
        ],
        beats: [0.6, "and none went back", "five thousand started"],
        tag: { kind: "measured", text: "Measured · live service, 2026-10-14; preview deployment, 2026-10-12" },
        source: "packages/bench/results/2026-10-14-round8/scale-production.json · 2026-10-12-scale/",
      },
      {
        at: "With model-driven agents",
        kind: "card",
        card: "stat",
        kicker: "Scale · model-driven agents on the hono rule",
        title: "958 problems to zero, with every intent landed.",
        items: [
          { value: "188<small> s</small>", label: "10 agents", sub: "on a preview; 283 of 283 intents landed, 0 returned" },
          { value: "56<small> s</small>", label: "80 agents", sub: "on a preview; 20 and 40 agents took 118 s and 77 s", tone: "green" },
          { value: "$0.065", label: "model calls for the 80-agent run on the live service", sub: "Workers AI list prices, from the tokens the colony counted", tone: "accent" },
        ],
        beats: [0.6, "in under one with eighty", "Counted at Workers AI"],
        tag: { kind: "measured", text: "Measured · preview deployment, 2026-10-14 (Gemma agents); live service, 2026-10-12" },
        source: "packages/bench/results/2026-10-14-round6/sweep/ · 2026-10-12-prod/",
      },
      {
        at: "Optimism has a cost",
        kind: "card",
        card: "stat",
        kicker: "Scale · the cost of optimism",
        title: "Agents redo some work when trunk moves under them.",
        items: [
          { value: "45.9%<span class='to'>→</span>30.5%", label: "rework with inhibition and co-change learning", sub: "1,000 agents on hono's history; 175.2 landed a minute", tone: "accent" },
          { value: "34.8%", label: "rework with exclusive locks", sub: "the same workload at 51.9 landed a minute", tone: "blue" },
        ],
        beats: [0.6, "below exclusive locks"],
        tag: { kind: "simulated", text: "Simulated · hono's history, every returned change redone in full, mean of 10 seeds" },
        source: "packages/bench/results/2026-10-13-papers/summary.json",
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
        top: 360,
        gap: 18,
        rowPad: 26,
        rows: [
          { name: "Artifacts", text: "holds every repository <span>· trunk, agent workspaces, git notes</span>" },
          { name: "Durable Objects", text: "run the colony, its regions, the trunk writer <span>and every agent</span>" },
          { name: "Workers AI", text: "powers the reflexes <span>and the agents</span>" },
          { name: "Replay", text: "every run can be replayed <span>· plain git and MCP, no account</span>" },
          { name: "Open source", text: "MIT license" },
        ],
        beats: ["Artifacts holds", "Durable Objects run", "Workers AI powers", "Every run can be replayed", "open source"],
      },
      { at: "A colony, not a queue.", kind: "card", card: "end" },
    ],
  },
};
