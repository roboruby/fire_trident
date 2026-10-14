/**
 * Live check of the first red search (FT_BISECT) on a deployment, through the admin API with synthetic agents and inline
 * changes. In each of two new colonies a tiny node:test project lands (bisect/<tag>/src/math.js and its test) and trunk
 * certification turns green on it. With certification held, changes then land one by one, each its own commit: six when
 * --landings is absent, the fourth of them breaking sub() when --break-at is absent, the rest each adding a note file.
 * Certification runs again on the head and goes red.
 * - On a colony FT_BISECT lists (--on): the red result gains `firstRed`, found, naming the landing that holds the breaking
 *   change, with its proposal (and the file it changed) and its intent, in at most 1 + ceil(log2 n) test runs over the n
 *   landings (four over six); a `bisect` event is recorded after the red result; the repair intent the red result
 *   declared names the commit and the proposal.
 * - On a colony it does not list (--off): the red result never gains `firstRed` and no `bisect` event is recorded.
 * Both colonies must not exist yet. The deployment needs FT_TRUNK_TESTS on (with the LOADER binding), FT_INLINE on for
 * both colonies, and FT_BISECT listing --on and not --off.
 *
 * With --demo <colony> (and no --on or --off) it leaves a showcase on one new colony instead: the same project at the
 * colony's root, made by synthetic agents named scripted-*, then the same landings and the red head, checked as the
 * --on colony is. It prints what the search found. Then the repair: a scripted agent (synthetic, named scripted-repair,
 * no model) takes the repair intent the red result declared from the field, as any agent takes work, and proposes the
 * fix as an inline change: sub() subtracts again. The demo ends when certification is green on the new head, and prints
 * the colony, its replay from the first of the six landings, and the landing page that shows its results card. Review
 * is off, as in the check, so no change waits for a person, and the demo approves nothing on anyone's behalf. The
 * deployment needs FT_TRUNK_TESTS, FT_INLINE and FT_BISECT on for that colony; production has all three on for every
 * colony, so the demo has no --off.
 *
 * The repair is scripted rather than written by an in-platform agent: a repair intent asks for the default model class
 * ("Model: default" in its why), so an in-platform agent would write it with the server's default model whatever model
 * it was started with, and could take minutes or give the work back. A scripted change lands in seconds and calls no
 * model, like the search itself.
 *
 * A long history shows what the search is for: 40 landings since green take about 6 test runs, not 40. --landings <n>
 * lands n since green and --break-at <k> puts the breaking change at position k (scripts/bisect_history.ts); in the
 * check the --off colony lands the default six, since the flag's absence is what it checks there. The landings land one
 * at a time because a lane lands every change waiting at once as one commit, and each must be its own: at a few
 * seconds each, 40 take a few minutes. After the checks the output gives the landings since green, the runs the search
 * used and its time, whether it named the right landing, and the fewest runs any search over n landings can take,
 * ceil(log2(n + 1)): one run proves the red commit red, then each run halves the landings left. The search is bounded
 * (8 runs, 20 s a run, 60 s in all, a landing log of 512); the script refuses a history those bounds cannot settle.
 *
 * Usage:
 *   FT_ADMIN_TOKEN=... node scripts/bisect.ts --url https://<deployment> --on <new colony id FT_BISECT lists> --off <another new colony id> [--landings <n>] [--break-at <k>]
 *   FT_ADMIN_TOKEN=... node scripts/bisect.ts --url https://<deployment> --demo <new colony id> [--landings <n>] [--break-at <k>]
 */
import { createHash } from "node:crypto";
import { USAGE, parseArgs, type HistoryArgs } from "./bisect_args.ts";
import { DEFAULT_LANDINGS, defaultBreakAt, history, minimumRuns, mostRuns, predictRuns } from "./bisect_history.ts";

