#!/usr/bin/env node
/**
 * Criticality demo (the seizure detector), live.
 *
 * 1. N reader agents take intents in one region; each reads a shared file S at its current blob
 *    and will write its own new file in the same region (so their lane is S's lane).
 * 2. A writer agent lands a REAL edit to S (git clone of trunk with the lease's read token, edit,
 *    commit, push to its workspace fork with the workspace token, propose).
 * 3. The readers, still in flight, propose: every one read S's old blob, so the lane returns all
 *    of them as stale, and RegionDO attributes each return to the writer's landing. One landing,
 *    N children: sigma jumps to about N and the lane's cadence is multiplied by inhibitionFactor.
 * 4. Each reader re-reads S and re-proposes after a rework time; the inhibited lane lands them in
 *    batches, every re-landing is a parent with no children, and sigma falls back below 1, then to 0
 *    once the writer's landing leaves the 60 s window.
 *
 * Records every sigma and inhibition event from /api/colonies/:id/live and polls
 * /api/colonies/:id/field?region= every second as a second source.
 *
 *   node packages/bench/src/scenarios/cascade.ts --colony bench-w2-cascade --readers 30 --out cascade.json
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import type { FieldReading, Intent, Proposal, WorkspaceLease } from "@fire_trident/core";
import { liveConfig, redact } from "../env.ts";
import { Client, LiveFeed, git, setup } from "../live.ts";
import { fakeSha } from "../swarm.ts";
import { Recorder } from "../stats.ts";

type Assignment = { intent: Intent; lease: WorkspaceLease };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      colony: { type: "string" },
      readers: { type: "string" },
      shared: { type: "string" },
      "rework-min": { type: "string" },
      "rework-max": { type: "string" },
      observe: { type: "string" },
      out: { type: "string" },
      state: { type: "string" },
    },
    strict: true,
  });
  const colony = values.colony ?? "bench-w2-cascade";
  const n = Number(values.readers ?? 30);
  const shared = values.shared ?? "src/core/config.ts";
  const reworkMin = Number(values["rework-min"] ?? 5) * 1000;
  const reworkMax = Number(values["rework-max"] ?? 30) * 1000;
  const observeMs = Number(values.observe ?? 90) * 1000;
  const stateDir = values.state ?? "/tmp/ft-w2";
  const cfg = liveConfig();
  const rec = new Recorder();
  const client = new Client(cfg, colony, rec);
  const T0 = Date.now();
  const timeline: Array<{ tMs: number; event: string; detail?: unknown }> = [];
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  const mark = (event: string, detail?: unknown) => {
    timeline.push({ tMs: Date.now() - T0, event, ...(detail !== undefined ? { detail } : {}) });
    log(`${event}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 160)}` : ""}`);
  };

  const state = await setup(cfg, colony, stateDir, log);
  const region = shared.split("/").slice(0, -1).slice(0, 3).join("/") || ".";
  const feed = new LiveFeed();
  await feed.connect(cfg, colony);
  mark("feed", { connected: feed.open, region, shared });

  // Second source: poll the region's field reading (sigma) every second.
  const polled: Array<{ tMs: number; sigma: number; landingsPerMin: number; activeAgents: number }> = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const r = await client.call<FieldReading[]>("field", "GET", `/field?region=${encodeURIComponent(region)}`);
      const f = r?.[0];
      if (f) polled.push({ tMs: Date.now() - T0, sigma: f.sigma, landingsPerMin: f.admission.landingsPerMin, activeAgents: f.admission.activeAgents });
      await sleep(1_000);
    }
  })();

  // 1. Readers take work in the region (assigned at creation, so admission does not spread them).
  const tag = Date.now().toString(36);
  const regs = await Promise.all(Array.from({ length: n }, (_, i) => client.call<{ id: string }>("register", "POST", "/agents", { name: `cascade-reader-${tag}-${i + 1}`, kind: "synthetic" })));
  const readerIds = regs.map((r) => r?.id).filter((x): x is string => !!x);
  const writerReg = await client.call<{ id: string }>("register", "POST", "/agents", { name: `cascade-writer-${tag}`, kind: "synthetic" });
  if (!writerReg) throw new Error(`writer register failed: ${rec.errorSamples.join("; ")}`);
  await Promise.all(
    readerIds.map((id, i) =>
      client.call<Intent>("intent", "POST", "/intents", {
        title: `cascade: reader ${i + 1} adds ${region}/cascade-${tag}-r${i + 1}.txt`,
        why: `uses ${shared}`,
        footprint: [`${region}/cascade-${tag}-r${i + 1}.txt`],
        assignedTo: id,
        createdBy: "bench-cascade",
      }),
    ),
  );
  const takes = await Promise.all(readerIds.map((id) => client.call<Assignment | { wait: true; reason: string }>("take", "POST", `/agents/${id}/take`, {})));
  const readers = readerIds.map((id, i) => ({ id, t: takes[i] })).filter((x): x is { id: string; t: Assignment } => !!x.t && !("wait" in x.t));
  mark("readers took work", { readers: readers.length, of: readerIds.length });

  // 2. The writer clones trunk, edits S for real, pushes to its workspace, and proposes.
  const wIntent = await client.call<Intent>("intent", "POST", "/intents", { title: `cascade: change ${shared}`, why: "a shared configuration change", footprint: [shared], assignedTo: writerReg.id, priority: 5, createdBy: "bench-cascade" });
  const wt = await client.call<Assignment | { wait: true; reason: string }>("take", "POST", `/agents/${writerReg.id}/take`, {});
  if (!wIntent || !wt || "wait" in wt) throw new Error(`writer take failed: ${JSON.stringify(wt)}`);
  const dir = join(stateDir, `cascade-${tag}`);
  await run("rm", ["-rf", dir]);
  mkdirSync(dirname(dir), { recursive: true });
  await git(["clone", "--quiet", "--depth", "1", "--branch", "main", wt.lease.trunk.remote, dir], wt.lease.trunk.token);
  const oldBlob = (await git(["rev-parse", `HEAD:${shared}`], wt.lease.trunk.token, dir)).trim();
  appendFileSync(join(dir, shared), `\n// FireTrident cascade demo ${new Date().toISOString()}: shared configuration changed.\n`);
  await git(["-c", "user.name=FireTrident bench", "-c", "user.email=bench@agents.firetrident.dev", "commit", "-qam", `cascade: change ${shared}\n\nFT-Intent: ${wIntent.id}`], wt.lease.trunk.token, dir);
  const headSha = (await git(["rev-parse", "HEAD"], wt.lease.trunk.token, dir)).trim();
  const newBlob = (await git(["rev-parse", `HEAD:${shared}`], wt.lease.trunk.token, dir)).trim();
  await git(["push", "--quiet", "--force", wt.lease.repo.remote, "HEAD:refs/heads/main"], wt.lease.token, dir);
  mark("writer pushed its workspace", { oldBlob: oldBlob.slice(0, 10), newBlob: newBlob.slice(0, 10) });

  // Readers read S at its current (old) blob: that is their read set.
  const readSet = [{ path: shared, blob: oldBlob }];
  const body = (agentId: string, a: Assignment, reads: Array<{ path: string; blob: string }>, seq: number) => ({
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha("cascade", agentId, String(seq)),
    writeSet: [{ path: a.intent.footprint[0]!, blob: state.blob }],
    readSet: reads,
    declared: { footprint: a.intent.footprint, summary: `reader change that depends on ${shared}` },
    evidence: { checks: [], notVerified: "synthetic cascade reader (no model, no agent-side git)" },
  });

  const wp = await client.call<Proposal>("propose", "POST", "/proposals", {
    intentId: wIntent.id,
    agentId: writerReg.id,
    workspace: wt.lease.repo,
    baseSha: wt.lease.baseSha,
    headSha,
    writeSet: [{ path: shared, blob: newBlob }],
    readSet: [{ path: shared, blob: oldBlob }],
    declared: { footprint: [shared], summary: `change ${shared}` },
    evidence: { checks: [], notVerified: "cascade demo writer: a one-line comment appended" },
  });
  if (!wp) throw new Error(`writer propose failed: ${rec.errorSamples.join("; ")}`);
  mark("writer proposed", { proposal: wp.id });
  const landedBy = Date.now() + 60_000;
  let writerLanding: { id: string; at: number } | null = null;
  while (Date.now() < landedBy && !writerLanding) {
    const l = feed.landings.find((x) => x.proposalIds.includes(wp.id));
    if (l) writerLanding = { id: l.id, at: l.at };
    else await sleep(100);
  }
  if (!writerLanding) throw new Error("writer did not land within 60 s");
  mark("writer landed", { landing: writerLanding.id });

  // 3. The readers were in flight: they propose now, against the blob they read.
  const first = await Promise.all(readers.map((r, i) => client.call<Proposal>("propose", "POST", "/proposals", body(r.id, r.t, readSet, i))));
  const firstIds = new Map(first.map((p, i) => [p?.id ?? "", readers[i]!]));
  mark("readers proposed", { proposals: first.filter(Boolean).length });

  // 4. Each reader learns it was returned (stale on S), re-reads S, reworks, and re-proposes.
  const returnedAt = new Map<string, number>();
  const reproposed: Array<Promise<unknown>> = [];
  const until = Date.now() + 60_000;
  while (Date.now() < until && returnedAt.size < firstIds.size) {
    for (const [pid, r] of firstIds) {
      if (!pid || returnedAt.has(pid)) continue;
      const st = feed.proposalStatus.get(pid);
      if (st?.status === "returned") {
        returnedAt.set(pid, Date.now() - T0);
        const delay = reworkMin + Math.random() * (reworkMax - reworkMin);
        reproposed.push(
          sleep(delay).then(() => client.call<Proposal>("propose", "POST", "/proposals", body(r.id, r.t, [{ path: shared, blob: newBlob }], 1000 + readers.indexOf(r)))),
        );
      } else if (st?.status === "landed") {
        returnedAt.set(pid, -1);
      }
    }
    await sleep(100);
  }
  const returnedCount = [...returnedAt.values()].filter((v) => v >= 0).length;
  mark("readers returned", { returned: returnedCount, landedInstead: returnedAt.size - returnedCount, reasons: [...new Set([...firstIds.keys()].map((id) => feed.proposalStatus.get(id)?.reason?.slice(0, 80)))].slice(0, 3) });
  const second = (await Promise.all(reproposed)) as Array<Proposal | null>;
  mark("readers re-proposed after rework", { proposals: second.filter(Boolean).length });

  // Observe until sigma has settled (the writer's landing leaves the 60 s window).
  const stopAt = Math.max(Date.now() + 15_000, writerLanding.at + observeMs);
  while (Date.now() < stopAt) await sleep(1_000);
  polling = false;
  await poller;
  feed.close();

  const regionSigma = feed.sigma.filter((s) => s.region === region).map((s) => ({ tMs: s.at - T0, sigma: s.sigma }));
  const inhibition = feed.metrics.filter((m) => m.name === `inhibition:${region}`).map((m) => ({ tMs: m.at - T0, factor: m.value }));
  const laneDelay = feed.metrics.filter((m) => m.name === `laneDelayMs:${region}`).map((m) => ({ tMs: m.at - T0, ms: m.value }));
  const secondIds = new Set(second.filter((p): p is Proposal => !!p).map((p) => p.id));
  const relandings = feed.landings.filter((l) => l.proposalIds.some((id) => secondIds.has(id))).map((l) => ({ tMs: l.at - T0, landed: l.proposalIds.filter((id) => secondIds.has(id)).length }));
  const sigmaMax = Math.max(0, ...regionSigma.map((s) => s.sigma), ...polled.map((p) => p.sigma));
  const above = regionSigma.filter((s) => s.sigma > 1);
  const doc = {
    kind: "cascade",
    label: "MEASURED",
    colony,
    region,
    shared,
    readers: readers.length,
    startedAt: new Date(T0).toISOString(),
    writerLanding: { id: writerLanding.id, tMs: writerLanding.at - T0 },
    returned: returnedCount,
    relandings,
    sigma: { max: sigmaMax, firstAboveOneMs: above[0]?.tMs ?? null, lastAboveOneMs: above[above.length - 1]?.tMs ?? null, events: regionSigma, polled },
    inhibition,
    laneDelay,
    timeline,
    errors: rec.errorSamples,
    note: "Readers are synthetic API agents (their writes reuse an existing blob); the writer's change to the shared file is a real git commit pushed to its workspace fork and landed on trunk.",
  };
  const out = values.out ?? "cascade.json";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  log(`sigma max ${sigmaMax.toFixed(2)}; above 1 from ${doc.sigma.firstAboveOneMs} to ${doc.sigma.lastAboveOneMs} ms; inhibition events ${inhibition.length}; re-landing commits ${relandings.length}; wrote ${out}`);
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
