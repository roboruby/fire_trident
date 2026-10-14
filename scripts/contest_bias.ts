/**
 * Live measure of contest mode's judge on a deployment, through the admin API with synthetic agents and inline
 * changes: per contest, whether the judge's two orders agreed, which contestant won, and whether the deterministic
 * tie-break decided; over the run, the disagreement rate (a preference for a position), the ties, and the time each
 * contest took to settle. Where FT_CONTEST_JURY covers the colony, the same run reports the jury's majorities, its
 * ties and its inconsistent members instead, so a run before the flag and a run after it compare.
 *
 * Each contest: one intent with `contest: 2` asks for a new module exporting greet() that returns "bonjour"; two fresh
 * synthetic agents take it and each proposes an inline change that does so, one as a one-line arrow function and the
 * other as a three-line function declaration. Both are equal on deterministic evidence (no proof, nothing outside the
 * footprint, no danger signals), so the pair always reaches the judge; the order they propose in alternates, so a
 * preference for a position shows against both. The verdict is read from the loser's reason (`superseded: contest for
 * … won by … (<verdict>)`), which names the judge's answer in both orders or every juror's vote, and the time to settle
 * from the event record: the contest event's time less the moment the later change became ready.
 *
 * The deployment needs FT_INLINE covering the colony and Workers AI for the judge (the decide policy's
 * secondOpinionModels, or its juryModels where FT_CONTEST_JURY covers the colony). The colony is created when missing.
 * Review is turned off on it unless --review on, which leaves the policy as it is (each change then faces the decide
 * stage first, and may wait for a person).
 *
 * Usage:
 *   FT_ADMIN_TOKEN=... node scripts/contest_bias.ts --url https://<deployment> --colony <id> [--contests 10] [--review on]
 *
 * Exit 0 when every contest settled (the numbers are a report for comparing runs, not a verdict), 1 otherwise.
 */
import { createHash } from "node:crypto";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const COLONY = arg("colony") ?? "";
const CONTESTS = Number(arg("contests", "10"));
const REVIEW = arg("review", "off") === "on";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
if (!URL_BASE || !COLONY || !ADMIN_TOKEN || !Number.isInteger(CONTESTS) || CONTESTS < 1 || CONTESTS > 100) {
  console.error("usage: FT_ADMIN_TOKEN=... node scripts/contest_bias.ts --url <deployment> --colony <colony> [--contests 10 (1 to 100)] [--review on]");
  process.exit(2);
}

/** How long one contest may take to settle (the judge's deadline is 90 s a pair, and the colony looks every second). */
const SETTLE_MS = 300_000;

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (x: unknown, n = 160): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

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
const BASE = `/api/colonies/${COLONY}`;

/** The two ways of writing the module: equal on deterministic evidence, different in size (1 line against 3). */
const VARIANTS = {
  arrow: 'export const greet = (): string => "bonjour";\n',
  func: 'export function greet(): string {\n  return "bonjour";\n}\n',
} as const;
type Variant = keyof typeof VARIANTS;

async function agent(name: string): Promise<string> {
  const a = await rest("POST", `${BASE}/agents`, { name, kind: "synthetic" });
  if (!a.data?.id) throw new Error(`register ${name} failed: ${short(a.data)}`);
  return a.data.id as string;
}

/** Take until an assignment comes (contestants' takes may wait a moment for the field reading). */
async function take(agentId: string): Promise<Assignment> {
  for (let i = 0; i < 60; i++) {
    const t = await rest("POST", `${BASE}/agents/${agentId}/take`, {});
    if (t.data?.intent) return t.data as Assignment;
    await sleep(Math.min(2_000, Number(t.data?.retryInMs) || 1_000));
  }
  throw new Error(`${agentId} got no assignment`);
}

