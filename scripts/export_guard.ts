/**
 * Live check of the export guard (FT_EXPORT_GUARD) on a deployment, through the admin API with synthetic agents and
 * inline changes. Each colony is seeded with src/b.ts, which exports `foo` and `bar`, and src/a.ts, which imports `foo`
 * from it; then a change removes `foo` from src/b.ts.
 * - On a colony FT_EXPORT_GUARD lists (--on): the removal comes back naming src/a.ts and foo, the next take of its
 *   intent carries that reason (`lastReturn`), and the same removal together with an edit of src/a.ts that drops the
 *   import lands.
 * - On a colony it does not list (--off): the removal lands, as today.
 *
 * The deployment needs FT_INLINE on for both colonies and FT_EXPORT_GUARD listing --on and not --off (the script reads
 * GET /api/about and the colonies' ids, and says so when the flag is not on at all). Both colonies must not exist yet:
 * the script creates them empty. Review is turned off on both unless --review on, which leaves each colony's policy as
 * it is (the changes then face the decide stage's review, and may wait for a person).
 *
 * Usage:
 *   FT_ADMIN_TOKEN=... node scripts/export_guard.ts --url https://<deployment> --on <new colony FT_EXPORT_GUARD lists> --off <another new colony> [--review on]
 */
import { createHash } from "node:crypto";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const ON = arg("on") ?? "";
const OFF = arg("off") ?? "";
const REVIEW = arg("review", "off") === "on";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
if (!URL_BASE || !ON || !OFF || !ADMIN_TOKEN || ON === OFF) {
  console.error("usage: FT_ADMIN_TOKEN=... node scripts/export_guard.ts --url <deployment> --on <new colony FT_EXPORT_GUARD lists> --off <another new colony> [--review on]");
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
type Assignment = { intent: { id: string }; lease: Lease; lastReturn?: { reason?: string } };
const TERMINAL = new Set(["landed", "returned", "rejected"]);

const B = "src/b.ts";
const A = "src/a.ts";
const FOOTPRINT = [B, A];
const B_SEED = "export function foo(): number {\n  return 1;\n}\n\nexport const bar = 2;\n";
const A_SEED = 'import { foo } from "./b.ts";\n\nexport const a = foo() + 1;\n';
const B_REMOVED = "export const bar = 2;\n";
const A_EDITED = 'import { bar } from "./b.ts";\n\nexport const a = bar + 1;\n';
const BROKEN = "removing export foo from src/b.ts breaks the import in src/a.ts: change src/a.ts in the same change, or first";

/** One colony: created, seeded, and a change removing foo from src/b.ts. */
async function scenario(colony: string, tag: string) {
  const base = `/api/colonies/${colony}`;
  const agent = async (name: string): Promise<string> => {
    const a = await rest("POST", `${base}/agents`, { name: `exports-${tag}-${name}`, kind: "synthetic" });
    if (!a.data?.id) throw new Error(`register ${name} in ${colony} failed: ${short(a.data)}`);
    return a.data.id as string;
  };
  const intentFor = async (agentId: string, title: string, why: string): Promise<string> => {
    const i = await rest("POST", `${base}/intents`, { title, why, footprint: FOOTPRINT, assignedTo: agentId, createdBy: "export-guard-check" });
    if (!i.data?.id) throw new Error(`intent in ${colony} failed: ${short(i.data)}`);
    return i.data.id as string;
  };
  const take = async (agentId: string): Promise<Assignment> => {
    for (let i = 0; i < 30; i++) {
      const t = await rest("POST", `${base}/agents/${agentId}/take`, {});
      if (t.data?.intent) return t.data as Assignment;
      await sleep(Math.min(2_000, Number(t.data?.retryInMs) || 1_000));
    }
    throw new Error(`${agentId} got no assignment in ${colony}`);
  };
  const propose = async (agentId: string, a: Assignment, reads: Record<string, string>, files: Record<string, string>, summary: string) => {
    const writeSet = Object.entries(files).map(([path, text]) => ({ path, blob: blobId(text) }));
    const p = await rest("POST", `${base}/proposals`, {
      intentId: a.intent.id,
      agentId,
      workspace: a.lease.repo,
      baseSha: a.lease.baseSha,
      headSha: changesetId(a.lease.baseSha, writeSet),
      writeSet,
      readSet: Object.entries(reads).map(([path, text]) => ({ path, blob: blobId(text) })),
      contents: Object.fromEntries(Object.values(files).map((text) => [blobId(text), text])),
      declared: { footprint: FOOTPRINT, summary },
      evidence: { checks: [], notVerified: "Not verified: a scripted edit; no tests run." },
    });
    if (!p.data?.id) throw new Error(`propose in ${colony} failed (${p.status}): ${short(p.data)}`);
    return p.data as { id: string };
  };
  const settle = async (id: string): Promise<any> => {
    for (let i = 0; i < 120; i++) {
      const now = await rest("GET", `${base}/proposals/${id}`);
      if (TERMINAL.has(now.data?.status)) return now.data;
      await sleep(1_000);
    }
    throw new Error(`proposal ${id} in ${colony} did not settle`);
  };

  const made = await rest("POST", "/api/colonies", { name: colony, poolTarget: 2 });
  check(`${colony}: created empty (${made.status})`, made.status === 201);
  if (made.status !== 201) throw new Error(`${colony} could not be created (it must not exist yet): ${short(made.data)}`);
  if (!REVIEW) check(`${colony}: review off for these checks`, (await rest("POST", `${base}/decide/policy`, { enabled: false })).status === 200);

  // src/b.ts exports foo and bar; src/a.ts imports foo from it.
  const seeder = await agent("seed");
  await intentFor(seeder, `export guard check ${tag}: add src/b.ts and src/a.ts`, "src/b.ts exports foo and bar; src/a.ts imports foo from it.");
  const seed = await settle((await propose(seeder, await take(seeder), {}, { [B]: B_SEED, [A]: A_SEED }, "add src/b.ts and its importer src/a.ts")).id);
  check(`${colony}: the seed landed (${seed.status}${seed.reason ? `: ${short(seed.reason, 120)}` : ""})`, seed.status === "landed");
  if (seed.status !== "landed") throw new Error(`${colony}: the seed did not land`);

  // Remove foo from src/b.ts, leaving src/a.ts as it is.
  const remover = await agent("remove");
  const intent = await intentFor(remover, `export guard check ${tag}: remove foo from src/b.ts`, "foo is no longer wanted in src/b.ts; src/a.ts may change if it has to.");
  const removal = await settle((await propose(remover, await take(remover), { [B]: B_SEED }, { [B]: B_REMOVED }, "remove foo from src/b.ts")).id);
  return { base, remover, intent, removal, take, propose, settle };
}

async function main(): Promise<void> {
  const tag = `eg${Date.now().toString(36)}`;
  console.log(`export guard check ${tag} on ${URL_BASE} (on: ${ON}, off: ${OFF}, review ${REVIEW ? "as each colony has it" : "off"})`);
  const about = await rest("GET", "/api/about");
  const flags: string[] = Array.isArray(about.data?.flags) ? about.data.flags : [];
  check(`the deployment has FT_EXPORT_GUARD and FT_INLINE on (${short(flags.join(", "), 200)})`, flags.includes("FT_EXPORT_GUARD") && flags.includes("FT_INLINE"));

  // On: the removal comes back naming src/a.ts and foo; with src/a.ts edited in the same change it lands.
  const on = await scenario(ON, tag);
  check(`${ON}: removing foo alone came back naming src/a.ts and foo (${on.removal.status}: ${short(on.removal.reason, 200)})`, on.removal.status === "returned" && on.removal.reason === BROKEN);
  const again = await on.take(on.remover);
  check(`${ON}: the next take of the intent carries that reason (${short(again.lastReturn?.reason, 160)})`, again.intent.id === on.intent && again.lastReturn?.reason === BROKEN);
  const both = await on.settle((await on.propose(on.remover, again, { [B]: B_SEED, [A]: A_SEED }, { [B]: B_REMOVED, [A]: A_EDITED }, "remove foo from src/b.ts and stop importing it in src/a.ts")).id);
  check(`${ON}: the same removal with src/a.ts edited in the same change landed (${both.status}${both.reason ? `: ${short(both.reason, 160)}` : ""})`, both.status === "landed");

  // Off: the same removal lands, as today.
  const off = await scenario(OFF, tag);
  check(`${OFF}: removing foo alone landed, as without the guard (${off.removal.status}${off.removal.reason ? `: ${short(off.removal.reason, 160)}` : ""})`, off.removal.status === "landed");

  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`export guard check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
