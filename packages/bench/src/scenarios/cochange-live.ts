#!/usr/bin/env node
/**
 * Live check of co-change repulsion (MEASURED on a deployment): does a take steer away from the
 * co-change neighbors of a claimed file?
 *
 * Two colonies import honojs/hono; TrunkDO mines the imported history (about 200 commits) at init.
 * In each colony three intents compete: X (priority 5), Y (2.5) and Z (2). Each round a fresh agent
 * A takes (X, the highest stimulus), then a fresh agent B takes and its choice is recorded; both
 * stop, so all three intents reopen unchanged for the next round. In the "coupled" colony Y's file
 * changes with X's in hono's history (src/jsx/streaming.ts with src/jsx/components.ts); in the
 * "control" colony Y's file never changed with X's in that window. Without co-change repulsion B
 * takes Y about 86% of the time in both (p = s^2 / (s^2 + 1) for a new agent); with it, Y's
 * stimulus drops by weight * coupling in the coupled colony only, and B should mostly take Z.
 *
 *   FT_TOKEN=... node packages/bench/src/scenarios/cochange-live.ts --url https://<preview> --rounds 20 --out live-steer.json
 *
 * Colonies are deleted at the end unless --keep (DELETE needs the server's admin token).
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Colony, Intent, WorkspaceLease } from "@fire_trident/core";
import { Client } from "../live.ts";
import { liveConfig } from "../env.ts";
import { Recorder, summarize } from "../stats.ts";

type Take = { intent: Intent; lease: WorkspaceLease } | { wait: true; retryInMs: number; reason: string };

const X_FILE = "src/jsx/components.ts";
const Z_FILE = "src/utils/body.ts";
const ARMS = [
  { arm: "coupled", y: "src/jsx/streaming.ts" },
  { arm: "control", y: "src/router/reg-exp-router/node.ts" },
] as const;
/** ColonyDO overlays claims younger than 10 s on readings; rounds of one colony are spaced past it. */
const ROUND_GAP_MS = 11_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

interface ArmState {
  arm: string;
  colony: string;
  client: Client;
  yFile: string;
  ids: { x: string; y: string; z: string };
  outcomes: string[];
  bTakeMs: number[];
  aTakeMs: number[];
  lastRoundAt: number;
  createMs: number;
}

