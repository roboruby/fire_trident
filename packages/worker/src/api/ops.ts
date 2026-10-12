import { MARK_KINDS, regionKey } from "@fire_trident/core";
import type { ColonySnapshot, Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { withArtifactsRetry } from "../artifacts/git.ts";
import { SESSIONS_NAMESPACE, TRUNK_NAMESPACE, colonySlug, workspaceNamespace } from "../artifacts/shards.ts";
import { REGISTRY_NAME, inPlatform, summaryOf } from "../colony/metrics.ts";
import type { AgentListEntry, ColonySummary, RegistryEntry } from "../colony/metrics.ts";
import { colonyIdsFromTrunks, isUnsupportedRpc, journalFields, mapLimit, messageOf, repoBelongsTo } from "./logic.ts";

/**
 * Colony and agent operations behind the REST API: the colony registry,
 * agent listing and stopping, and colony deletion. Every function tolerates
 * missing bindings (the test harness has no agents or Artifacts) and reports
 * per-item failures instead of throwing on the first one.
 */

/** AgentDO calls in flight at once. */
const AGENT_CONCURRENCY = 25;
/** Colony summaries fetched in parallel for GET /api/colonies. */
const SUMMARY_CONCURRENCY = 20;
/** Artifacts deletes in flight at once (control-plane calls are rate limited per namespace). */
const REPO_DELETE_CONCURRENCY = 4;
/** Repos listed per Artifacts page (the binding's maximum). */
const LIST_PAGE = 200;
/** Pages listed per namespace at most. */
const LIST_PAGES = 50;
/** Registry marker set once the existing trunks have been scanned into the registry. */
const BACKFILL_FLAG = "backfilled";

/** The registry instance of ColonyDO. */
export function registryStub(env: Pick<Env, "COLONY">) {
  return env.COLONY.get(env.COLONY.idFromName(REGISTRY_NAME));
}

function colonyStub(env: Pick<Env, "COLONY">, colonyId: Id) {
  return env.COLONY.get(env.COLONY.idFromName(colonyId));
}

/** Why an operation fell back: deploys reach Durable Objects gradually, so one may still run the previous class for a while. */
export const UPGRADING = "colony object still runs the previous version (deploys roll out gradually); retry shortly";

/**
 * The colony's agents for listings and stops. An object that predates listAgents (mid-rollout)
 * answers from its snapshot instead: same agents and states, without stop records or intent titles.
 */
async function colonyAgents(env: Env, colonyId: Id, opts: { includeDead?: boolean; kinds?: Array<"internal" | "synthetic" | "external">; limit?: number }): Promise<AgentListEntry[]> {
  const colony = colonyStub(env, colonyId);
  try {
    return await colony.listAgents(opts);
  } catch (err) {
    if (!isUnsupportedRpc(err)) throw err;
    // Typed through a narrow view: the stub's RPC mapping cannot express the snapshot's `unknown` fields.
    const snap = await (colony as unknown as { snapshot(): Promise<ColonySnapshot> }).snapshot();
    return snap.agents
      .filter((a) => (opts.includeDead || a.state !== "dead") && (!opts.kinds || opts.kinds.includes(a.kind)))
      .slice(0, opts.limit ?? Number.POSITIVE_INFINITY)
      .map((a) => ({ ...a, createdAt: a.lastSeen }));
  }
}

/** Loosely typed AgentDO surface (the agents stream owns the class; replies are read defensively). */
interface AgentOps {
  stop(reason?: string): Promise<unknown>;
  status(): Promise<unknown>;
  destroy?(): Promise<unknown>;
}

function agentOps(env: Env, agentId: Id): AgentOps | null {
  if (!env.AGENT) return null;
  return env.AGENT.get(env.AGENT.idFromName(agentId)) as unknown as AgentOps;
}

/** Every Artifacts binding a colony may own repos in, by namespace. */
function bindings(env: Env): Array<{ namespace: string; binding: Artifacts }> {
  const out: Array<{ namespace: string; binding: Artifacts | undefined }> = [
    { namespace: TRUNK_NAMESPACE, binding: env.ARTIFACTS },
    { namespace: workspaceNamespace(0), binding: env.WS0 },
    { namespace: workspaceNamespace(1), binding: env.WS1 },
    { namespace: workspaceNamespace(2), binding: env.WS2 },
    { namespace: workspaceNamespace(3), binding: env.WS3 },
    { namespace: SESSIONS_NAMESPACE, binding: env.SESSIONS },
  ];
  return out.filter((b): b is { namespace: string; binding: Artifacts } => !!b.binding);
}

/** Every repo name in a namespace (paginated). */
async function listRepoNames(binding: Artifacts): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    const res = await withArtifactsRetry(() => binding.list(cursor ? { limit: LIST_PAGE, cursor } : { limit: LIST_PAGE }));
    for (const r of res.repos ?? []) if (r && typeof r.name === "string") names.push(r.name);
    if (!res.cursor || (res.repos ?? []).length === 0) break;
    cursor = res.cursor;
  }
  return names;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Record a colony in the registry (POST /api/colonies). Failures are logged: the registry is an index, not the source of truth. */
