#!/usr/bin/env node
/**
 * Trunk writer cost per batch size, measured live. For each size k, k synthetic agents get one
 * intent each in a single fresh region (assigned at creation, so admission does not spread them),
 * take their lease, and propose within a few hundred milliseconds. The lane serves the first
 * proposal at once and the rest as one batch on its next tick, so the second commit's landing
 * time gives the trunk writer's service time for a batch of k - 1 (real commits, real pushes).
 *
 *   node packages/bench/src/scenarios/batchcost.ts --colony bench-w2-load --sizes 10,20,40 --out batchcost.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { Intent, Proposal, WorkspaceLease } from "@fire_trident/core";
import { liveConfig, redact } from "../env.ts";
import { Client, LiveFeed, liveProposal, type LiveState } from "../live.ts";
import { Recorder } from "../stats.ts";

type Assignment = { intent: Intent; lease: WorkspaceLease };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { colony: { type: "string" }, sizes: { type: "string" }, out: { type: "string" }, state: { type: "string" } }, strict: true });
  const colony = values.colony ?? "bench-w2-load";
  const sizes = (values.sizes ?? "10,20,40").split(",").map(Number);
  const state = JSON.parse(readFileSync(`${values.state ?? "/tmp/ft-w2"}/state-${colony}.json`, "utf8")) as LiveState;
  const cfg = liveConfig();
  const rec = new Recorder();
  const client = new Client(cfg, colony, rec);
  const feed = new LiveFeed();
  await feed.connect(cfg, colony);
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  const rows: Array<Record<string, unknown>> = [];
  for (const k of sizes) {
    const tag = `bc${k}-${Date.now().toString(36)}`;
    const region = `bench/${tag}`;
    const agents = await Promise.all(Array.from({ length: k }, (_, i) => client.call<{ id: string }>("register", "POST", "/agents", { name: `bench-batch-${tag}-${i}`, kind: "synthetic" })));
    const ids = agents.map((a) => a?.id).filter((x): x is string => !!x);
    await Promise.all(ids.map((id, i) => client.call<Intent>("intent", "POST", "/intents", { title: `bench: batch ${tag} ${i}`, footprint: [`${region}/f${i}.txt`], assignedTo: id, createdBy: "bench-batch" })));
    const takes = await Promise.all(ids.map((id) => client.call<Assignment | { wait: true }>("take", "POST", `/agents/${id}/take`, {})));
    const ready = ids.map((id, i) => ({ id, t: takes[i] })).filter((x): x is { id: string; t: Assignment } => !!x.t && !("wait" in x.t));
    const before = feed.landings.length;
    const props = await Promise.all(ready.map((x, i) => client.call<Proposal>("propose", "POST", "/proposals", liveProposal(x.id, x.t, state.blob, i))));
    const created = props.filter((p): p is Proposal => !!p).map((p) => ({ id: p.id, createdAt: p.createdAt }));
    const want = new Set(created.map((p) => p.id));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const seen = new Set(feed.landings.slice(before).flatMap((l) => l.proposalIds));
      if ([...want].every((id) => seen.has(id))) break;
      await sleep(500);
    }
    const mine = feed.landings.slice(before).filter((l) => l.proposalIds.some((id) => want.has(id)));
    const t0 = Math.min(...created.map((c) => c.createdAt));
    const spread = Math.max(...created.map((c) => c.createdAt)) - t0;
    const commits = mine.map((l) => ({ landingId: l.id, size: l.proposalIds.filter((id) => want.has(id)).length, atMs: l.at - t0 }));
    rows.push({ k, proposed: created.length, proposeSpreadMs: spread, commits });
    log(`k=${k}: proposed ${created.length} within ${spread} ms; commits ${commits.map((c) => `${c.size}@${c.atMs}ms`).join(", ")}`);
    await sleep(3_000);
  }
  feed.close();
  const doc = { kind: "batchcost", label: "MEASURED", colony, at: new Date().toISOString(), note: "times are ColonyDO receipt of each landing relative to the first proposal's createdAt", rows, errors: rec.errorSamples };
  const out = values.out ?? "batchcost.json";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
