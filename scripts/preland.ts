/**
 * Live check of tests before landing (FT_PRELAND) on a deployment, through the admin API with synthetic agents and inline
 * changes. In each of two new colonies a tiny node:test project lands (preland/<tag>/src/math.js and its test) and trunk
 * certification turns green on it. A change that breaks sub() is then proposed, with review off, so the decide stage has
 * nothing to do with it but its tests.
 * - On a colony FT_PRELAND lists (--on), with prelandPaths naming the project's src directory: the breaking change comes
 *   back before landing, its reason naming the test "subtracts" and its error, the run (failed) in its evidence, and trunk
 *   unmoved; the fixed change lands with the run (passed, 1 test file, 1 of 1 test) in its evidence and in its lineage
 *   note, and certification stays green; a change outside prelandPaths (the project's README) lands with no run, as today.
 * - On a colony it does not list (--off): the breaking change lands as today, with no run in its evidence, and certification
 *   goes red after landing, naming the test.
 * Both colonies must not exist yet. The deployment needs FT_TRUNK_TESTS on (with the LOADER binding), FT_INLINE on for
 * both colonies, and FT_PRELAND listing --on and not --off.
 *
 * Usage:
 *   FT_ADMIN_TOKEN=... node scripts/preland.ts --url https://<deployment> --on <new colony id FT_PRELAND lists> --off <another new colony id>
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
  console.error("usage: FT_ADMIN_TOKEN=... node scripts/preland.ts --url <deployment> --on <new colony id FT_PRELAND lists> --off <another new colony id>");
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
const TERMINAL = new Set(["landed", "returned", "rejected"]);
const CHECK = "tests before landing";

const MATH_OK = "export function sub(a, b) {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a, b) {\n  return a + b;\n}\n";
const MATH_FIXED = "export function sub(a, b) {\n  // Subtraction, as the test asks.\n  return a - b;\n}\n";
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

/** The check named in a proposal's evidence, if any. */
function prelandCheck(p: any): any {
  return (Array.isArray(p?.evidence?.checks) ? p.evidence.checks : []).find((c: any) => c?.name === CHECK);
}