export async function registerColony(env: Env, e: { id: Id; name: string; source?: { url: string; branch?: string }; createdAt?: number }): Promise<void> {
  try {
    await registryStub(env).registerColony(e);
  } catch (err) {
    console.error(`registry: could not register ${e.id}: ${messageOf(err)}`);
  }
}

/**
 * Add colonies created before the registry existed: every `<id>--trunk` in ft-trunk whose
 * ColonyDO holds a colony. Runs once (or again with `force`). Returns how many were added.
 */
export async function backfillRegistry(env: Env, force = false): Promise<number> {
  const registry = registryStub(env);
  if (!force && (await registry.registryFlag(BACKFILL_FLAG)) !== null) return 0;
  if (!env.ARTIFACTS) return 0;
  const known = new Set((await registry.listColonies()).map((e) => e.id));
  const candidates = colonyIdsFromTrunks(await listRepoNames(env.ARTIFACTS)).filter((id) => !known.has(id));
  let added = 0;
  await mapLimit(candidates, SUMMARY_CONCURRENCY, async (id) => {
    const colony = await colonyStub(env, id).getColony();
    if (!colony) return;
    await registry.registerColony({ id: colony.id, name: colony.name, ...(colony.source ? { source: colony.source } : {}), createdAt: colony.createdAt });
    added++;
  });
  await registry.registryFlag(BACKFILL_FLAG, String(Date.now()));
  return added;
}

/** One row of GET /api/colonies: the registry entry joined with the colony's live summary. */
export interface ColonyListing extends ColonySummary {
  registeredAt: number;
}

/**
 * Every registered colony with live counters, oldest first. Entries whose colony no longer
 * exists are dropped from the registry; colonies that do not answer are listed with an error.
 */
export async function listColonies(env: Env, opts: { scan?: boolean } = {}): Promise<{ colonies: Array<ColonyListing | (RegistryEntry & { error: string })>; scanned: number }> {
  let scanned = 0;
  try {
    scanned = await backfillRegistry(env, opts.scan === true);
  } catch (err) {
    console.warn(`registry backfill failed: ${messageOf(err)}`);
  }
  const registry = registryStub(env);
  const entries = await registry.listColonies();
  const results = await mapLimit(entries, SUMMARY_CONCURRENCY, async (e): Promise<ColonySummary | null> => {
    const stub = colonyStub(env, e.id);
    try {
      return await stub.summary();
    } catch (err) {
      if (!isUnsupportedRpc(err)) throw err;
      // Mid-rollout: identity from the old object, counters once it runs the new version.
      const colony = await stub.getColony();
      return colony ? summaryOf(colony, 0, {}) : null;
    }
  });
  const colonies: Array<ColonyListing | (RegistryEntry & { error: string })> = [];
  const gone: Id[] = [];
  results.forEach((r, i) => {
    const e = entries[i];
    if (!e) return;
    if (r.status === "rejected") colonies.push({ ...e, error: messageOf(r.reason) });
    else if (r.value === null) gone.push(e.id);
    else colonies.push({ ...r.value, registeredAt: e.registeredAt });
  });
  await Promise.all(gone.map((id) => registry.unregisterColony(id).catch(() => false)));
  return { colonies, scanned };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * The colony's agents, each in-platform agent enriched with its own journal (step, attempts,
 * running, counters). `journal: false` skips the per-agent calls.
 */
