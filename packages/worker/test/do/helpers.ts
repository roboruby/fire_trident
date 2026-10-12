/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF, env as rawEnv, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { AgentInfo, Colony, FileVersion, Intent, Path, Proposal, Sha, WorkspaceLease } from "@fire_trident/core";
import type { ColonyDO } from "../../src/colony/ColonyDO.ts";
import type { Env } from "../../src/env.ts";
import type { RegionDO } from "../../src/region/RegionDO.ts";
import type { PoolDO as FakePool, TrunkDO as FakeTrunk } from "./harness.ts";
import { fakeSha } from "./harness.ts";

export { fakeSha };

/** Bindings of the harness worker. */
export const env = rawEnv as unknown as Env;

/** Admin header matching FT_ADMIN_TOKEN in vitest.config.ts. */
export const AUTH: Record<string, string> = { authorization: "Bearer test-admin" };

/** Call the REST API through the harness worker. */
export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await SELF.fetch(`https://ft.test/api${path}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

let seq = 0;

/**
 * Create a colony with a unique name. Self-assignment is made deterministic
 * (always accept the best candidate) and the lanes of ".", "src" and "docs"
 * are held so tests drive ticks with tick() instead of racing real alarms.
 */
export async function newColony(extra: Record<string, unknown> = {}): Promise<Colony> {
  const res = await api<Colony>("POST", "/colonies", { name: `Colony ${Date.now()} ${++seq}`, ...extra });
  expect(res.status).toBe(201);
  await setRand(res.body.id, () => 0);
  await holdLanes(res.body.id, ".", "src", "docs");
  return res.body;
}

/** Push a lane's cadence an hour out so its alarm only runs when a test calls tick(). */
export async function holdLanes(colonyId: string, ...names: string[]): Promise<void> {
  for (const name of names) {
    await runInDurableObject(region(colonyId, name), (instance) => {
      (instance as unknown as { lastTickAt: number }).lastTickAt = Date.now() + 60 * 60_000;
    });
  }
}

/** Poll until `check` passes (background effects such as lease release). */
export async function eventually<T>(read: () => Promise<T>, check: (v: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const start = Date.now();
  let value = await read();
  while (!check(value) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
    value = await read();
  }
  return value;
}

/** Replace the ColonyDO's randomness (lives as long as the instance). */
export async function setRand(colonyId: string, rand: () => number): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    (instance as unknown as { rand: () => number }).rand = rand;
  });
}

export function colony(colonyId: string): DurableObjectStub<ColonyDO> {
  return env.COLONY.get(env.COLONY.idFromName(colonyId));
}

export function region(colonyId: string, name: string) {
  return env.REGION.get(env.REGION.idFromName(`${colonyId}:${name}`));
}

export function trunk(colonyId: string): DurableObjectStub<FakeTrunk> {
  return env.TRUNK.get(env.TRUNK.idFromName(colonyId)) as unknown as DurableObjectStub<FakeTrunk>;
}

export function pool(colonyId: string): DurableObjectStub<FakePool> {
  return env.POOL.get(env.POOL.idFromName(colonyId)) as unknown as DurableObjectStub<FakePool>;
}

/** Run a region's lane tick now. Returns whether an alarm was scheduled. */
export async function tick(colonyId: string, name: string): Promise<boolean> {
  return runDurableObjectAlarm(region(colonyId, name));
}

/** Rows of a table inside a RegionDO (for asserting internal bookkeeping). */
export async function rows<T>(stub: DurableObjectStub<RegionDO>, sql: string, ...args: unknown[]): Promise<T[]> {
  const out: unknown = await runInDurableObject(stub, (_instance: RegionDO, state: DurableObjectState): unknown => state.storage.sql.exec(sql, ...args).toArray());
  return out as T[];
}

export async function addIntent(colonyId: string, footprint: Path[], extra: Record<string, unknown> = {}): Promise<Intent> {
  const res = await api<Intent>("POST", `/colonies/${colonyId}/intents`, { title: `Change ${footprint.join(", ")}`, why: "test", footprint, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

export async function addAgent(colonyId: string, name = "agent"): Promise<AgentInfo> {
  const res = await api<AgentInfo>("POST", `/colonies/${colonyId}/agents`, { name, kind: "synthetic" });
  expect(res.status).toBe(201);
  return res.body;
}

export type Assignment = { intent: Intent; lease: WorkspaceLease; rule?: unknown };

/** Take and expect an assignment. */
export async function take(colonyId: string, agentId: string): Promise<Assignment> {
  const res = await api<Assignment | { wait: true; reason: string }>("POST", `/colonies/${colonyId}/agents/${agentId}/take`);
  expect(res.status).toBe(200);
  if ("wait" in res.body) throw new Error(`expected an assignment, got wait: ${res.body.reason}`);
  return res.body;
}

/** Propose new content for every path of the intent's footprint, reading the current trunk blobs. */
export async function proposeEdit(colonyId: string, a: Assignment, agentId: string, opts: { paths?: Path[]; readSet?: FileVersion[] } = {}): Promise<Proposal> {
  const paths = opts.paths ?? a.intent.footprint;
  const current = await trunk(colonyId).baseBlobs(a.lease.baseSha, paths);
  const res = await api<Proposal>("POST", `/colonies/${colonyId}/proposals`, {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: paths.map((path) => ({ path, blob: fakeSha() })),
    readSet: opts.readSet ?? current,
    declared: { footprint: a.intent.footprint, summary: "edit" },
  });
  expect(res.status).toBe(201);
  return res.body;
}

export async function proposal(colonyId: string, id: string): Promise<Proposal> {
  const res = await api<Proposal>("GET", `/colonies/${colonyId}/proposals/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

export async function headSha(colonyId: string): Promise<Sha> {
  return (await trunk(colonyId).state()).head;
}

/** Change trunk outside any lane and report it to the colony, as TrunkDO would after a landing. */
export async function externalLanding(colonyId: string, changes: Record<Path, string | null>): Promise<Sha> {
  const before = await headSha(colonyId);
  const { sha } = await trunk(colonyId).commitExternal(changes);
  const paths = Object.keys(changes);
  await colony(colonyId).onLanding({
    id: `lnd_external_${sha.slice(0, 8)}`,
    colonyId,
    trunkSha: sha,
    parentSha: before,
    proposalIds: [],
    intentIds: [],
    paths,
    regions: [],
    at: Date.now(),
  });
  return sha;
}
