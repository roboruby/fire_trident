#!/usr/bin/env node
/**
 * Text merge's insertion rule, measured live (FT_MERGE_INSERTIONS), and what beat a returned change (movedBy). In each
 * colony two agents take intents on one file from the same trunk, and each appends one export line at the end of it; the
 * second proposes after the first landed.
 * - On a colony FT_MERGE_INSERTIONS lists (--on): both land, the second as the union of the two appends (trunk's line
 *   first), and its lineage note's merged entry says `rule: "insertions"`.
 * - On a colony it does not list (--off): the second goes back naming the conflicting hunk, and the return names what
 *   beat it (movedBy: the first change's landing, intent, agent, model and commit), its reason ending with what to do;
 *   the next take of the reopened intent hands the same back in lastReturn.
 *
 *   FT_URL=https://<deployment> FT_TOKEN=... node packages/bench/src/scenarios/insertions.ts --on <colony> --off <colony> [--review on] [--out insertions.json]
 *
 * The deployment needs FT_INLINE and FT_TEXT_MERGE on for both colonies, and FT_MERGE_INSERTIONS listing --on and not
 * --off. Each colony is created when missing; review is turned off on both unless --review on. Use colonies with no
 * other open intents (new ones are best): the last check takes the reopened intent. Synthetic agents, no model calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { blobId, changesetId, type FileVersion, type Intent, type LineageNote, type MovedBy, type Proposal, type WorkspaceLease } from "@fire_trident/core";
import { liveConfig, redact } from "../env.ts";
import { Client } from "../live.ts";
import { Recorder } from "../stats.ts";

type Assignment = { intent: Intent; lease: WorkspaceLease; lastReturn?: { proposalId: string; movedBy?: MovedBy[] } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["landed", "returned", "rejected"]);
const INSTRUCTION = "Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold.";

let failed = false;
function check(label: string, ok: boolean): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
  return ok;
}
const short = (x: unknown, n = 160): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);

/** The file every pair appends to: twelve export lines, so each append is an insertion at line 13 of its base. */
function seedText(tag: string): string {
  return Array.from({ length: 12 }, (_, i) => `export const v${i + 1} = ${i + 1}; // ${tag}\n`).join("");
}

