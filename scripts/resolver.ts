/**
 * Live check of the conflict resolver (FT_RESOLVER) on a deployment, through the admin API with synthetic agents and
 * inline changes. In each colony two agents change line 6 of one file from the same trunk: one renames the constant
 * (`six = 6`), the other changes its value (`v6 = 66`). The first lands; the second comes back from text merge naming
 * the overlapping hunk.
 * - On a colony FT_RESOLVER lists (--on): the change comes back with its conflict, the resolver takes it on (the second
 *   agent's inbox says so), merges it keeping both edits (`six = 66`), and the merge lands with `resolves` in its lineage
 *   note, its author the platform and its model observed; the second agent's inbox says it landed.
 * - On a colony it does not list (--off): the change comes back as today, with no conflict record, and its intent reopens.
 *
 * The deployment needs FT_INLINE and FT_TEXT_MERGE on for both colonies, FT_RESOLVER listing --on and not --off, and
 * Workers AI for the resolver's model (FT_RESOLVER_MODEL, else FT_DEFAULT_MODEL). Each colony is created when missing.
 * Review is turned off on both unless --review on, which leaves each colony's policy as it is (the merge then faces
 * the decide stage's review, and may wait for a person).
 *
 * Usage:
 *   FT_ADMIN_TOKEN=... node scripts/resolver.ts --url https://<deployment> --on <colony FT_RESOLVER lists> --off <colony it does not> [--review on]
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
  console.error("usage: FT_ADMIN_TOKEN=... node scripts/resolver.ts --url <deployment> --on <colony FT_RESOLVER lists> --off <another colony> [--review on]");
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

/** Twelve numbered constants, each tagged with this run, with some lines replaced. */
function values(tag: string, changes: Record<number, string> = {}): string {
  return Array.from({ length: 12 }, (_, i) => `${changes[i + 1] ?? `export const v${i + 1} = ${i + 1};`} // ${tag}\n`).join("");
}