async function propose(agentId: string, a: Assignment, path: string, text: string, summary: string): Promise<{ id: string; at: number }> {
  const writeSet = [{ path, blob: blobId(text) }];
  const p = await rest("POST", `${BASE}/proposals`, {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: changesetId(a.lease.baseSha, writeSet),
    writeSet,
    readSet: [],
    contents: { [blobId(text)]: text },
    declared: { footprint: [path], summary },
    evidence: { checks: [], notVerified: "Not verified: a scripted module of one function; no tests run." },
  });
  if (!p.data?.id) throw new Error(`propose failed (${p.status}): ${short(p.data)}`);
  return { id: p.data.id as string, at: Date.now() };
}

/** What the loser's reason says about how the pair was decided. */
interface Verdict {
  /** judge: one model asked in both orders; jury: FT_CONTEST_JURY; evidence: decided before any model; none: no model could be asked. */
  mode: "judge" | "jury" | "evidence" | "none";
  /** A model, or the majority of a jury, decided (no tie-break). */
  decided: boolean;
  /** For a judge: its two orders agreed (false when it preferred a position, or answered a tie). */
  agreed: boolean | null;
  /** How the tie was broken, when it was. */
  tieBreak: string | null;
  /** The judge preferred the change shown first or second in both orders. */
  position: "first" | "second" | null;
  /** The jury: votes for each side, and members inconsistent for a position, for not answering in time, or for an unusable answer. */
  jury: { size: number; votes: [number, number]; positional: number; late: number; unusable: number } | null;
  text: string;
}

/** The verdict inside `superseded: contest for <intent> won by <winner> (<verdict>)`, classified by the wording contest.ts and jury.ts write. */
function classify(reason: string): Verdict {
  const m = /^superseded: contest for \S+ won by \S+ \(([\s\S]*)\)$/.exec(reason ?? "");
  const text = m ? m[1]! : reason ?? "";
  const v: Verdict = { mode: "evidence", decided: true, agreed: null, tieBreak: null, position: null, jury: null, text };
  const jurors = /^judged better by (\d+) of (\d+) jurors in both orders/.exec(text);
  const juryTie = /^a tie \(the jury of (\d+) (?:split (\d+) to (\d+)|had no consistent vote)[^)]*\), broken by (.*)$/.exec(text);
  const members = (s: string) => ({
    positional: (s.match(/preferred the change shown (?:first|second) in both orders/g) ?? []).length,
    late: (s.match(/did not answer within|got no slot within/g) ?? []).length,
    unusable: (s.match(/gave no parsable judgment|is gone|failed|error/gi) ?? []).length,
  });
  if (jurors) {
    const n = Number(jurors[2]);
    const got = Number(jurors[1]);
    return { ...v, mode: "jury", decided: true, jury: { size: n, votes: [got, 0], ...members(text) } };
  }
  if (juryTie) {
    const n = Number(juryTie[1]);
    const votes: [number, number] = juryTie[2] !== undefined ? [Number(juryTie[2]), Number(juryTie[3])] : [0, 0];
    return { ...v, mode: "jury", decided: false, tieBreak: juryTie[4]!, jury: { size: n, votes, ...members(text) } };
  }
  if (/^judged better by \S+ in both orders/.test(text)) return { ...v, mode: "judge", decided: true, agreed: true };
  const flip = /^a tie \(\S+ preferred the change shown (first|second) in both orders\), broken by (.*)$/.exec(text);
  if (flip) return { ...v, mode: "judge", decided: false, agreed: false, position: flip[1] as "first" | "second", tieBreak: flip[2]! };
  const same = /^a tie \(\S+ saw no clear difference\), broken by (.*)$/.exec(text);
  if (same) return { ...v, mode: "judge", decided: false, agreed: false, tieBreak: same[1]! };
  const none = /^a tie \((?:the judge was unavailable|no judge model is bound|too large or unreadable|no jury model configured)[^)]*(?:\([^)]*\))?\), broken by (.*)$/.exec(text);
  if (none) return { ...v, mode: "none", decided: false, tieBreak: none[1]! };
  return v;
}