/** One colony: seed the file, then two appends from the same trunk, the second after the first landed. */
async function pair(client: Client, rec: Recorder, tag: string, review: boolean) {
  const colony = client.colony;
  const path = `insertions/${tag}/values.ts`;
  const made = await client.call<{ id: string }>("colony", "POST", "/colonies", { name: colony, poolTarget: 2 });
  const exists = made !== null || (await client.call<unknown>("status", "GET", "")) !== null;
  if (!exists) throw new Error(`colony ${colony} could not be created or read: ${rec.errorSamples.join("; ")}`);
  if (!review) check(`${colony}: review off for this check`, (await client.call<unknown>("policy", "POST", "/decide/policy", { enabled: false })) !== null);

  const agent = async (name: string): Promise<string> => {
    const a = await client.call<{ id: string }>("register", "POST", "/agents", { name: `insertions-${tag}-${name}`, kind: "synthetic", model: `insertions-check-${name}` });
    if (!a?.id) throw new Error(`register ${name} in ${colony} failed: ${rec.errorSamples.join("; ")}`);
    return a.id;
  };
  const intentFor = async (agentId: string, title: string, why: string): Promise<string> => {
    const i = await client.call<Intent>("intent", "POST", "/intents", { title, why, footprint: [path], assignedTo: agentId, createdBy: "insertions" });
    if (!i?.id) throw new Error(`intent in ${colony} failed: ${rec.errorSamples.join("; ")}`);
    return i.id;
  };
  const take = async (agentId: string): Promise<Assignment> => {
    for (let i = 0; i < 30; i++) {
      const t = await client.call<Assignment | { wait: true; retryInMs: number; reason: string }>("take", "POST", `/agents/${agentId}/take`, {});
      if (t && !("wait" in t)) return t;
      await sleep(Math.min(2_000, t && "wait" in t ? t.retryInMs : 1_000));
    }
    throw new Error(`${agentId} got no assignment in ${colony}`);
  };
  const propose = async (agentId: string, a: Assignment, read: string | null, text: string, summary: string): Promise<Proposal> => {
    const writeSet: FileVersion[] = [{ path, blob: blobId(text) }];
    const p = await client.call<Proposal>("propose", "POST", "/proposals", {
      intentId: a.intent.id,
      agentId,
      workspace: a.lease.repo,
      baseSha: a.lease.baseSha,
      headSha: changesetId(a.lease.baseSha, writeSet),
      writeSet,
      readSet: read === null ? [] : [{ path, blob: blobId(read) }],
      contents: { [writeSet[0]!.blob!]: text },
      declared: { footprint: [path], summary },
      evidence: { checks: [], notVerified: "Not verified: a scripted append of one line; no tests run." },
    });
    if (!p?.id) throw new Error(`propose in ${colony} failed: ${rec.errorSamples.join("; ")}`);
    return p;
  };
  const settle = async (p: Proposal): Promise<Proposal> => {
    for (let i = 0; i < 240; i++) {
      const now = await client.call<Proposal>("proposal", "GET", `/proposals/${p.id}`);
      if (now && TERMINAL.has(now.status)) return now;
      await sleep(500);
    }
    throw new Error(`proposal ${p.id} in ${colony} did not settle`);
  };

  // The file, seeded by an inline change.
  const seed = seedText(tag);
  const seeder = await agent("seed");
  await intentFor(seeder, `insertions ${tag}: create ${path}`, "The file the insertion check appends to.");
  const s = await settle(await propose(seeder, await take(seeder), null, seed, "seed the file"));
  if (s.status !== "landed") throw new Error(`${colony}: the seed did not land: ${s.status} ${short(s.reason)}`);

  // Two appends from the same trunk.
  const [a, b] = [await agent("a"), await agent("b")];
  const aIntent = await intentFor(a, `insertions ${tag}: export a`, "Callers need a.");
  const bIntent = await intentFor(b, `insertions ${tag}: export b`, "Callers need b.");
  const [ta, tb] = [await take(a), await take(b)];
  const lineA = `export const a_${tag} = "a";\n`;
  const lineB = `export const b_${tag} = "b";\n`;
  const pa = await settle(await propose(a, ta, seed, seed + lineA, "append a"));
  check(`${colony}: the first append landed (${pa.status})`, pa.status === "landed");
  const pb = await settle(await propose(b, tb, seed, seed + lineB, "append b"));
  return { path, seed, lineA, lineB, a, b, aIntent, bIntent, pa, pb, take };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { on: { type: "string" }, off: { type: "string" }, review: { type: "string" }, out: { type: "string" } }, strict: true });
  const on = values.on ?? "";
  const off = values.off ?? "";
  if (!on || !off || on === off) {
    console.error("usage: FT_URL=... FT_TOKEN=... node packages/bench/src/scenarios/insertions.ts --on <colony FT_MERGE_INSERTIONS lists> --off <another colony> [--review on] [--out insertions.json]");
    process.exit(2);
  }
  const review = values.review === "on";
  const cfg = liveConfig();
  const tag = `in${Date.now().toString(36)}`;
  console.log(`insertion rule check ${tag} on ${cfg.url} (on: ${on}, off: ${off}, review ${review ? "as each colony has it" : "off"})`);

  // On: both appends land, the second as their union, its note naming the rule.
  const recOn = new Recorder();
  const withRule = await pair(new Client(cfg, on, recOn), recOn, tag, review);
  check(`${on}: the second append landed too (${withRule.pb.status}${withRule.pb.reason ? `: ${short(withRule.pb.reason)}` : ""})`, withRule.pb.status === "landed");
  const both = withRule.seed + withRule.lineA + withRule.lineB;
  const why = await new Client(cfg, on, recOn).call<Array<{ landing: { id: string; merged?: Array<{ proposalId: string; rule?: string }> }; note: LineageNote }>>("why", "GET", `/why?path=${encodeURIComponent(withRule.path)}`);
  const entry = (why ?? []).flatMap((w) => w.note.proposals).find((x) => x.id === withRule.pb.id);
  const merged = entry?.merged ?? [];
  check(`${on}: its lineage note records the merge by the insertion rule (${short(merged)})`, merged.length === 1 && merged[0]?.rule === "insertions");
  check(`${on}: the merged file is the seed with both appends, the first landing's line first`, merged[0]?.result === blobId(both));
  const landing = (why ?? []).find((w) => w.landing.id === withRule.pb.landingId)?.landing;
  check(`${on}: the landing's merged entry names the rule (${short(landing?.merged)})`, landing?.merged?.some((m) => m.proposalId === withRule.pb.id && m.rule === "insertions") === true);

  // Off: the second append goes back naming the hunk, and the return names what beat it.
  const recOff = new Recorder();
  const without = await pair(new Client(cfg, off, recOff), recOff, tag, review);
  const reason = without.pb.reason ?? "";
  check(`${off}: the second append went back naming the hunk (${short(reason, 200)})`, without.pb.status === "returned" && reason.includes(`text merge of ${without.path}: 1 conflicting hunk, at line 13 of its base`));
  const moved = without.pb.movedBy ?? [];
  check(
    `${off}: the return names the landing that beat it, with its intent, agent, model and commit (${short(moved, 300)})`,
    moved.length === 1 &&
      moved[0]?.landingId === without.pa.landingId &&
      moved[0]?.intentId === without.aIntent &&
      moved[0]?.agentId === without.a &&
      moved[0]?.model === "insertions-check-a" &&
      moved[0]?.title === `insertions ${tag}: export a` &&
      typeof moved[0]?.trunkSha === "string" &&
      (moved[0]?.paths ?? []).includes(without.path),
  );
  check(`${off}: its reason names that landing and ends with what to do`, reason.includes(`Landing ${without.pa.landingId} (`) && reason.endsWith(INSTRUCTION));
  await sleep(3_000);
  const again = await without.take(without.b);
  check(
    `${off}: the next take of the reopened intent hands back lastReturn with movedBy (${short(again.lastReturn?.movedBy, 200)})`,
    again.intent.id === without.bIntent && again.lastReturn?.proposalId === without.pb.id && again.lastReturn?.movedBy?.[0]?.landingId === without.pa.landingId,
  );

  const doc = {
    kind: "insertions",
    label: "MEASURED",
    at: new Date().toISOString(),
    note: "synthetic agents with inline changes; in each colony two agents take intents on one file from the same trunk, each appends one export line, the second proposes after the first landed",
    on: { colony: on, path: withRule.path, a: { id: withRule.pa.id, status: withRule.pa.status, landingId: withRule.pa.landingId ?? null }, b: { id: withRule.pb.id, status: withRule.pb.status, landingId: withRule.pb.landingId ?? null }, merged, resultIsBothAppends: merged[0]?.result === blobId(both) },
    off: { colony: off, path: without.path, a: { id: without.pa.id, status: without.pa.status, landingId: without.pa.landingId ?? null }, b: { id: without.pb.id, status: without.pb.status, reason, movedBy: moved }, nextTakeLastReturn: again.lastReturn ?? null },
    errors: [...recOn.errorSamples, ...recOff.errorSamples],
    passed: !failed,
  };
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`wrote ${values.out}`);
  }
  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(redact(`insertion rule check failed: ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