export async function listAgents(env: Env, colonyId: Id, opts: { includeDead?: boolean; journal?: boolean; limit?: number } = {}): Promise<AgentListEntry[]> {
  const agents = await colonyAgents(env, colonyId, {
    ...(opts.includeDead ? { includeDead: true } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  if (opts.journal === false) return agents;
  const targets = agents.filter((a) => inPlatform(a.kind));
  const results = await mapLimit(targets, AGENT_CONCURRENCY, async (a) => {
    const ops = agentOps(env, a.id);
    if (!ops) throw new Error("no agent binding");
    return ops.status();
  });
  results.forEach((r, i) => {
    const a = targets[i];
    if (!a) return;
    if (r.status === "fulfilled") {
      const j = journalFields(r.value);
      // The colony's state and intent are authoritative; the journal adds the step and the agent's own view.
      Object.assign(a, { ...j, ...(a.intentTitle ? { intentTitle: a.intentTitle } : {}), ...(a.stopReason ? { stopReason: a.stopReason } : {}) });
    } else {
      a.journalError = messageOf(r.reason);
    }
  });
  return agents;
}

/** What stopping agents did. */
export interface StopReport {
  /** Agents whose loop was stopped (or that run outside the platform and were only retired). */
  stopped: Id[];
  failed: Array<{ agentId: Id; error: string }>;
  /** Agents the colony marked dead (claims released). */
  retired: number;
  /** Set when the colony could not retire them yet (mid-rollout); the loops are stopped regardless. */
  note?: string;
}

/**
 * Stop agents: each in-platform agent's AgentDO loop stops (a claimed intent is given back),
 * then the colony retires them all (claims cleared, counted as dead). External agents have no
 * loop to stop and are only retired. Agents whose loop could not be stopped are not retired.
 */
export async function stopAgents(env: Env, colonyId: Id, agents: Array<{ id: Id; kind: string }>, reason: string): Promise<StopReport> {
  const results = await mapLimit(agents, AGENT_CONCURRENCY, async (a) => {
    if (!inPlatform(a.kind)) return;
    const ops = agentOps(env, a.id);
    if (!ops) return; // no agent binding (tests): nothing runs, retire only
    await ops.stop(reason);
  });
  const stopped: Id[] = [];
  const failed: Array<{ agentId: Id; error: string }> = [];
  results.forEach((r, i) => {
    const a = agents[i];
    if (!a) return;
    if (r.status === "fulfilled") stopped.push(a.id);
    else failed.push({ agentId: a.id, error: messageOf(r.reason) });
  });
  if (stopped.length === 0) return { stopped, failed, retired: 0 };
  try {
    return { stopped, failed, retired: (await colonyStub(env, colonyId).retireAgents(stopped, reason)).length };
  } catch (err) {
    if (!isUnsupportedRpc(err)) throw err;
    // The loops are stopped; the colony reaps the silent agents itself, or a repeat stop retires them.
    return { stopped, failed, retired: 0, note: `agents stopped but not retired: ${UPGRADING}` };
  }
}

/**
 * Stop every in-platform agent of a colony that may still be running: all of them except
 * those already stopped and silent since (unless `all`). Returns the stop report.
 */
export async function stopSwarm(env: Env, colonyId: Id, reason: string, all = false): Promise<StopReport & { considered: number }> {
  const agents = await colonyAgents(env, colonyId, { includeDead: true, kinds: ["internal", "synthetic"] });
  const targets = all ? agents : agents.filter((a) => !(a.state === "dead" && a.stoppedAt !== undefined));
  const report = await stopAgents(env, colonyId, targets, reason);
  return { ...report, considered: targets.length };
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/** One Durable Object deletion touched. */
export interface ObjectReport {
  object: string;
  /** True when the object's storage was deleted. */
  cleared: boolean;
  detail?: string;
}

/** What DELETE /api/colonies/:id did. */
export interface DeleteReport {
  colonyId: Id;
  /** False when there was no colony record (an earlier delete finished, or the id never existed). */
  found: boolean;
  agents: { stopped: number; failed: Array<{ agentId: Id; error: string }> };
  repos: { deleted: string[]; failed: Array<{ repo: string; error: string }> };
  objects: ObjectReport[];
  unregistered: boolean;
  /** True when nothing failed (a retry finishes whatever did). */
  ok: boolean;
}

/** Call `destroy()` on a Durable Object stub; objects whose class has no such hook fall back to `fallback`. */
async function destroyObject(object: string, stub: unknown, fallback?: () => Promise<string>): Promise<ObjectReport> {
  try {
    await (stub as { destroy(): Promise<unknown> }).destroy();
    return { object, cleared: true };
  } catch (err) {
    if (!isUnsupportedRpc(err)) return { object, cleared: false, detail: messageOf(err) };
    if (!fallback) return { object, cleared: false, detail: "destroy() not available on this class" };
    try {
      return { object, cleared: false, detail: `destroy() not available; ${await fallback()}` };
    } catch (e) {
      return { object, cleared: false, detail: `destroy() not available; fallback failed: ${messageOf(e)}` };
    }
  }
}

/**
 * Delete a colony: stop its agents, delete its Artifacts repos (trunk, seeds, workspaces,
 * lanes, sessions), clear the storage of its Durable Objects, and unregister it. Idempotent:
 * a repeat (or a retry after a partial failure) finishes what is left. The colony record is
 * erased last, and only when agents and repos are gone, so a retry still knows its agents.
 */
export async function deleteColony(env: Env, colonyId: Id): Promise<DeleteReport> {
  const colony = colonyStub(env, colonyId);
  const record = await colony.getColony();
  const regions = record ? await colony.listRegions() : [];
  const agents = record ? await colonyAgents(env, colonyId, { includeDead: true }) : [];
  const report: DeleteReport = {
    colonyId,
    found: record !== null,
    agents: { stopped: 0, failed: [] },
    repos: { deleted: [], failed: [] },
    objects: [],
    unregistered: false,
    ok: true,
  };

  // Repos named <slug>--* in every namespace. Without a colony record, leftover repos mean a
  // half-created (or half-deleted) colony, whose trunk and pool objects are cleaned up too.
  const slug = colonySlug(colonyId);
  const listed: Array<{ namespace: string; binding: Artifacts; names: string[] }> = [];
  for (const { namespace, binding } of bindings(env)) {
    try {
      listed.push({ namespace, binding, names: (await listRepoNames(binding)).filter((n) => repoBelongsTo(n, slug)) });
    } catch (err) {
      report.repos.failed.push({ repo: `${namespace}/*`, error: `list failed: ${messageOf(err)}` });
    }
  }
  const touchObjects = report.found || listed.some((l) => l.names.length > 0);

  // 1. Agents: stop every loop first, so nothing takes, pushes or proposes while the rest goes.
  if (agents.length > 0) {
    const stop = await stopAgents(env, colonyId, agents, "colony deleted");
    report.agents = { stopped: stop.stopped.length, failed: stop.failed };
  }

  // 2. The pool deletes the workspaces and seeds it knows (and stops growing); the sweep catches the rest.
  const pool = env.POOL.get(env.POOL.idFromName(colonyId));
  let poolDetail = "";
  if (touchObjects) {
    try {
      const t = await (pool as unknown as { teardown(): Promise<{ deleted: number; errors: string[] }> }).teardown();
      poolDetail = `teardown deleted ${t.deleted} repos${t.errors.length ? ` (${t.errors.length} errors)` : ""}`;
    } catch (err) {
      poolDetail = `teardown failed: ${messageOf(err)}`;
    }
  }

  // 3. Artifacts sweep. A repo already gone (deleted by the pool) is not a failure.
  for (const { namespace, binding, names } of listed) {
    const results = await mapLimit(names, REPO_DELETE_CONCURRENCY, (name) => withArtifactsRetry(() => binding.delete(name), { delaysMs: [500, 1_500, 3_000] }));
    results.forEach((r, i) => {
      const name = `${namespace}/${names[i] ?? "?"}`;
      if (r.status === "fulfilled") report.repos.deleted.push(name);
      else report.repos.failed.push({ repo: name, error: messageOf(r.reason) });
    });
  }

  // 4. Durable Object storage: agents, pool, trunk, regions (only for a colony that left something behind).
  if (touchObjects) {
    if (env.AGENT) {
      const results = await mapLimit(
        agents.filter((a) => inPlatform(a.kind)),
        AGENT_CONCURRENCY,
        (a) => destroyObject(`AgentDO ${a.id}`, env.AGENT.get(env.AGENT.idFromName(a.id)), async () => "loop stopped, alarm deleted"),
      );
      for (const r of results) if (r.status === "fulfilled") report.objects.push(r.value);
    }
    report.objects.push(await destroyObject(`PoolDO ${colonyId}`, pool, async () => poolDetail));
    report.objects.push(await destroyObject(`TrunkDO ${colonyId}`, env.TRUNK.get(env.TRUNK.idFromName(colonyId))));
    const regionResults = await mapLimit(regions, AGENT_CONCURRENCY, (region) => {
      const stub = env.REGION.get(env.REGION.idFromName(regionKey(colonyId, region)));
      return destroyObject(`RegionDO ${regionKey(colonyId, region)}`, stub, async () => {
        const r = await stub.apply({ clear: MARK_KINDS.map((kind) => ({ kind })) });
        return `${r.cleared} marks cleared`;
      });
    });
    for (const r of regionResults) if (r.status === "fulfilled") report.objects.push(r.value);
  }

  // 5. The colony record and the registry entry, last, and only when agents and repos are gone.
  report.ok = report.agents.failed.length === 0 && report.repos.failed.length === 0;
  if (!report.found) {
    // No record to erase.
  } else if (report.ok) {
    try {
      await colony.destroy();
      report.objects.push({ object: `ColonyDO ${colonyId}`, cleared: true });
    } catch (err) {
      report.ok = false;
      report.objects.push({ object: `ColonyDO ${colonyId}`, cleared: false, detail: isUnsupportedRpc(err) ? UPGRADING : messageOf(err) });
    }
  } else {
    report.objects.push({ object: `ColonyDO ${colonyId}`, cleared: false, detail: "kept until agents and repos are gone; retry the delete" });
  }
  if (report.ok) {
    try {
      report.unregistered = await registryStub(env).unregisterColony(colonyId);
    } catch (err) {
      report.ok = false;
      report.objects.push({ object: "registry", cleared: false, detail: messageOf(err) });
    }
  }
  return report;
}