/** One colony: review off, certification on, the project landed and certified green, then changes as its agents make them. */
async function scenario(colony: string, tag: string, prelandPaths: string[] | null) {
  const base = `/api/colonies/${colony}`;
  const dir = `preland/${tag}`;
  const math = `${dir}/src/math.js`;
  const testFile = `${dir}/test/math.test.js`;
  const texts = new Map<string, string>();

  const made = await rest("POST", "/api/colonies", { name: colony, poolTarget: 2 });
  check(`${colony}: created (${made.status})`, made.status === 201);
  if (made.status !== 201) throw new Error(`${colony} could not be created: ${short(made.data)}`);
  check(`${colony}: review off, so the decide stage has only the tests to run`, (await rest("POST", `${base}/decide/policy`, { enabled: false })).status === 200);
  const policy = await rest("POST", `${base}/certify/policy`, { enabled: true, repair: false, minIntervalMs: 0, ...(prelandPaths ? { prelandPaths } : {}) });
  check(`${colony}: certification on (${policy.status})`, policy.status === 200 && policy.data?.enabled === true);
  if (prelandPaths) check(`${colony}: prelandPaths set to ${short(prelandPaths)} (got ${short(policy.data?.prelandPaths)})`, JSON.stringify(policy.data?.prelandPaths) === JSON.stringify(prelandPaths));
  else check(`${colony}: no prelandPaths (every change, were the flag on)`, policy.data?.prelandPaths === undefined);

  /** One change as an agent makes it: an intent assigned to a new synthetic agent, a take, an inline proposal, then its settled state. */
  const propose = async (title: string, files: Record<string, string>): Promise<any> => {
    const paths = Object.keys(files);
    const a = await rest("POST", `${base}/agents`, { name: `preland-${tag}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, kind: "synthetic" });
    const agentId = a.data?.id as string;
    if (!agentId) throw new Error(`register an agent in ${colony} failed: ${short(a.data)}`);
    const i = await rest("POST", `${base}/intents`, { title, why: `The tests-before-landing check (${tag}) needs this change in ${paths.join(", ")}.`, footprint: paths, assignedTo: agentId, createdBy: "preland-check" });
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
      evidence: { checks: [], notVerified: "Not verified: a scripted change for the tests-before-landing check; the colony's tests decide." },
    });
    const pid = p.data?.id as string;
    if (!pid) throw new Error(`propose in ${colony} failed (${p.status}): ${short(p.data)}`);
    const settled = await until(async () => (await rest("GET", `${base}/proposals/${pid}`)).data ?? {}, (d: any) => TERMINAL.has(d?.status), 120_000);
    if (settled?.status === "landed") for (const path of paths) texts.set(path, files[path]!);
    return { ...settled, id: pid, baseSha: taken.lease.baseSha };
  };
  /** A change that must land. */
  const land = async (title: string, files: Record<string, string>): Promise<any> => {
    const settled = await propose(title, files);
    check(`${colony}: "${title}" landed (${settled?.status}, ${short(settled?.landingId)})`, settled?.status === "landed" && typeof settled?.landingId === "string");
    if (settled?.status !== "landed") throw new Error(`${colony}: "${title}" did not land: ${short(settled?.reason)}`);
    return settled;
  };
  const head = async (): Promise<string> => (await rest("GET", base)).data?.colony?.trunkSha ?? "";
  const result = async (sha: string): Promise<any> => {
    const r = await rest("GET", `${base}/certifications/${sha}`);
    return r.status === 200 ? r.data : null;
  };
  const certified = async (sha: string): Promise<any> => until(() => result(sha), (r) => r !== null && r.status !== "running", 90_000);

  // The project, and its green certification: the trunk results the check compares with.
  await land("Add the math module and its test", { [math]: MATH_OK, [testFile]: MATH_TEST });
  const greenSha = await head();
  const green = await certified(greenSha);
  check(`${colony}: certification is green on ${greenSha.slice(0, 7)} (${short(green?.status)}, ${short(green?.counts)})`, green?.status === "green");
  return { base, dir, math, testFile, greenSha, propose, land, head, result, certified };
}

async function main(): Promise<void> {
  const tag = `pl${Date.now().toString(36)}`;
  console.log(`tests before landing check ${tag} on ${URL_BASE} (on: ${ON}, off: ${OFF})`);
  const about = await rest("GET", "/api/about");
  const flags: string[] = Array.isArray(about.data?.flags) ? about.data.flags : [];
  check(`deployment: FT_PRELAND, FT_TRUNK_TESTS and FT_INLINE are on for some colony (${short(flags, 300)})`, ["FT_PRELAND", "FT_TRUNK_TESTS", "FT_INLINE"].every((f) => flags.includes(f)));

  // On: the breaking change comes back before landing; the fixed one lands with its run; a change outside prelandPaths is not checked.
  const on = await scenario(ON, tag, [`preland/${tag}/src`]);
  const t0 = Date.now();
  const bad = await on.propose("Speed up subtraction", { [on.math]: MATH_BUG });
  const run = bad?.evidence?.preland;
  console.log(`      ${ON}: "Speed up subtraction" ${short(bad?.status)} after ${Date.now() - t0} ms: ${short(bad?.reason, 400)}`);
  console.log(`      ${ON}: run: ${short(run, 400)}`);
  check(`${ON}: the breaking change came back before landing (${short(bad?.status)})`, bad?.status === "returned");
  check(`${ON}: its reason names the test and its error`, typeof bad?.reason === "string" && bad.reason.startsWith("Tests before landing: ") && bad.reason.includes(`the test "subtracts" in ${on.testFile}`) && /actual 8, expected 2/.test(bad.reason));
  check(`${ON}: its evidence carries the run: failed, on its base ${on.greenSha.slice(0, 7)}, 1 test file, 0 of 1 passed, "subtracts" broke`, run?.status === "failed" && run?.trunkSha === on.greenSha && JSON.stringify(run?.files) === JSON.stringify([on.testFile]) && run?.tests === 1 && run?.passed === 0 && run?.failed === 1 && run?.broke?.[0]?.name === "subtracts");
  check(`${ON}: and the check "${CHECK}" (ok: ${short(prelandCheck(bad)?.ok)}, ${short(run?.ms)} ms)`, prelandCheck(bad)?.ok === false && typeof run?.ms === "number");
  check(`${ON}: nothing landed: trunk is still ${on.greenSha.slice(0, 7)}`, (await on.head()) === on.greenSha);

  const fixed = await on.land("Document subtraction", { [on.math]: MATH_FIXED });
  const ran = fixed?.evidence?.preland;
  console.log(`      ${ON}: run: ${short(ran, 400)}`);
  check(`${ON}: the fixed change's evidence carries the run: passed, 1 test file, 1 of 1 test, on its base ${on.greenSha.slice(0, 7)}`, ran?.status === "passed" && ran?.trunkSha === on.greenSha && ran?.tests === 1 && ran?.passed === 1 && ran?.failed === 0 && JSON.stringify(ran?.files) === JSON.stringify([on.testFile]));
  check(`${ON}: and the check "${CHECK}" says so (${short(prelandCheck(fixed)?.detail, 200)})`, prelandCheck(fixed)?.ok === true && /1 test file that reach the change ran on its base with it: 1 of 1 test passed/.test(prelandCheck(fixed)?.detail ?? ""));
  const why = await until(async () => (await rest("GET", `${on.base}/why?path=${encodeURIComponent(on.math)}`)).data, (d: any) => Array.isArray(d) && d.some((e: any) => e?.landing?.id === fixed.landingId), 30_000);
  const entry = (Array.isArray(why) ? why : []).find((e: any) => e?.landing?.id === fixed.landingId);
  const noted = (entry?.note?.proposals ?? []).find((p: any) => p?.id === fixed.id);
  check(`${ON}: its lineage note carries the run (${short(noted?.evidence?.preland, 200)})`, noted?.evidence?.preland?.status === "passed" && noted?.evidence?.preland?.tests === 1 && (noted?.evidence?.checks ?? []).some((c: any) => c?.name === CHECK && c?.ok === true));
  const fixedSha = await on.head();
  const stillGreen = await on.certified(fixedSha);
  check(`${ON}: certification is green on the new head ${fixedSha.slice(0, 7)} (${short(stillGreen?.status)})`, stillGreen?.status === "green");

  const readme = await on.land("Describe the project", { [`${on.dir}/README.md`]: `# ${tag}\n\nA subtraction, with its test.\n` });
  check(`${ON}: a change outside prelandPaths landed with no run (${short(readme?.evidence?.preland ?? "none")})`, readme?.evidence?.preland === undefined && prelandCheck(readme) === undefined);
  const metrics = (await rest("GET", `${on.base}/metrics`)).data;
  const counters = JSON.stringify(metrics ?? {});
  check(`${ON}: counted once failed and once passed (preland.failed, preland.passed)`, /"preland\.failed":1\b/.test(counters) && /"preland\.passed":1\b/.test(counters));

  // Off: as today. The breaking change lands and certification goes red after landing.
  const off = await scenario(OFF, tag, null);
  const landed = await off.land("Speed up subtraction", { [off.math]: MATH_BUG });
  check(`${OFF}: the breaking change landed with no run in its evidence (${short(landed?.evidence?.preland ?? "none")})`, landed?.evidence?.preland === undefined && prelandCheck(landed) === undefined);
  const redSha = await off.head();
  const red = await off.certified(redSha);
  check(`${OFF}: certification is red on the head ${redSha.slice(0, 7)} after landing (${short(red?.status)}, ${short(red?.failing?.[0]?.name)}), green still ${short(red?.greenSha, 7)}`, red?.status === "red" && red?.failing?.[0]?.name === "subtracts" && red?.greenSha === off.greenSha);

  console.log(`      In a browser: ${URL_BASE}/c/${ON}, Why tab on ${on.math}: the Evidence step of "Document subtraction" lists "${CHECK}" with its sentence; ft why ${ON} ${on.math} prints the "tested" line.`);
  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`tests before landing check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
