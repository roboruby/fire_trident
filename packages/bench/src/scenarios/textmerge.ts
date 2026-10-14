#!/usr/bin/env node
/**
 * Text merge, measured live (FT_TEXT_MERGE): agents take intents on one file from the same trunk and propose inline
 * changes one after the other. With text merge on for the colony, a change that edits other lines than the one that
 * landed first lands too, and its lineage note records the merge; with it off, it goes back stale. A pair that edits the
 * same line always ends with one landing and one going back, naming the conflict.
 *
 *   FT_URL=https://<deployment> FT_TOKEN=... node packages/bench/src/scenarios/textmerge.ts --colony <id> --out textmerge.json
 *
 * The colony must take inline changes (FT_INLINE). Synthetic agents, no model calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { blobId, changesetId, type FileVersion, type Intent, type LineageNote, type Proposal, type WorkspaceLease } from "@fire_trident/core";
import { liveConfig, redact } from "../env.ts";
import { Client } from "../live.ts";
import { Recorder } from "../stats.ts";

type Assignment = { intent: Intent; lease: WorkspaceLease };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["landed", "returned", "rejected"]);

/** The file every pair edits: twelve lines, so edits to lines 2 and 11 are far apart. */
function seedText(tag: string): string {
  return Array.from({ length: 12 }, (_, i) => `export const v${i + 1} = ${i + 1}; // ${tag}`).join("\n") + "\n";
}