const ARGS = parseArgs(process.argv.slice(2), process.env);
if ("error" in ARGS) {
  console.error(ARGS.error);
  console.error(USAGE);
  process.exit(2);
}
const URL_BASE = ARGS.url;
const ON = ARGS.mode === "check" ? ARGS.on : "";
const OFF = ARGS.mode === "check" ? ARGS.off : "";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
/** The history to land and search: --landings and --break-at, or six with the break at the fourth. */
const HISTORY: HistoryArgs = { landings: ARGS.landings, breakAt: ARGS.breakAt };
/** The history the check's --off colony lands whatever the options: the flag's absence is what it checks there. */
const DEFAULT_HISTORY: HistoryArgs = { landings: DEFAULT_LANDINGS, breakAt: defaultBreakAt(DEFAULT_LANDINGS) };
/** How often a change is read while it lands (the certification waits poll every 2 s): a landing takes a few seconds, and a long history has many. */
const LAND_POLL_MS = 500;

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (x: unknown, n = 160): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);
/** "1st", "2nd", "3rd", "4th", "11th", "21st". */
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/** The git blob id of a UTF-8 text (what `git hash-object` gives). */
function blobId(text: string): string {
  const body = Buffer.from(text, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest("hex");
}

/** The id of an inline change: SHA-1 of its base and its write set sorted by path (core/changeset.ts changesetId). */
function changesetId(baseSha: string, writeSet: Array<{ path: string; blob: string | null }>): string {
  const lines = [...writeSet]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((w) => `${w.path}\0${w.blob ?? "0".repeat(40)}\n`)
    .join("");
  return createHash("sha1").update(Buffer.from(`changeset ${baseSha}\n${lines}`, "utf8")).digest("hex");
}

async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, data };
}

type Lease = { baseSha: string; repo: { namespace: string; name: string; remote: string } };
type Assignment = { intent: { id: string; title?: string; why?: string }; lease: Lease };
type Landed = { proposalId: string; intentId: string; landingId: string };
const TERMINAL = new Set(["landed", "returned", "rejected"]);

const MATH_OK = "export function sub(a, b) {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a, b) {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.js";\n\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

/** Poll `read` every `everyMs` (2 s) until `ok` holds or `ms` pass; the last value read. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number, everyMs = 2_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) {
    await sleep(everyMs);
    v = await read();
  }
  return v;
}

/** What one run makes and what it calls it: the project's folder, its agents, and what its intents and changes say. */
interface Setup {
  /** The project's folder: "" for the colony's root, else a path ending in "/". */
  root: string;
  /** The run as the intents' why and the changes' evidence name it, and the check's tag ("" for the demo). */
  name: string;
  tag: string;
  /** Who the intents say declared them. */
  createdBy: string;
  /** An agent's name, from a slug of what it does. */
  agent: (slug: string) => string;
  demo: boolean;
}

/** The check: its project in bisect/<tag>/, its agents named for the tag. */
function checkSetup(tag: string): Setup {
  return { root: `bisect/${tag}/`, name: "first red check", tag, createdBy: "bisect-check", agent: (slug) => `bisect-${tag}-${slug}`, demo: false };
}

/** The demo: the project at its colony's root, its agents named for what they do and marked as scripted. */
const DEMO_SETUP: Setup = { root: "", name: "first red demo", tag: "", createdBy: "first-red-demo", agent: (slug) => `scripted-${slug}`, demo: true };

