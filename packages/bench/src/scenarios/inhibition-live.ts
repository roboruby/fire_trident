#!/usr/bin/env node
/**
 * Live check of lateral inhibition (MEASURED on a deployment): an open intent whose own files
 * another agent holds a live claim on is skipped, and taken once that claim lands or decays.
 *
 * Two intents share a file: X writes [shared, a] (priority 5), Y writes [shared, b] (priority 4).
 * Agent A takes X (the higher stimulus). Without lateral inhibition A's claim only repels Y
 * softly (stimulus 4 - 1 = 3, accepted with p = 0.9 by a fresh agent), so B would usually take Y.
 * Three colonies run at once:
 *  - rounds: per round a fresh A takes X and a fresh B takes once; both stop (X and Y reopen).
 *  - landing: A takes X, B is turned away, A's proposal lands (a real trunk commit), B takes Y.
 *  - decay: A takes X and goes silent (no heartbeats); B retries every --poll seconds. A claim
 *    decays with tau = 5 min, so B should get Y about one half-life (208 s) after A's claim.
 *
 *   FT_URL=https://<preview> node packages/bench/src/scenarios/inhibition-live.ts --rounds 10 --out live-inhibition.json
 *
 * Colonies are deleted at the end unless --keep (DELETE needs the server's admin token).
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Colony, Intent, Proposal, WorkspaceLease } from "@fire_trident/core";
import { liveConfig, type LiveConfig } from "../env.ts";
import { Client, liveProposal, setup } from "../live.ts";
import { Recorder } from "../stats.ts";

type Take = { intent: Intent; lease: WorkspaceLease } | { wait: true; retryInMs: number; reason: string };

const INHIBITED = "every open intent's files are claimed by another agent";
/** ColonyDO overlays claims younger than 10 s on readings; rounds of one colony are spaced past it. */
const ROUND_GAP_MS = 11_000;
const HALF_LIFE_S = 300 * Math.LN2;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
/** B's take relative to A's: turned away by inhibition, took the other intent (the one sharing A's file), or anything else. */
const outcome = (t: Take | null, other: string): string =>
  !t ? "error" : "wait" in t ? (t.reason === INHIBITED ? "inhibited" : `wait: ${t.reason}`) : t.intent.id === other ? "took the other" : `took ${t.intent.id}`;
/** A takes first: usually X (p = 25/26), sometimes Y; either way B's target is the other one. */
const firstTake = (t: Take | null, ids: { x: string; y: string }): { first: string; other: string; lease: Extract<Take, { intent: Intent }> } | null =>
  t && !("wait" in t) && (t.intent.id === ids.x || t.intent.id === ids.y) ? { first: t.intent.id, other: t.intent.id === ids.x ? ids.y : ids.x, lease: t } : null;

async function newColony(cfg: LiveConfig, rec: Recorder, name: string, log: (s: string) => void): Promise<{ id: string; client: Client; createMs: number }> {
  const admin = new Client(cfg, "", rec, 600_000);
  const t0 = performance.now();
  const colony = await admin.call<Colony>("createColony", "POST", "/colonies", { name, regionDepth: 1, pool: 4 });
  if (!colony) throw new Error(`could not create colony ${name}: ${rec.errorSamples.at(-1) ?? "no response"}`);
  const createMs = Math.round(performance.now() - t0);
  log(`colony ${colony.id} ready in ${createMs} ms`);
  return { id: colony.id, client: new Client(cfg, colony.id, rec), createMs };
}

async function pair(c: Client, tag: string, n: string): Promise<{ x: string; y: string }> {
  const mk = async (paths: string[], priority: number) => {
    const i = await c.call<Intent>("intent", "POST", "/intents", { title: `Edit ${paths.join(" and ")}`, why: "lateral inhibition check", footprint: paths, priority });
    if (!i) throw new Error(`could not add intent ${paths.join(",")}`);
    return i.id;
  };
  // Plain-text files: the landing arm writes an existing trunk blob (the README) to X's first path,
  // which the decide checks accept for a .txt file (a .ts file with README content gets returned).
  const shared = `src/${tag}/shared${n}.txt`;
  return { x: await mk([shared, `src/${tag}/a${n}.txt`], 5), y: await mk([shared, `src/${tag}/b${n}.txt`], 4) };
}