/** `text` with line `n` (1-based) replaced. */
function editLine(text: string, n: number, line: string): string {
  const lines = text.split("\n");
  lines[n - 1] = line;
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { colony: { type: "string" }, out: { type: "string" } }, strict: true });
  const colony = values.colony ?? "textmerge";
  const cfg = liveConfig();
  const rec = new Recorder();
  const client = new Client(cfg, colony, rec);
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  const tag = `tm${Date.now().toString(36)}`;
  const path = `merge/${tag}/values.ts`;

  const agent = async (name: string): Promise<string> => {
    const a = await client.call<{ id: string }>("register", "POST", "/agents", { name: `textmerge-${tag}-${name}`, kind: "synthetic" });
    if (!a?.id) throw new Error(`register ${name} failed: ${rec.errorSamples.join("; ")}`);
    return a.id;
  };
  const intentFor = async (agentId: string, title: string): Promise<void> => {
    const i = await client.call<Intent>("intent", "POST", "/intents", { title, footprint: [path], assignedTo: agentId, createdBy: "textmerge" });
    if (!i?.id) throw new Error(`intent for ${agentId} failed: ${rec.errorSamples.join("; ")}`);
  };
  const take = async (agentId: string): Promise<Assignment> => {
    for (let i = 0; i < 30; i++) {
      const t = await client.call<Assignment | { wait: true; retryInMs: number; reason: string }>("take", "POST", `/agents/${agentId}/take`, {});
      if (t && !("wait" in t)) return t;
      await sleep(Math.min(2_000, t && "wait" in t ? t.retryInMs : 1_000));
    }
    throw new Error(`${agentId} got no assignment`);
  };
  const propose = async (agentId: string, a: Assignment, base: { text: string | null }, text: string, summary: string): Promise<Proposal> => {
    const writeSet: FileVersion[] = [{ path, blob: blobId(text) }];
    const readSet: FileVersion[] = base.text === null ? [] : [{ path, blob: blobId(base.text) }];
    const p = await client.call<Proposal>("propose", "POST", "/proposals", {
      intentId: a.intent.id,
      agentId,
      workspace: a.lease.repo,
      baseSha: a.lease.baseSha,
      headSha: changesetId(a.lease.baseSha, writeSet),
      writeSet,
      readSet,
      contents: { [writeSet[0]!.blob!]: text },
      declared: { footprint: [path], summary },
      evidence: { checks: [], notVerified: "synthetic text-merge scenario: no tests run" },
    });
    if (!p?.id) throw new Error(`propose by ${agentId} failed: ${rec.errorSamples.join("; ")}`);
    return p;
  };
  const settle = async (p: Proposal): Promise<Proposal> => {
    for (let i = 0; i < 240; i++) {
      const now = await client.call<Proposal>("proposal", "GET", `/proposals/${p.id}`);
      if (now && TERMINAL.has(now.status)) return now;
      await sleep(500);
    }
    throw new Error(`proposal ${p.id} did not settle`);
  };
  const outcome = (p: Proposal) => ({ id: p.id, status: p.status, landingId: p.landingId ?? null, reason: p.reason ?? null });

  // 1. Seed the file through an inline change.
  const seed = seedText(tag);
  const seeder = await agent("seed");
  await intentFor(seeder, `textmerge ${tag}: create ${path}`);
  const s = await settle(await propose(seeder, await take(seeder), { text: null }, seed, "seed the file"));
  if (s.status !== "landed") throw new Error(`seed did not land: ${s.status} ${s.reason ?? ""}`);
  log(`seeded ${path} in ${s.landingId}`);

  // 2. Disjoint edits from one trunk: line 2 lands first, then line 11, built on the trunk before it.
  const [a, b] = [await agent("a"), await agent("b")];
  await intentFor(a, `textmerge ${tag}: change v2`);
  await intentFor(b, `textmerge ${tag}: change v11`);
  const [ta, tb] = [await take(a), await take(b)];
  const textA = editLine(seed, 2, `export const v2 = 20; // ${tag}`);
  const textB = editLine(seed, 11, `export const v11 = 110; // ${tag}`);
  const pa = await settle(await propose(a, ta, { text: seed }, textA, "v2 = 20"));
  const pb = await settle(await propose(b, tb, { text: seed }, textB, "v11 = 110"));
  const both = editLine(textA, 11, `export const v11 = 110; // ${tag}`);
  log(`disjoint pair: a ${pa.status}, b ${pb.status}${pb.reason ? ` (${pb.reason.slice(0, 120)})` : ""}`);

  // 3. The same line, edited two ways from one trunk: the first lands, the second goes back naming the conflict.
  const current = pb.status === "landed" ? both : textA;
  const [c, d] = [await agent("c"), await agent("d")];
  await intentFor(c, `textmerge ${tag}: change v6 one way`);
  await intentFor(d, `textmerge ${tag}: change v6 another way`);
  const [tc, td] = [await take(c), await take(d)];
  const pc = await settle(await propose(c, tc, { text: current }, editLine(current, 6, `export const v6 = 60; // ${tag}`), "v6 = 60"));
  const pd = await settle(await propose(d, td, { text: current }, editLine(current, 6, `export const v6 = 66; // ${tag}`), "v6 = 66"));
  log(`same-line pair: c ${pc.status}, d ${pd.status}${pd.reason ? ` (${pd.reason.slice(0, 120)})` : ""}`);

  // 4. What the lineage says about b: the merge it records, and whether its result is the text with both edits.
  const why = await client.call<Array<{ note: LineageNote }>>("why", "GET", `/why?path=${encodeURIComponent(path)}`);
  const entry = (why ?? []).flatMap((w) => w.note.proposals).find((x) => x.id === pb.id) as (LineageNote["proposals"][number] & { merged?: Array<{ path: string; result: string }> }) | undefined;
  const merged = entry?.merged ?? [];
  const doc = {
    kind: "textmerge",
    label: "MEASURED",
    colony,
    at: new Date().toISOString(),
    path,
    note: "synthetic agents with inline changes; each pair takes its intents from the same trunk and proposes one after the other",
    disjoint: { a: outcome(pa), b: outcome(pb), merged, resultIsBothEdits: merged.some((m) => m.result === blobId(both)) },
    sameLine: { c: outcome(pc), d: outcome(pd) },
    errors: rec.errorSamples,
  };
  const out = values.out ?? "textmerge.json";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
