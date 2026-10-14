/**
 * Live check of the first red search (FT_BISECT) on a deployment, through the admin API with synthetic agents and inline
 * changes. In each of two new colonies a tiny node:test project lands (bisect/<tag>/src/math.js and its test) and trunk
 * certification turns green on it. With certification held, six changes then land one by one, each its own commit:
 * three good, one that breaks sub(), two good. Certification runs again on the head and goes red.
 * - On a colony FT_BISECT lists (--on): the red result gains `firstRed`, found, naming the landing that holds the breaking
 *   change, with its proposal (and the file it changed) and its intent, in at most four test runs over the six landings;
 *   a `bisect` event is recorded after the red result; the repair intent the red result declared names the commit and
 *   the proposal.
 * - On a colony it does not list (--off): the red result never gains `firstRed` and no `bisect` event is recorded.
 * Both colonies must not exist yet. The deployment needs FT_TRUNK_TESTS on (with the LOADER binding), FT_INLINE on for
 * both colonies, and FT_BISECT listing --on and not --off.
 *
 * Usage:
 *   FT_ADMIN_TOKEN=... node scripts/bisect.ts --url https://<deployment> --on <new colony id FT_BISECT lists> --off <another new colony id>
 */
import { createHash } from "node:crypto";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const ON = arg("on") ?? "";
const OFF = arg("off") ?? "";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
if (!URL_BASE || !ON || !OFF || !ADMIN_TOKEN || ON === OFF) {
  console.error("usage: FT_ADMIN_TOKEN=... node scripts/bisect.ts --url <deployment> --on <new colony id FT_BISECT lists> --off <another new colony id>");
  process.exit(2);
}

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (x: unknown, n = 160): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);

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
type Assignment = { intent: { id: string }; lease: Lease };
type Landed = { proposalId: string; intentId: string; landingId: string };
const TERMINAL = new Set(["landed", "returned", "rejected"]);

const MATH_OK = "export function sub(a, b) {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a, b) {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.js";\n\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