interface Result {
  n: number;
  intent: string;
  winner: Variant | "?";
  winnerFirst: boolean | null;
  verdict: Verdict | null;
  /** From the later change ready to the contest decided (the event record), else from the later proposal accepted to the loss seen. */
  settleMs: number | null;
  settledFrom: "events" | "clock" | null;
  error?: string;
}

/** The colony's counters and spend now. */
async function counters(): Promise<{ metrics: Record<string, number>; judgeUsd: number }> {
  const r = await rest("GET", `${BASE}/metrics`);
  const metrics: Record<string, number> = r.data?.metrics ?? {};
  return { metrics, judgeUsd: Number(r.data?.spend?.byLayer?.judge) || 0 };
}

/** One contest: declare, seat two agents, propose both ways, wait for the decision and read how it was made. */
async function contest(n: number, tag: string): Promise<Result> {
  const path = `contest/${tag}/greet${n}.ts`;
  const out: Result = { n, intent: "", winner: "?", winnerFirst: null, verdict: null, settleMs: null, settledFrom: null };
  const i = await rest("POST", `${BASE}/intents`, {
    title: `contest check ${tag} ${n}: add greet() to ${path}`,
    why: "The greeting module these agents race to write: one landing, the other kept as an alternative.",
    footprint: [path],
    acceptance: ['greet() returns "bonjour"'],
    contest: 2,
    createdBy: "contest-check",
  });
  if (!i.data?.id) throw new Error(`intent ${n} failed (${i.status}): ${short(i.data)}`);
  out.intent = i.data.id as string;
  const [a, b] = [await agent(`contest-${tag}-${n}-a`), await agent(`contest-${tag}-${n}-b`)];
  const [ta, tb] = [await take(a), await take(b)];
  if (ta.intent.id !== out.intent || tb.intent.id !== out.intent) {
    out.error = `the agents took ${ta.intent.id} and ${tb.intent.id}, not ${out.intent}: another intent was open in the colony`;
    return out;
  }
  // The order alternates: the arrow version is proposed first on odd contests, the function version on even ones.
  const first: Variant = n % 2 === 1 ? "arrow" : "func";
  const second: Variant = first === "arrow" ? "func" : "arrow";
  const byVariant = new Map<Variant, string>();
  const pa = await propose(a, ta, path, VARIANTS[first], `add greet() as ${first === "arrow" ? "an arrow function" : "a function declaration"}`);
  byVariant.set(first, pa.id);
  await sleep(50);
  const pb = await propose(b, tb, path, VARIANTS[second], `add greet() as ${second === "arrow" ? "an arrow function" : "a function declaration"}`);
  byVariant.set(second, pb.id);

  // Wait for the loss: one change back, superseded by the other.
  const t0 = Date.now();
  let loser: any = null;
  while (Date.now() - t0 < SETTLE_MS) {
    for (const id of [pa.id, pb.id]) {
      const p = (await rest("GET", `${BASE}/proposals/${id}`)).data;
      if (p?.status === "returned" && /^superseded: contest/.test(p.reason ?? "")) loser = p;
      else if (p?.status && !["pending", "checking", "ready", "landed"].includes(p.status)) {
        out.error = `${id} is ${p.status} (${short(p.reason, 200)}): the contest cannot be decided`;
        return out;
      }
    }
    if (loser) break;
    await sleep(500);
  }
  if (!loser) {
    out.error = `not settled within ${secs(SETTLE_MS)}`;
    return out;
  }
  const seen = Date.now();
  const winnerId = loser.supersededBy as string;
  out.winner = winnerId === byVariant.get("arrow") ? "arrow" : winnerId === byVariant.get("func") ? "func" : "?";
  out.winnerFirst = winnerId === pa.id;
  out.verdict = classify(loser.reason);

  // The time to settle from the record: the contest event less the later ready event of the two changes.
  const ev: any[] = (await rest("GET", `${BASE}/events?limit=5000`)).data?.events ?? [];
  const decided = ev.find((e) => e?.t === "contest" && e.intentId === out.intent);
  const ready = ev.filter((e) => e?.t === "proposal" && e.status === "ready" && (e.proposalId === pa.id || e.proposalId === pb.id)).map((e) => Number(e.at));
  if (decided && ready.length === 2) {
    out.settleMs = Number(decided.at) - Math.max(...ready);
    out.settledFrom = "events";
  } else {
    out.settleMs = seen - pb.at;
    out.settledFrom = "clock";
  }
  return out;
}