/** One colony: the project certified green, `plan.landings` landings with certification held (the one at `plan.breakAt` breaks sub()), then the red head. */
async function scenario(colony: string, setup: Setup, plan: HistoryArgs) {
  const base = `/api/colonies/${colony}`;
  const math = `${setup.root}src/math.js`;
  const testFile = `${setup.root}test/math.test.js`;
  const texts = new Map<string, string>();

  const made = await rest("POST", "/api/colonies", { name: colony, poolTarget: 2 });
  check(`${colony}: created (${made.status})`, made.status === 201);
  if (made.status !== 201) throw new Error(`${colony} could not be created: ${short(made.data)}`);
  check(`${colony}: review off for ${setup.demo ? "this demo" : "these checks"}`, (await rest("POST", `${base}/decide/policy`, { enabled: false })).status === 200);
  const policy = await rest("POST", `${base}/certify/policy`, { enabled: true, repair: true, minIntervalMs: 0 });
  check(`${colony}: certification on with repairs (${policy.status})`, policy.status === 200 && policy.data?.enabled === true);

  /** A new synthetic agent, named for what it does. */
  const join = async (name: string): Promise<string> => {
    const a = await rest("POST", `${base}/agents`, { name, kind: "synthetic" });
    const agentId = a.data?.id as string;
    if (!agentId) throw new Error(`register an agent in ${colony} failed: ${short(a.data)}`);
    return agentId;
  };

  /**
   * The agent takes work (the intent assigned to it, or what the field offers; with `want`, it must be that intent),
   * proposes `files` as one inline change on its lease's base, and waits until the change lands.
   */
  const work = async (agentId: string, label: string, files: Record<string, string>, want?: string): Promise<{ taken: Assignment; proposalId: string; landingId: string }> => {
    const paths = Object.keys(files);
    let taken: Assignment | null = null;
    for (let n = 0; n < 30 && !taken; n++) {
      const t = await rest("POST", `${base}/agents/${agentId}/take`, {});
      if (t.data?.intent) taken = t.data as Assignment;
      else await sleep(Math.min(2_000, Number(t.data?.retryInMs) || 1_000));
    }
    if (!taken) throw new Error(`${agentId} got no assignment in ${colony}`);
    if (want !== undefined && taken.intent.id !== want) throw new Error(`${agentId} was handed ${taken.intent.id} in ${colony}, not ${want}`);
    const writeSet = paths.map((path) => ({ path, blob: blobId(files[path]!) }));
    const readSet = paths.filter((path) => texts.has(path)).map((path) => ({ path, blob: blobId(texts.get(path)!) }));
    const p = await rest("POST", `${base}/proposals`, {
      intentId: taken.intent.id,
      agentId,
      workspace: taken.lease.repo,
      baseSha: taken.lease.baseSha,
      headSha: changesetId(taken.lease.baseSha, writeSet),
      writeSet,
      readSet,
      contents: Object.fromEntries(paths.map((path) => [blobId(files[path]!), files[path]!])),
      declared: { footprint: paths, summary: label },
      evidence: { checks: [], notVerified: `Not verified: a scripted change for the ${setup.name}; the colony's certification runs the tests.` },
    });
    const pid = p.data?.id as string;
    if (!pid) throw new Error(`propose in ${colony} failed (${p.status}): ${short(p.data)}`);
    const settled = await until(async () => (await rest("GET", `${base}/proposals/${pid}`)).data ?? {}, (d: any) => TERMINAL.has(d?.status), 120_000, LAND_POLL_MS);
    check(`${colony}: "${label}" landed (${settled?.status}, ${short(settled?.landingId)})`, settled?.status === "landed" && typeof settled?.landingId === "string");
    if (settled?.status !== "landed") throw new Error(`${colony}: "${label}" did not land: ${short(settled?.reason)}`);
    for (const path of paths) texts.set(path, files[path]!);
    return { taken, proposalId: pid, landingId: settled.landingId as string };
  };

  /** One change as an agent makes it: an intent assigned to a new synthetic agent, a take, an inline proposal, landed. */
  const change = async (title: string, files: Record<string, string>): Promise<Landed> => {
    const paths = Object.keys(files);
    const agentId = await join(setup.agent(title.toLowerCase().replace(/[^a-z0-9]+/g, "-")));
    const why = `The ${setup.name}${setup.tag ? ` (${setup.tag})` : ""} needs this change in ${paths.join(", ")}.`;
    const i = await rest("POST", `${base}/intents`, { title, why, footprint: paths, assignedTo: agentId, createdBy: setup.createdBy });
    const intentId = i.data?.id as string;
    if (!intentId) throw new Error(`intent in ${colony} failed: ${short(i.data)}`);
    const done = await work(agentId, title, files);
    return { proposalId: done.proposalId, intentId, landingId: done.landingId };
  };
  const head = async (): Promise<string> => (await rest("GET", base)).data?.colony?.trunkSha ?? "";
  const result = async (sha: string): Promise<any> => {
    const r = await rest("GET", `${base}/certifications/${sha}`);
    return r.status === 200 ? r.data : null;
  };

  // The project, and its green certification.
  await change("Add the math module and its test", { [math]: MATH_OK, [testFile]: MATH_TEST });
  const greenSha = await head();
  const green = await until(() => result(greenSha), (r) => r !== null && r.status !== "running", 90_000);
  check(`${colony}: certification is green on ${greenSha.slice(0, 7)} (${short(green?.status)}, ${short(green?.counts)})`, green?.status === "green");

  // The landings while certification waits, one at a time: a lane lands every change waiting at once as one commit, and each must be its own.
  check(`${colony}: certification held`, (await rest("POST", `${base}/certify/policy`, { enabled: false })).status === 200);
  const held: Landed[] = [];
  const landingStart = Date.now();
  for (const step of history(plan.landings, plan.breakAt)) {
    if (step.kind === "break") held.push(await change(step.title, { [math]: MATH_BUG }));
    else held.push(await change(step.title, { [`${setup.root}src/note${step.note}.js`]: `export const note${step.note} = ${step.note};\n` }));
  }
  const landedMs = Date.now() - landingStart;
  const broke = held[plan.breakAt - 1]!;
  console.log(`      ${plan.landings} landing${plan.landings === 1 ? "" : "s"} since green landed in ${(landedMs / 1000).toFixed(1)} s, the break at position ${plan.breakAt}.`);
  const redSha = await head();
  // Turning certification on certifies the current trunk at once.
  check(`${colony}: certification on again`, (await rest("POST", `${base}/certify/policy`, { enabled: true })).status === 200);
  const red = await until(() => result(redSha), (r) => r !== null && r.status !== "running", 90_000);
  check(`${colony}: certification is red on the head ${redSha.slice(0, 7)} (${short(red?.status)}, ${short(red?.failing?.[0]?.name)}), green still ${short(red?.greenSha, 7)}`, red?.status === "red" && red?.greenSha === greenSha);

  /** The demo's repair: a new scripted agent takes the repair intent from the field (nothing else is open) and puts sub() back. */
  const repair = async (intentId: string) => work(await join(setup.agent("repair")), "Make sub() subtract again", { [math]: MATH_OK }, intentId);
  return { base, math, broke, held, plan, landedMs, greenSha, redSha, head, result, repair };
}