/** Poll `read` every 2 s until `ok` holds or `ms` pass; the last value read. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) {
    await sleep(2_000);
    v = await read();
  }
  return v;
}

/** One colony: the project certified green, six landings with certification held (the fourth breaks sub()), then the red head. */
async function scenario(colony: string, tag: string) {
  const base = `/api/colonies/${colony}`;
  const dir = `bisect/${tag}`;
  const math = `${dir}/src/math.js`;
  const testFile = `${dir}/test/math.test.js`;
  const texts = new Map<string, string>();

  const made = await rest("POST", "/api/colonies", { name: colony, poolTarget: 2 });
  check(`${colony}: created (${made.status})`, made.status === 201);
  if (made.status !== 201) throw new Error(`${colony} could not be created: ${short(made.data)}`);
  check(`${colony}: review off for these checks`, (await rest("POST", `${base}/decide/policy`, { enabled: false })).status === 200);
  const policy = await rest("POST", `${base}/certify/policy`, { enabled: true, repair: true, minIntervalMs: 0 });
  check(`${colony}: certification on with repairs (${policy.status})`, policy.status === 200 && policy.data?.enabled === true);

  /** One change as an agent makes it: an intent assigned to a new synthetic agent, a take, an inline proposal, landed. */
  const change = async (title: string, files: Record<string, string>): Promise<Landed> => {
    const paths = Object.keys(files);
    const a = await rest("POST", `${base}/agents`, { name: `bisect-${tag}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, kind: "synthetic" });
    const agentId = a.data?.id as string;
    if (!agentId) throw new Error(`register an agent in ${colony} failed: ${short(a.data)}`);
    const i = await rest("POST", `${base}/intents`, { title, why: `The first red check (${tag}) needs this change in ${paths.join(", ")}.`, footprint: paths, assignedTo: agentId, createdBy: "bisect-check" });
    const intentId = i.data?.id as string;
    if (!intentId) throw new Error(`intent in ${colony} failed: ${short(i.data)}`);
    let taken: Assignment | null = null;
    for (let n = 0; n < 30 && !taken; n++) {
      const t = await rest("POST", `${base}/agents/${agentId}/take`, {});
      if (t.data?.intent) taken = t.data as Assignment;
      else await sleep(Math.min(2_000, Number(t.data?.retryInMs) || 1_000));
    }
    if (!taken) throw new Error(`${agentId} got no assignment in ${colony}`);
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
      declared: { footprint: paths, summary: title },
      evidence: { checks: [], notVerified: "Not verified: a scripted change for the first red check; the colony's certification runs the tests." },
    });
    const pid = p.data?.id as string;
    if (!pid) throw new Error(`propose in ${colony} failed (${p.status}): ${short(p.data)}`);
    const settled = await until(async () => (await rest("GET", `${base}/proposals/${pid}`)).data ?? {}, (d: any) => TERMINAL.has(d?.status), 120_000);
    check(`${colony}: "${title}" landed (${settled?.status}, ${short(settled?.landingId)})`, settled?.status === "landed" && typeof settled?.landingId === "string");
    if (settled?.status !== "landed") throw new Error(`${colony}: "${title}" did not land: ${short(settled?.reason)}`);
    for (const path of paths) texts.set(path, files[path]!);
    return { proposalId: pid, intentId, landingId: settled.landingId as string };
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

  // Six landings while certification waits.
  check(`${colony}: certification held`, (await rest("POST", `${base}/certify/policy`, { enabled: false })).status === 200);
  for (let n = 1; n <= 3; n++) await change(`Add note ${n}`, { [`${dir}/src/note${n}.js`]: `export const note${n} = ${n};\n` });
  const broke = await change("Speed up subtraction", { [math]: MATH_BUG });
  for (let n = 4; n <= 5; n++) await change(`Add note ${n}`, { [`${dir}/src/note${n}.js`]: `export const note${n} = ${n};\n` });
  const redSha = await head();
  // Turning certification on certifies the current trunk at once.
  check(`${colony}: certification on again`, (await rest("POST", `${base}/certify/policy`, { enabled: true })).status === 200);
  const red = await until(() => result(redSha), (r) => r !== null && r.status !== "running", 90_000);
  check(`${colony}: certification is red on the head ${redSha.slice(0, 7)} (${short(red?.status)}, ${short(red?.failing?.[0]?.name)}), green still ${short(red?.greenSha, 7)}`, red?.status === "red" && red?.greenSha === greenSha);
  return { base, math, broke, greenSha, redSha, result };
}

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

async function main(): Promise<void> {
  const tag = `fr${Date.now().toString(36)}`;
  console.log(`first red check ${tag} on ${URL_BASE} (on: ${ON}, off: ${OFF})`);

  // On: the red result names the landing that broke the test, and its proposal.
  const on = await scenario(ON, tag);
  const done = await until(() => on.result(on.redSha), (r) => r?.firstRed !== undefined, 90_000);
  const fr = done?.firstRed;
  console.log(`      firstRed: ${short(fr, 400)}`);
  const why = await rest("GET", `${on.base}/why?path=${encodeURIComponent(on.math)}`);
  const brokeSha = (Array.isArray(why.data) ? why.data : []).find((e: any) => e?.landing?.id === on.broke.landingId)?.landing?.trunkSha ?? "";
  check(`${ON}: the red result gained firstRed, found (${short(fr?.status)}${fr?.reason ? `: ${short(fr.reason, 200)}` : ""})`, fr?.status === "found");
  check(`${ON}: it names the landing that holds the breaking change (${short(fr?.landingId)}, expected ${on.broke.landingId})`, fr?.landingId === on.broke.landingId);
  check(`${ON}: and its commit (${short(fr?.trunkSha, 7)}, expected ${brokeSha.slice(0, 7)})`, typeof fr?.trunkSha === "string" && fr.trunkSha === brokeSha);
  const named = (Array.isArray(fr?.proposals) ? fr.proposals : []).find((p: any) => p?.id === on.broke.proposalId);
  check(`${ON}: and the breaking proposal with the file it changed (${short(fr?.proposals, 200)})`, !!named && Array.isArray(named.paths) && named.paths.includes(on.math));
  check(`${ON}: and its intent with its title (${short(fr?.intents, 200)})`, (fr?.intents ?? []).some((i: any) => i?.id === on.broke.intentId && i?.title === "Speed up subtraction"));
  check(`${ON}: in at most 4 test runs over the 6 landings since green (${short(fr?.probes)} runs, ${short(fr?.ms)} ms, ${short(fr?.landings)} landings)`, typeof fr?.probes === "number" && fr.probes >= 1 && fr.probes <= 4 && fr?.landings === 6 && fr?.greenSha === on.greenSha);
  const onEvents = await until(() => events(on.base), (list) => list.some((e) => e?.t === "bisect"), 20_000);
  const redAt = onEvents.findIndex((e) => e?.t === "certify" && e?.trunkSha === on.redSha && e?.status === "red");
  const bisectAt = onEvents.findIndex((e) => e?.t === "bisect" && e?.trunkSha === on.redSha);
  check(`${ON}: a bisect event was recorded after the red result (red #${redAt}, bisect #${bisectAt})`, redAt >= 0 && bisectAt > redAt && onEvents[bisectAt]?.firstRed?.landingId === on.broke.landingId);
  const snap = await rest("GET", on.base);
  const repair = (snap.data?.intents ?? []).find((i: any) => i?.source === "certify" && i?.id === done?.repairIntentId);
  check(`${ON}: the repair intent ${short(done?.repairIntentId)} names the commit and the proposal in its why`, typeof repair?.why === "string" && repair.why.includes("First failing commit") && repair.why.includes(on.broke.proposalId));

  // Off: as today.
  const off = await scenario(OFF, tag);
  await sleep(20_000);
  const offResult = await off.result(off.redSha);
  check(`${OFF}: the red result has no firstRed after 20 s (${short(offResult?.firstRed ?? "none")})`, offResult?.status === "red" && offResult?.firstRed === undefined);
  check(`${OFF}: no bisect event was recorded`, !(await events(off.base)).some((e) => e?.t === "bisect"));

  console.log(`      In a browser: ${URL_BASE}/c/${ON} shows the red cross on the trunk bar; its card names the first failing commit ${short(fr?.trunkSha, 7)} and "ft revert ${ON} ${on.broke.proposalId}".`);
  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`first red check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