/** One line per contest. */
function line(r: Result): string {
  const head = `#${String(r.n).padStart(2)}  ${r.intent}`;
  if (r.error) return `${head}  ERROR ${r.error}`;
  const v = r.verdict!;
  const won = `won by the ${r.winner} version (proposed ${r.winnerFirst ? "first" : "second"})`;
  let how: string;
  if (v.mode === "judge") how = v.decided ? "judge: both orders agreed, it decided" : v.position ? `judge: preferred the change shown ${v.position} in both orders, tie broken by ${v.tieBreak}` : `judge: saw no clear difference, tie broken by ${v.tieBreak}`;
  else if (v.mode === "jury") {
    const j = v.jury!;
    const odd = [j.positional ? `${j.positional} positional` : "", j.late ? `${j.late} late` : "", j.unusable ? `${j.unusable} unusable` : ""].filter(Boolean).join(", ");
    how = v.decided ? `jury of ${j.size}: ${j.votes[0]} consistent votes decided${odd ? ` (${odd})` : ""}` : `jury of ${j.size}: ${j.votes[0] + j.votes[1] === 0 ? "no consistent vote" : `split ${j.votes[0]} to ${j.votes[1]}`}${odd ? ` (${odd})` : ""}, tie broken by ${v.tieBreak}`;
  } else if (v.mode === "none") how = `no model answered, tie broken by ${v.tieBreak}`;
  else how = `decided on deterministic evidence: ${v.text}`;
  return `${head}  ${won}; ${how}; settled in ${secs(r.settleMs ?? 0)} (${r.settledFrom})`;
}