type Run = Awaited<ReturnType<typeof scenario>>;

/** The colony's recorded events, oldest first (the record replays read), page by page. */
async function events(base: string): Promise<any[]> {
  const out: any[] = [];
  let after = 0;
  for (let n = 0; n < 20; n++) {
    const page = await rest("GET", `${base}/events?source=recorded&limit=5000&after=${after}`);
    if (Array.isArray(page.data?.events)) out.push(...page.data.events);
    if (typeof page.data?.next !== "number") break;
    after = page.data.next;
  }
  return out;
}

/**
 * The search's answer on a colony FT_BISECT covers, checked: found, naming the landing that holds the breaking change,
 * its commit, its proposal (and the file it changed) and its intent, in at most 1 + ceil(log2 n) test runs over the n
 * landings (the search tries the red commit, then halves what is left); a `bisect` event after the red result; the
 * repair intent the red result declared names the commit and the proposal. Then one line with what a results table
 * needs: the landings since green, the runs and their time, whether the landing is the right one, and the fewest runs
 * possible. Returns the red result as last read.
 */
async function firstRedFound(colony: string, run: Run): Promise<any> {
  const done = await until(() => run.result(run.redSha), (r) => r?.firstRed !== undefined, 90_000);
  const fr = done?.firstRed;
  console.log(`      firstRed: ${short(fr, 400)}`);
  const why = await rest("GET", `${run.base}/why?path=${encodeURIComponent(run.math)}`);
  const brokeSha = (Array.isArray(why.data) ? why.data : []).find((e: any) => e?.landing?.id === run.broke.landingId)?.landing?.trunkSha ?? "";
  check(`${colony}: the red result gained firstRed, found (${short(fr?.status)}${fr?.reason ? `: ${short(fr.reason, 200)}` : ""})`, fr?.status === "found");
  check(`${colony}: it names the landing that holds the breaking change (${short(fr?.landingId)}, expected ${run.broke.landingId})`, fr?.landingId === run.broke.landingId);
  check(`${colony}: and its commit (${short(fr?.trunkSha, 7)}, expected ${brokeSha.slice(0, 7)})`, typeof fr?.trunkSha === "string" && fr.trunkSha === brokeSha);
  const named = (Array.isArray(fr?.proposals) ? fr.proposals : []).find((p: any) => p?.id === run.broke.proposalId);
  check(`${colony}: and the breaking proposal with the file it changed (${short(fr?.proposals, 200)})`, !!named && Array.isArray(named.paths) && named.paths.includes(run.math));
  check(`${colony}: and its intent with its title (${short(fr?.intents, 200)})`, (fr?.intents ?? []).some((i: any) => i?.id === run.broke.intentId && i?.title === "Speed up subtraction"));
  const n = run.plan.landings;
  const most = mostRuns(n);
  check(`${colony}: in at most ${most} test runs over the ${n} landings since green (${short(fr?.probes)} runs, ${short(fr?.ms)} ms, ${short(fr?.landings)} landings)`, typeof fr?.probes === "number" && fr.probes >= 1 && fr.probes <= most && fr?.landings === n && fr?.greenSha === run.greenSha);
  const record = await until(() => events(run.base), (list) => list.some((e) => e?.t === "bisect"), 20_000);
  const redAt = record.findIndex((e) => e?.t === "certify" && e?.trunkSha === run.redSha && e?.status === "red");
  const bisectAt = record.findIndex((e) => e?.t === "bisect" && e?.trunkSha === run.redSha);
  check(`${colony}: a bisect event was recorded after the red result (red #${redAt}, bisect #${bisectAt})`, redAt >= 0 && bisectAt > redAt && record[bisectAt]?.firstRed?.landingId === run.broke.landingId);
  const snap = await rest("GET", run.base);
  const repair = (snap.data?.intents ?? []).find((i: any) => i?.source === "certify" && i?.id === done?.repairIntentId);
  check(`${colony}: the repair intent ${short(done?.repairIntentId)} names the commit and the proposal in its why`, typeof repair?.why === "string" && repair.why.includes("First failing commit") && repair.why.includes(run.broke.proposalId));
  const right = fr?.status === "found" && fr?.landingId === run.broke.landingId;
  console.log(
    `      Search: ${short(fr?.landings)} landings since green (landed in ${(run.landedMs / 1000).toFixed(1)} s), ${short(fr?.probes)} test runs in ${short(fr?.ms)} ms, the right landing: ${right ? "yes" : "no"}. The fewest runs for ${n} landings is ${minimumRuns(n)} (ceil(log2(n + 1))) and the most ${most}; this history, the break at position ${run.plan.breakAt}, takes ${predictRuns(n, run.plan.breakAt).runs}.`,
  );
  return done;
}