async function agent(c: Client, name: string): Promise<string> {
  const a = await c.call<{ id: string }>("agent", "POST", "/agents", { name, kind: "synthetic" });
  if (!a) throw new Error(`could not register ${name}`);
  return a.id;
}

/** A take, retried while the pool is still seeding workspaces. */
async function take(c: Client, agentId: string): Promise<Take | null> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const t = await c.call<Take>("take", "POST", `/agents/${agentId}/take`, {});
    if (!t || !("wait" in t) || !/pool|lease/i.test(t.reason) || Date.now() > deadline) return t;
    await sleep(t.retryInMs);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string" },
      rounds: { type: "string" },
      poll: { type: "string" },
      out: { type: "string" },
      keep: { type: "boolean" },
      prefix: { type: "string" },
    },
    strict: true,
  });
  const cfg = liveConfig(values.url ? { ...process.env, FT_URL: values.url } : process.env);
  const rounds = Number(values.rounds ?? 10);
  const pollS = Number(values.poll ?? 10);
  const prefix = values.prefix ?? `g5-inhibit-${Date.now().toString(36)}`;
  const rec = new Recorder();
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  const colonies: string[] = [];

  // Rounds: is the other intent skipped while A's claim is live? (fresh agents each round)
  const roundsArm = async () => {
    const col = await newColony(cfg, rec, `${prefix}-rounds`, log);
    colonies.push(col.id);
    const ids = await pair(col.client, "r", "");
    const outcomes: string[] = [];
    let aTookY = 0;
    let last = 0;
    for (let r = 1; r <= rounds; r++) {
      await sleep(last + ROUND_GAP_MS - Date.now());
      const a = await agent(col.client, `a${r}`);
      const b = await agent(col.client, `b${r}`);
      const ta = await take(col.client, a);
      const fa = firstTake(ta, ids);
      let o: string;
      if (!fa) o = `invalid (A: ${ta && "wait" in ta ? ta.reason : "error"})`;
      else {
        if (fa.first === ids.y) aTookY++;
        o = outcome(await take(col.client, b), fa.other);
      }
      outcomes.push(o);
      last = Date.now();
      await Promise.all([a, b].map((g) => col.client.call("stop", "POST", `/agents/${g}/stop`, { reason: "round over" })));
      log(`rounds ${r}/${rounds}: B -> ${o}`);
    }
    return { colony: col.id, createMs: col.createMs, intents: ids, rounds: outcomes.length, inhibited: outcomes.filter((o) => o === "inhibited").length, tookOther: outcomes.filter((o) => o === "took the other").length, aTookY, outcomes };
  };

  // Landing: B is turned away until A's proposal lands (a real trunk commit), then takes the other intent.
  const landingArm = async () => {
    const col = await newColony(cfg, rec, `${prefix}-landing`, log);
    colonies.push(col.id);
    const state = await setup(cfg, col.id, join(tmpdir(), "ft-g5-live"), log);
    log(`landing: probe landed in ${state.probe.ms} ms; blob ${state.blob.slice(0, 10)}`);
    const ids = await pair(col.client, "l", "");
    const [a, b] = [await agent(col.client, "a"), await agent(col.client, "b")];
    const ta = await take(col.client, a);
    const fa = firstTake(ta, ids);
    if (!fa) throw new Error(`landing: A got no assignment (${ta && "wait" in ta ? ta.reason : "error"})`);
    const before = outcome(await take(col.client, b), fa.other);
    // Write every file of the footprint: the decide checks return a change that skips a declared file.
    const body = { ...liveProposal(a, fa.lease, state.blob, 1), writeSet: fa.lease.intent.footprint.map((path) => ({ path, blob: state.blob })) };
    const p = await col.client.call<Proposal>("propose", "POST", "/proposals", body);
    if (!p) throw new Error(`landing: propose failed: ${rec.errorSamples.at(-1)}`);
    await sleep(300);
    const whileQueued = outcome(await take(col.client, b), fa.other);
    let status: string = p.status;
    let reason: string | undefined;
    const t0 = performance.now();
    while (!["landed", "returned", "rejected"].includes(status) && performance.now() - t0 < 120_000) {
      await sleep(1_000);
      const q = await col.client.call<Proposal>("poll", "GET", `/proposals/${p.id}`);
      status = q?.status ?? status;
      reason = q?.reason;
    }
    const outcomeAfterMs = Math.round(performance.now() - t0);
    await sleep(300); // past the colony's 250 ms reading cache
    const t1 = performance.now();
    const after = outcome(await take(col.client, b), fa.other);
    log(`landing: B before ${before}, while queued ${whileQueued}, proposal ${status} after ${outcomeAfterMs} ms${reason ? ` (${reason})` : ""}, B after ${after}`);
    return { colony: col.id, createMs: col.createMs, intents: ids, aTook: fa.first, before, whileQueued, proposal: { id: p.id, status, reason: reason ?? null, outcomeAfterMs }, after, afterTakeMs: Math.round(performance.now() - t1) };
  };

  // Decay: A goes silent; B retries until A's claim has decayed below half a fresh claim.
  const decayArm = async () => {
    const col = await newColony(cfg, rec, `${prefix}-decay`, log);
    colonies.push(col.id);
    const ids = await pair(col.client, "d", "");
    const [a, b] = [await agent(col.client, "a"), await agent(col.client, "b")];
    const ta = await take(col.client, a);
    const fa = firstTake(ta, ids);
    if (!fa) throw new Error(`decay: A got no assignment (${ta && "wait" in ta ? ta.reason : "error"})`);
    const claimedAt = Date.now();
    const tries: Array<{ s: number; outcome: string }> = [];
    let tookOtherAtS: number | null = null;
    while (Date.now() - claimedAt < 8 * 60_000) {
      const t = await take(col.client, b);
      const s = Math.round((Date.now() - claimedAt) / 100) / 10;
      const o = outcome(t, fa.other);
      tries.push({ s, outcome: o });
      if (o === "took the other") {
        tookOtherAtS = s;
        break;
      }
      if (o !== "inhibited" && !o.startsWith("wait")) break;
      if (tries.length % 3 === 1) log(`decay: B at ${s} s -> ${o}`);
      await sleep(pollS * 1000);
    }
    const lastInhibited = [...tries].reverse().find((t) => t.outcome === "inhibited")?.s ?? null;
    log(`decay: B took the other intent at ${tookOtherAtS ?? "never"} s (half-life ${HALF_LIFE_S.toFixed(0)} s); last inhibited at ${lastInhibited} s`);
    return { colony: col.id, createMs: col.createMs, intents: ids, aTook: fa.first, pollS, halfLifeS: Math.round(HALF_LIFE_S * 10) / 10, tookOtherAtS, lastInhibitedAtS: lastInhibited, tries };
  };

  const settled = await Promise.allSettled([roundsArm(), landingArm(), decayArm()]);
  const value = <T>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : { error: String(r.reason instanceof Error ? r.reason.message : r.reason) });
  const report = {
    kind: "inhibition-live",
    label: "MEASURED",
    generatedAt: new Date().toISOString(),
    url: cfg.url,
    method:
      "X writes [shared, a] (priority 5), Y writes [shared, b] (priority 4); agent A takes first (X with p = 25/26) and B targets the other one. rounds: fresh A and B per round, B takes once, both stop. landing: B tries before and while A's proposal is queued, then after it lands (a real trunk commit). decay: A never heartbeats; B retries every poll seconds until it is assigned.",
    expected: { withoutInhibition: "B takes Y with p = 3^2 / (3^2 + 1) = 0.9 per try (soft repulsion only)", withInhibition: "B is turned away while A's claim is >= 0.5; takes the other intent after the landing, or about one half-life (208 s) after A's last claim refresh" },
    rounds: value(settled[0]),
    landing: value(settled[1]),
    decay: value(settled[2]),
    errors: rec.errorSamples,
  };
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  log(JSON.stringify({ rounds: report.rounds, landing: report.landing, decay: { ...(report.decay as object), tries: undefined } }));

  if (!values.keep) {
    for (const id of colonies) {
      const headers: Record<string, string> = cfg.token ? { authorization: `Bearer ${cfg.token}` } : {};
      const res = await fetch(`${cfg.url}/api/colonies/${encodeURIComponent(id)}`, { method: "DELETE", headers }).catch(() => null);
      log(`delete ${id}: ${res?.ok ? "ok" : `failed (${res?.status ?? "network"})`}`);
    }
  }
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}