const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((100 * n) / d)}%` : "n/a");
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

async function main(): Promise<void> {
  const tag = `cb${Date.now().toString(36)}`;
  const about = (await rest("GET", "/api/about")).data;
  const flags: string[] = Array.isArray(about?.flags) ? about.flags : [];
  console.log(`contest check ${tag} on ${URL_BASE}: ${CONTESTS} contests in ${COLONY}, review ${REVIEW ? "as the colony has it" : "off"}, flags on: ${flags.join(", ") || "none"}`);
  const made = await rest("POST", "/api/colonies", { name: COLONY, poolTarget: 2 });
  check(`${COLONY}: colony ready (${made.status === 409 ? "exists" : made.status})`, made.status === 201 || made.status === 409);
  if (!REVIEW) check(`${COLONY}: review off for these contests`, (await rest("POST", `${BASE}/decide/policy`, { enabled: false })).status === 200);
  const policy = (await rest("GET", `${BASE}/decide/policy`)).data ?? {};
  console.log(`judge models: ${short(policy.secondOpinionModels, 200)}; jury models: ${short(policy.juryModels ?? "(not on this server)", 200)}`);
  const before = await counters();

  const results: Result[] = [];
  for (let n = 1; n <= CONTESTS; n++) {
    try {
      results.push(await contest(n, tag));
    } catch (e) {
      results.push({ n, intent: "", winner: "?", winnerFirst: null, verdict: null, settleMs: null, settledFrom: null, error: e instanceof Error ? e.message : String(e) });
    }
    console.log(line(results[results.length - 1]!));
    // Past the colony's shared field reading, which may hold the last contest's claims.
    await sleep(500);
  }

  const settled = results.filter((r) => !r.error && r.verdict);
  const times = settled.map((r) => r.settleMs ?? 0);
  console.log("");
  console.log(`settled ${settled.length} of ${CONTESTS}; time to settle: median ${secs(median(times))}, max ${secs(Math.max(0, ...times))}, from the later change ready to the decision`);
  const judged = settled.filter((r) => r.verdict!.mode === "judge");
  if (judged.length > 0) {
    const agreed = judged.filter((r) => r.verdict!.agreed).length;
    const flips = judged.filter((r) => r.verdict!.position !== null);
    const first = flips.filter((r) => r.verdict!.position === "first").length;
    const same = judged.filter((r) => !r.verdict!.decided && r.verdict!.position === null).length;
    console.log(`judge: ${judged.length} contests; orders agreed ${agreed} (${pct(agreed, judged.length)}); disagreed ${flips.length} (${pct(flips.length, judged.length)}: shown first ${first}, shown second ${flips.length - first}); no clear difference ${same}`);
    console.log(`judge ties (the tie-break decided): ${judged.length - agreed} of ${judged.length} (${pct(judged.length - agreed, judged.length)})`);
  }
  const juried = settled.filter((r) => r.verdict!.mode === "jury");
  if (juried.length > 0) {
    const majority = juried.filter((r) => r.verdict!.decided).length;
    const ties = juried.length - majority;
    const sum = (k: "positional" | "late" | "unusable") => juried.reduce((a, r) => a + r.verdict!.jury![k], 0);
    const seats = juried.reduce((a, r) => a + r.verdict!.jury!.size, 0);
    console.log(`jury: ${juried.length} contests; a majority decided ${majority} (${pct(majority, juried.length)}); ties (the tie-break decided) ${ties} (${pct(ties, juried.length)})`);
    console.log(`jury members: ${seats} seated; inconsistent ${sum("positional") + sum("late") + sum("unusable")} (positional ${sum("positional")}, late ${sum("late")}, unusable ${sum("unusable")})`);
  }
  const none = settled.filter((r) => r.verdict!.mode === "none").length;
  const evidence = settled.filter((r) => r.verdict!.mode === "evidence").length;
  if (none > 0) console.log(`no model answered in ${none} contests (the tie-break decided)`);
  if (evidence > 0) console.log(`decided on deterministic evidence before any model in ${evidence} contests (the variants were not equal: look at the reasons above)`);
  const wins = { arrow: settled.filter((r) => r.winner === "arrow").length, func: settled.filter((r) => r.winner === "func").length };
  const firsts = settled.filter((r) => r.winnerFirst).length;
  console.log(`winners: arrow ${wins.arrow}, function ${wins.func}; proposed first ${firsts}, proposed second ${settled.length - firsts}`);

  const after = await counters();
  const d = (k: string) => (after.metrics[k] ?? 0) - (before.metrics[k] ?? 0);
  const tokens = (dir: "In" | "Out") => Object.keys(after.metrics).filter((k) => k.startsWith(`contest.judge.tokens${dir}:`)).reduce((a, k) => a + d(k), 0);
  console.log(`judge layer: ${d("contest.judge.calls")} calls, ${tokens("In")} in / ${tokens("Out")} out tokens, $${(after.judgeUsd - before.judgeUsd).toFixed(4)} (${settled.length > 0 ? `$${((after.judgeUsd - before.judgeUsd) / settled.length).toFixed(4)} a contest` : "no contest settled"})`);
  if (d("contest.jury.majority") + d("contest.jury.ties") > 0) {
    console.log(`jury counters: majority ${d("contest.jury.majority")}, ties ${d("contest.jury.ties")}, consistent votes ${d("contest.jury.consistent")}, inconsistent ${d("contest.jury.inconsistent")}`);
  }
  check(`every contest settled (${settled.length} of ${CONTESTS})`, settled.length === CONTESTS);
  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`contest check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