/** One colony's setup and its two changes to line 6. */
async function pair(colony: string, tag: string) {
  const base = `/api/colonies/${colony}`;
  const path = `resolver/${tag}/values.ts`;
  const agent = async (name: string): Promise<string> => {
    const a = await rest("POST", `${base}/agents`, { name: `resolver-${tag}-${name}`, kind: "synthetic" });
    if (!a.data?.id) throw new Error(`register ${name} in ${colony} failed: ${short(a.data)}`);
    return a.data.id as string;
  };
  const intentFor = async (agentId: string, title: string, why: string): Promise<string> => {
    const i = await rest("POST", `${base}/intents`, { title, why, footprint: [path], assignedTo: agentId, createdBy: "resolver-check" });
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
  const propose = async (agentId: string, a: Assignment, read: string | null, text: string, summary: string) => {
    const writeSet = [{ path, blob: blobId(text) }];
    const p = await rest("POST", `${base}/proposals`, {
      intentId: a.intent.id,
      agentId,
      workspace: a.lease.repo,
      baseSha: a.lease.baseSha,
      headSha: changesetId(a.lease.baseSha, writeSet),
      writeSet,
      readSet: read === null ? [] : [{ path, blob: blobId(read) }],
      contents: { [blobId(text)]: text },
      declared: { footprint: [path], summary },
      evidence: { checks: [], notVerified: "Not verified: a scripted edit of one line; no tests run." },
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
  check(`${colony}: colony ready (${made.status === 409 ? "exists" : made.status})`, made.status === 201 || made.status === 409);
  if (!REVIEW) check(`${colony}: review off for these checks`, (await rest("POST", `${base}/decide/policy`, { enabled: false })).status === 200);

  // The file, seeded by an inline change.
  const seed = values(tag);
  const seeder = await agent("seed");
  await intentFor(seeder, `resolver check ${tag}: create ${path}`, "The file the resolver check edits.");
  const s = await settle((await propose(seeder, await take(seeder), null, seed, "seed the file")).id);
  if (s.status !== "landed") throw new Error(`${colony}: the seed did not land: ${s.status} ${short(s.reason)}`);

  // Two changes to line 6 from the same trunk.
  const [c, d] = [await agent("rename"), await agent("value")];
  await intentFor(c, `resolver check ${tag}: rename v6 to six`, "Shorter names read better; keep its value.");
  const dIntent = await intentFor(d, `resolver check ${tag}: set v6 to 66`, "Callers need the larger value; keep its name.");
  const [tc, td] = [await take(c), await take(d)];
  const pc = await settle((await propose(c, tc, seed, values(tag, { 6: "export const six = 6;" }), "rename v6 to six")).id);
  check(`${colony}: the rename landed first (${pc.status})`, pc.status === "landed");
  const pd = await settle((await propose(d, td, seed, values(tag, { 6: "export const v6 = 66;" }), "set v6 to 66")).id);
  return { base, path, seed, c, d, dIntent, pc, pd };
}

/** Directives of kind "resolution" in an agent's inbox, oldest first. */
async function notices(base: string, agentId: string): Promise<string[]> {
  const inbox = await rest("GET", `${base}/agents/${agentId}/inbox?limit=50`);
  const list: any[] = Array.isArray(inbox.data) ? inbox.data : [];
  return list
    .filter((x) => x?.status === "directive" && x?.directive?.kind === "resolution")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((x) => String(x.directive.message ?? ""));
}

async function main(): Promise<void> {
  const tag = `rs${Date.now().toString(36)}`;
  console.log(`resolver check ${tag} on ${URL_BASE} (on: ${ON}, off: ${OFF}, review ${REVIEW ? "as each colony has it" : "off"})`);

  // On: resolved and landed, keeping both edits.
  const on = await pair(ON, tag);
  const conflict = Array.isArray(on.pd.mergeConflicts) ? on.pd.mergeConflicts[0] : null;
  check(`${ON}: the second change came back with its conflict (${on.pd.status}, ${short(conflict)})`, on.pd.status === "returned" && conflict?.path === on.path && Array.isArray(conflict?.lines) && conflict.lines.includes(6));
  let status = "";
  for (let i = 0; i < 90 && status !== "landed" && status !== "open"; i++) {
    await sleep(2_000);
    status = (await rest("GET", `${on.base}/intents/${on.dIntent}`)).data?.intent?.status ?? "";
  }
  const told = await notices(on.base, on.d);
  check(`${ON}: the second agent's inbox says the resolver is merging it (${short(told[0], 120)})`, told.some((m) => m.includes("conflict resolver is merging it")));
  check(`${ON}: the intent landed through the resolver (${status})`, status === "landed");
  check(`${ON}: the second agent's inbox says the merge landed (${short(told.at(-1), 160)})`, told.some((m) => m.includes("the merge landed")));
  const why = await rest("GET", `${on.base}/why?path=${encodeURIComponent(on.path)}&line=6`);
  const entries: any[] = (Array.isArray(why.data) ? why.data : []).flatMap((w: any) => (w?.note?.proposals ?? []).map((p: any) => ({ ...p, landingId: w?.landing?.id })));
  const merged = entries.find((e) => e?.resolves);
  check(
    `${ON}: the merge's lineage note records what it resolves (${short(merged?.resolves)})`,
    merged?.resolves?.proposalId === on.pd.id && Array.isArray(merged.resolves.paths) && merged.resolves.paths.includes(on.path) && Array.isArray(merged.resolves.landingIds) && merged.resolves.landingIds.includes(on.pc.landingId),
  );
  check(
    `${ON}: written by the platform, its model observed (${short(merged?.provenance)})`,
    merged?.agentKind === "internal" && merged?.provenance?.author === "platform" && merged?.provenance?.model?.evidence === "observed" && (merged?.provenance?.model?.observed?.[0]?.calls ?? 0) >= 1,
  );
  const both = values(tag, { 6: "export const six = 66;" });
  const landedBlob = (merged?.writeSet ?? []).find((w: any) => w?.path === on.path)?.blob;
  check(`${ON}: the merged file keeps both edits (line 6 is "export const six = 66;")`, landedBlob === blobId(both));
  check(`${ON}: line 6's newest landing is the merge (${short(why.data?.[0]?.landing?.id)})`, why.data?.[0]?.landing?.id === merged?.landingId);
  const m = (await rest("GET", `${on.base}/metrics`)).data?.metrics ?? {};
  check(`${ON}: metrics count it (attempted ${m["resolver.attempted"]}, landed ${m["resolver.landed"]}, failed ${m["resolver.failed"] ?? 0})`, (m["resolver.attempted"] ?? 0) >= 1 && (m["resolver.landed"] ?? 0) >= 1);

  // Off: the same pair goes back as today.
  const off = await pair(OFF, tag);
  check(`${OFF}: the second change came back as today, naming the hunk (${short(off.pd.reason, 200)})`, off.pd.status === "returned" && /conflicting hunk/.test(off.pd.reason ?? ""));
  check(`${OFF}: no conflict record travels with it`, off.pd.mergeConflicts === undefined);
  await sleep(5_000);
  const reopened = (await rest("GET", `${off.base}/intents/${off.dIntent}`)).data?.intent?.status;
  check(`${OFF}: its intent reopened for the next agent (${reopened})`, reopened === "open");
  check(`${OFF}: no resolution notice`, (await notices(off.base, off.d)).length === 0);

  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`resolver check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