async function takeWithRetry(c: Client, agentId: string, deadlineMs: number): Promise<{ take: Take | null; ms: number }> {
  for (;;) {
    const t0 = performance.now();
    const take = await c.call<Take>("take", "POST", `/agents/${agentId}/take`);
    const ms = performance.now() - t0;
    if (!take || !("wait" in take) || !/pool|lease/i.test(take.reason) || Date.now() > deadlineMs) return { take, ms };
    await sleep(take.retryInMs);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string" },
      rounds: { type: "string" },
      "mine-wait": { type: "string" },
      out: { type: "string" },
      keep: { type: "boolean" },
      prefix: { type: "string" },
    },
    strict: true,
  });
  const cfg = liveConfig(values.url ? { ...process.env, FT_URL: values.url } : process.env);
  const rounds = Number(values.rounds ?? 20);
  const mineWaitS = Number(values["mine-wait"] ?? 45);
  const prefix = values.prefix ?? `g4-steer-${Date.now().toString(36)}`;
  const rec = new Recorder();
  const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

  // 1. Colonies (imports run in parallel).
  const arms: ArmState[] = await Promise.all(
    ARMS.map(async (a) => {
      const name = `${prefix}-${a.arm}`;
      const admin = new Client(cfg, "", rec, 600_000);
      const t0 = performance.now();
      const colony = await admin.call<Colony>("createColony", "POST", "/colonies", { name, source: { url: "https://github.com/honojs/hono" }, regionDepth: 3, pool: 6 });
      if (!colony) throw new Error(`could not create colony ${name}: ${rec.errorSamples.at(-1) ?? "no response"}`);
      const createMs = Math.round(performance.now() - t0);
      log(`colony ${colony.id} (${a.arm}) ready in ${createMs} ms at ${colony.trunkSha.slice(0, 12)}`);
      return { arm: a.arm, colony: colony.id, client: new Client(cfg, colony.id, rec), yFile: a.y, ids: { x: "", y: "", z: "" }, outcomes: [], bTakeMs: [], aTakeMs: [], lastRoundAt: 0, createMs };
    }),
  );
  log(`waiting ${mineWaitS} s for TrunkDO to mine the imported history`);
  await sleep(mineWaitS * 1000);

  // 2. Intents.
  for (const s of arms) {
    const mk = async (path: string, priority: number) => {
      const i = await s.client.call<Intent>("intent", "POST", "/intents", { title: `Edit ${path}`, why: "co-change steering check", footprint: [path], priority });
      if (!i) throw new Error(`could not add intent ${path} to ${s.colony}`);
      return i.id;
    };
    s.ids = { x: await mk(X_FILE, 5), y: await mk(s.yFile, 2.5), z: await mk(Z_FILE, 2) };
  }

  // 3. Rounds, interleaving the colonies.
  for (let r = 1; r <= rounds; r++) {
    for (const s of arms) {
      await sleep(s.lastRoundAt + ROUND_GAP_MS - Date.now());
      const a = await s.client.call<{ id: string }>("agent", "POST", "/agents", { name: `a${r}`, kind: "synthetic" });
      const b = await s.client.call<{ id: string }>("agent", "POST", "/agents", { name: `b${r}`, kind: "synthetic" });
      if (!a || !b) {
        s.outcomes.push("error");
        continue;
      }
      const ta = await takeWithRetry(s.client, a.id, Date.now() + 30_000);
      s.aTakeMs.push(ta.ms);
      let outcome: string;
      if (!ta.take || "wait" in ta.take || ta.take.intent.id !== s.ids.x) {
        outcome = `invalid (A took ${ta.take && !("wait" in ta.take) ? ta.take.intent.footprint.join(",") : ta.take ? `wait: ${ta.take.reason}` : "error"})`;
      } else {
        const tb = await takeWithRetry(s.client, b.id, Date.now() + 30_000);
        s.bTakeMs.push(tb.ms);
        if (!tb.take) outcome = "error";
        else if ("wait" in tb.take) outcome = `wait: ${tb.take.reason}`;
        else outcome = tb.take.intent.id === s.ids.y ? "Y" : tb.take.intent.id === s.ids.z ? "Z" : `other ${tb.take.intent.footprint.join(",")}`;
      }
      s.outcomes.push(outcome);
      s.lastRoundAt = Date.now();
      await Promise.all([a, b].map((g) => s.client.call("stop", "POST", `/agents/${g.id}/stop`, { reason: "round over" })));
      log(`round ${r} ${s.arm}: B -> ${outcome}`);
    }
  }

  // 4. Report.
  const count = (xs: string[], v: string) => xs.filter((x) => x === v).length;
  const report = {
    kind: "cochange-live",
    label: "MEASURED",
    generatedAt: new Date().toISOString(),
    url: cfg.url,
    method:
      "Per round: fresh agent A takes X (priority 5), fresh agent B takes (Y 2.5 vs Z 2), both stop. Coupled colony: Y = src/jsx/streaming.ts, which co-changes with X = src/jsx/components.ts in hono's last 200 commits; control colony: Y = src/router/reg-exp-router/node.ts, which never did. Z = src/utils/body.ts in both.",
    files: { x: X_FILE, z: Z_FILE },
    arms: arms.map((s) => ({
      arm: s.arm,
      colony: s.colony,
      y: s.yFile,
      intents: s.ids,
      createMs: s.createMs,
      rounds: s.outcomes.length,
      tookY: count(s.outcomes, "Y"),
      tookZ: count(s.outcomes, "Z"),
      other: s.outcomes.filter((o) => o !== "Y" && o !== "Z"),
      outcomes: s.outcomes,
      takeMsA: summarize(s.aTakeMs),
      takeMsB: summarize(s.bTakeMs),
    })),
    errors: rec.errorSamples,
  };
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const a of report.arms) log(`${a.arm}: B took Y ${a.tookY}/${a.rounds}, Z ${a.tookZ}/${a.rounds}, take p50 ${a.takeMsB.p50?.toFixed(0)} ms`);

  // 5. Cleanup (DELETE needs the server's admin token; the token only goes in the header).
  if (!values.keep) {
    for (const s of arms) {
      const headers: Record<string, string> = cfg.token ? { authorization: `Bearer ${cfg.token}` } : {};
      const res = await fetch(`${cfg.url}/api/colonies/${encodeURIComponent(s.colony)}`, { method: "DELETE", headers }).catch(() => null);
      log(`delete ${s.colony}: ${res?.ok ? "ok" : `failed (${res?.status ?? "network"})`}`);
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