async function main(): Promise<void> {
  const tag = `fr${Date.now().toString(36)}`;
  console.log(`first red check ${tag} on ${URL_BASE} (on: ${ON}, off: ${OFF}; ${HISTORY.landings} landings since green with the break at position ${HISTORY.breakAt}; the off colony lands the default ${DEFAULT_HISTORY.landings})`);

  // On: the red result names the landing that broke the test, and its proposal.
  const on = await scenario(ON, checkSetup(tag), HISTORY);
  const fr = (await firstRedFound(ON, on))?.firstRed;

  // Off: as today, on the default history (the flag's absence is what this colony checks).
  const off = await scenario(OFF, checkSetup(tag), DEFAULT_HISTORY);
  await sleep(20_000);
  const offResult = await off.result(off.redSha);
  check(`${OFF}: the red result has no firstRed after 20 s (${short(offResult?.firstRed ?? "none")})`, offResult?.status === "red" && offResult?.firstRed === undefined);
  check(`${OFF}: no bisect event was recorded`, !(await events(off.base)).some((e) => e?.t === "bisect"));

  console.log(`      In a browser: ${URL_BASE}/c/${ON} shows the red cross on the trunk bar; its card names the first failing commit ${short(fr?.trunkSha, 7)} and "ft revert ${ON} ${on.broke.proposalId}".`);
  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

/** The flags the demo needs on the deployment: certification after landing, inline changes, and the first red search. */
const DEMO_FLAGS = ["FT_TRUNK_TESTS", "FT_INLINE", "FT_BISECT"];
/** The replay's speed: the run, from the first landing to green again, plays in well under a minute on the default six landings. */
const REPLAY_SPEED = 2;

/**
 * The demo (see the top of this file): one new colony goes red, the search names the landing that broke the test, a
 * scripted agent lands the repair from the repair intent, and certification is green again. Returns the exit code: 0
 * when every step passed, 1 when one failed (the colony stays as it was left), 2 when it created nothing.
 */
async function demo(colony: string): Promise<number> {
  console.log(`first red demo on ${URL_BASE}: colony ${colony}`);
  const changes = HISTORY.landings === 1 ? "1 change lands" : `${HISTORY.landings} changes land`;
  console.log(`      A node:test project lands and certifies green; ${changes} while certification is held, the ${ordinal(HISTORY.breakAt)} breaking sub(); certification goes red; the first red search names the landing; a scripted agent takes the repair intent; certification goes green.`);
  // Without these the colony would never go red, or the search would never run: say so before making a public colony.
  const about = await rest("GET", "/api/about");
  const flags: unknown = about.data?.flags;
  if (Array.isArray(flags)) {
    const missing = DEMO_FLAGS.filter((f) => !flags.includes(f));
    if (missing.length > 0) {
      console.error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on at ${URL_BASE}: the demo needs ${DEMO_FLAGS.join(", ")}, so it created nothing.`);
      return 2;
    }
  } else {
    console.log(`      (GET /api/about did not list the flags (${about.status}); going on)`);
  }
  if ((await rest("GET", `/api/colonies/${colony}`)).status === 200) {
    console.error(`${colony} exists already, and the demo needs a new colony: pick another id, or delete it first with ft delete ${colony} --yes.`);
    return 2;
  }

  const run = await scenario(colony, DEMO_SETUP, HISTORY);
  const red = await firstRedFound(colony, run);
  const fr = red?.firstRed;
  if (fr?.status !== "found") return 1;
  const proposal = (Array.isArray(fr.proposals) ? fr.proposals : []).find((p: any) => p?.id === run.broke.proposalId);
  const intent = (Array.isArray(fr.intents) ? fr.intents : []).find((i: any) => i?.id === run.broke.intentId);
  const test = Array.isArray(red?.failing) ? red.failing[0] : undefined;
  console.log(`\n      Red on ${run.redSha.slice(0, 7)}: ${short(test?.file)} > ${short(test?.name)} fails (${short(test?.error, 120)}).`);
  console.log(`      The search ran only the failing test, alone, on earlier commits: ${short(fr.probes)} test runs in ${short(fr.ms)} ms over the ${short(fr.landings)} landings since green ${short(fr.greenSha, 7)}.`);
  console.log(`      It names commit ${short(fr.trunkSha, 7)} (landing ${short(fr.landingId)}): the intent "${short(intent?.title)}", whose proposal ${short(proposal?.id)} changed ${short((proposal?.paths ?? []).join(", "))}.\n`);

  // The repair: the intent the red result declared, with the first failing commit in its why, taken by a scripted agent.
  const repairId = typeof red?.repairIntentId === "string" ? red.repairIntentId : "";
  check(`${colony}: the red result declared a repair intent (${short(repairId || "none")})`, repairId !== "");
  if (!repairId) return 1;
  const fixed = await run.repair(repairId);
  const named = (fixed.taken.intent.why ?? "").split("\n").find((l) => l.startsWith("First failing commit:")) ?? "";
  check(`${colony}: scripted-repair took "${short(fixed.taken.intent.title)}" (${repairId}), whose why names the first failing commit: ${short(named, 200)}`, named.includes(String(fr.trunkSha).slice(0, 7)));

  // Certification on the repaired head.
  const fixedSha = await run.head();
  const green = await until(() => run.result(fixedSha), (r) => r !== null && r.status !== "running", 90_000);
  check(`${colony}: certification is green again on the head ${fixedSha.slice(0, 7)} (${short(green?.status)}, ${short(green?.counts)})`, green?.status === "green");
  if (typeof red?.finishedAt === "number" && typeof green?.finishedAt === "number") {
    console.log(`      Trunk was red for ${((green.finishedAt - red.finishedAt) / 1000).toFixed(1)} s, from the red result to the green one.`);
  }

  // The replay starts at the first of the landings: the green certification before it is already on the trunk bar.
  const record = await events(run.base);
  const first = record[0]?.at;
  const start = record.find((e) => e?.t === "intent" && e?.intentId === run.held[0]?.intentId)?.at;
  const t = typeof first === "number" && typeof start === "number" ? Math.max(0, Math.floor((start - first) / 1000)) : 0;
  const page = `${URL_BASE}/c/${encodeURIComponent(colony)}`;
  console.log(`\nColony: ${page}`);
  console.log(`Replay: ${page}?replay=1&t=${t}&speed=${REPLAY_SPEED} (from the first of the ${HISTORY.landings} landings)`);
  console.log(`Card:   ${URL_BASE}/?results=${colony}:firstred (the landing page's showcase entry for this colony can carry replay: "t=${t}&speed=${REPLAY_SPEED}")`);
  return failed ? 1 : 0;
}

if (ARGS.mode === "demo") {
  let code = 1;
  try {
    code = await demo(ARGS.colony);
  } catch (e) {
    check(`the demo ran to the end (${e instanceof Error ? e.message : String(e)})`, false);
  }
  if (code === 1) console.log(`      The colony stays as the demo left it: delete it with ft delete ${ARGS.colony} --yes before running the demo again with that id.`);
  console.log(code === 0 ? "DEMO DONE: certification is green again" : code === 2 ? "DEMO NOT RUN: nothing was created" : "DEMO FAILED");
  process.exit(code);
} else {
  main().catch((e) => {
    console.error(`first red check failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
