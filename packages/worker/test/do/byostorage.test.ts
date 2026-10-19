import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Proposal, WorkspaceLease } from "@fire_trident/core";
import { applyTreeChanges, commitTree, ensureRepo, fetchRef, memoryFs, pushRef, setRef, writeCommitObject, writeLocalBlob, NEW_FILE_MODE, type GitRepo } from "../../src/artifacts/git.ts";
import { provisionTrunk } from "../../src/artifacts/colony.ts";
import { artifactsOverRest, forgetKnownNamespaces } from "../../src/artifacts/rest.ts";
import { colonyStorage, provisionOwnedTrunk, setStorageResolver } from "../../src/artifacts/storage.ts";
import { bindingReader } from "../../src/colony/innate.ts";
import { pushReadme } from "../artifacts/rest-helpers.ts";
import type { Env } from "../../src/env.ts";
import { AgentDO } from "../../src/agents/AgentDO.ts";
import { PoolDO } from "../../src/pool/PoolDO.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import { FakeArtifacts } from "../artifacts/fake-artifacts.ts";
import { env } from "./helpers.ts";

/**
 * A colony a person owns, end to end on the real trunk writer and pool: its trunk is provisioned in the owner's
 * Cloudflare account, the pool seeds and forks workspaces there and leases one, an agent pushes a commit to it, and the
 * trunk writer pulls the change's blob from it and lands the change on the trunk there. The account is a fake
 * Artifacts service (REST and git, test/artifacts/fake-artifacts.ts) behind the global fetch; the deployment's own
 * Artifacts bindings are tripwires that fail the test if anything touches them.
 */

const OWNER = "acc_e2e_owner";
const enc = new TextEncoder();
let fake: FakeArtifacts;
/** The deployment's own Artifacts account, for the operator colony. */
let operator: FakeArtifacts;
let realFetch: typeof fetch;
const touched: string[] = [];
let grantsAsked = 0;

/** A stand-in for one of the deployment's bindings that records any use (an owned colony must never use one). */
function tripwire(name: string): Artifacts {
  return new Proxy({} as Artifacts, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      touched.push(`${name}.${String(prop)}`);
      return () => {
        throw new Error(`the deployment's ${name} binding was used for a colony a person owns`);
      };
    },
  });
}

/** The harness env with tripwires for every Artifacts binding, and no colony object (the writer's colony lookups are best effort). */
function ownedEnv(): Env {
  const value = (name: string): PropertyDescriptor => ({ value: tripwire(name), enumerable: true });
  return Object.create(env, {
    ARTIFACTS: value("ARTIFACTS"),
    WS0: value("WS0"),
    WS1: value("WS1"),
    WS2: value("WS2"),
    WS3: value("WS3"),
    SESSIONS: value("SESSIONS"),
    COLONY: { value: undefined, enumerable: true },
  }) as Env;
}

/** An owner's storage, through the installed resolver. */
function colonyStorageOf(owner: string) {
  return colonyStorage(env, owner);
}

/** The harness env whose Artifacts bindings are the operator account's namespaces (the deployment's own bindings). */
function operatorEnv(): Env {
  const ns = (namespace: string): PropertyDescriptor => ({ value: artifactsOverRest({ namespace, credentials: async () => ({ accountId: operator.accountId, accessToken: operator.accessToken }) }), enumerable: true });
  return Object.create(env, {
    ARTIFACTS: ns("ft-trunk"),
    WS0: ns("ft-ws-0"),
    WS1: ns("ft-ws-1"),
    WS2: ns("ft-ws-2"),
    WS3: ns("ft-ws-3"),
    SESSIONS: ns("ft-sessions"),
    COLONY: { value: undefined, enumerable: true },
  }) as Env;
}

beforeAll(() => {
  fake = new FakeArtifacts();
  operator = new FakeArtifacts();
  forgetKnownNamespaces();
  realFetch = globalThis.fetch;
  // Only the fakes answer: the API for their accounts and their git hosts; anything else fails rather than reaching the network.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    for (const f of [fake, operator]) {
      if (url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${f.accountId}/`) || url.startsWith(f.gitHost)) return f.fetch(input, init);
    }
    return Promise.reject(new Error(`unexpected network call to ${new URL(url).host}`));
  }) as typeof fetch;
  setStorageResolver({
    ownerOf: async () => OWNER,
    grantFor: async (_env, account) => {
      grantsAsked++;
      return account === OWNER ? { accountId: fake.accountId, accessToken: fake.accessToken, scopes: ["artifacts.read", "artifacts.write"] } : null;
    },
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  setStorageResolver(null);
});

describe("a colony a person owns, on their storage", () => {
  it("is created, takes a workspace, and lands a change, all in the owner's Cloudflare account", async () => {
    const colonyId = `byo_${Date.now()}`;
    const e = ownedEnv();
    const { trunk, trunkSha } = await provisionOwnedTrunk(e, colonyId, OWNER);
    expect(trunk).toMatchObject({ namespace: "ft-trunk", name: `${colonyId}--trunk`, owner: OWNER });
    expect(trunk.remote.startsWith(`${fake.gitHost}/git/firetrident-trunk/`)).toBe(true);

    await runInDurableObject(env.TRUNK.get(env.TRUNK.idFromName(`byo-trunk-${colonyId}`)), async (_i: unknown, tstate: DurableObjectState) => {
      const writer = new TrunkDO(tstate, e);
      expect((await writer.init({ colonyId, trunk })).trunkSha).toBe(trunkSha);

      // Take: the pool seeds every shard and forks a workspace in the owner's namespaces, then leases it.
      let lease: WorkspaceLease | null = null;
      await runInDurableObject(env.POOL.get(env.POOL.idFromName(`byo-pool-${colonyId}`)), async (_p: unknown, pstate: DurableObjectState) => {
        const pool = new PoolDO(pstate, e);
        await pool.init({ colonyId, trunk, target: 1 });
        lease = await pool.lease("agt_byo", trunkSha);
        await pstate.storage.deleteAlarm();
      });
      const l = lease as WorkspaceLease | null;
      expect(l).not.toBeNull();
      expect(l!.repo.owner).toBe(OWNER);
      expect(l!.repo.namespace).toMatch(/^ft-ws-[0-3]$/);
      const shard = l!.repo.namespace.slice("ft-ws-".length);
      expect(l!.repo.remote).toBe(`${fake.gitHost}/git/firetrident-ws-${shard}/${l!.repo.name}.git`);
      expect(fake.repo(`firetrident-ws-${shard}`, `${colonyId}--seed`)).toBeDefined();

      // The agent: trunk at the lease base with the read token, one new file, pushed to its workspace.
      const g: GitRepo = { fs: memoryFs(), dir: "/agent", cache: {} };
      await ensureRepo(g, l!.repo.remote);
      expect(await fetchRef(g, { url: l!.trunk.remote, token: l!.trunk.token, ref: "refs/heads/main", depth: 1 })).toBe(trunkSha);
      const blob = await writeLocalBlob(g, enc.encode("export const hello = 'owned';\n"));
      const tree = await applyTreeChanges(g, (await commitTree(g, trunkSha))!, new Map([["src/hello.ts", { blob, mode: NEW_FILE_MODE }]]));
      const headSha = await writeCommitObject(g, { tree, parents: [trunkSha], message: "Add hello", at: Date.now(), identity: { name: "agent", email: "agent@example.invalid" } });
      await setRef(g, "refs/heads/main", headSha);
      expect(await pushRef(g, { url: l!.repo.remote, token: l!.token, localRef: "refs/heads/main", remoteRef: "refs/heads/main", force: true })).toEqual({ ok: true });

      // Propose and land: the writer pulls the blob from the workspace in the owner's account and pushes trunk there.
      const proposal: Proposal = {
        id: "prp_byo",
        colonyId,
        intentId: "int_byo",
        agentId: "agt_byo",
        workspace: l!.repo,
        baseSha: trunkSha,
        headSha,
        writeSet: [{ path: "src/hello.ts", blob }],
        readSet: [],
        declared: { footprint: ["src/hello.ts"], summary: "Add hello" },
        evidence: { checks: [] },
        status: "ready",
        createdAt: Date.now(),
      } as unknown as Proposal;
      const result = await writer.land([proposal]);
      expect(result.returned).toEqual([]);
      expect(result.landing).toBeDefined();
      expect(await fake.head("firetrident-trunk", trunk.name)).toBe(result.landing!.trunkSha);
      expect(await fake.readText("firetrident-trunk", trunk.name, "src/hello.ts")).toBe("export const hello = 'owned';\n");
      expect(fake.calls.some((c) => c.kind === "rest" && c.path === `/namespaces/firetrident-ws-${shard}/repos/${l!.repo.name}/blob/${blob}`)).toBe(true);

      // Let the notes flush and the co-change mining finish against the fake before the test ends.
      await writer.flushNotes();
      for (let i = 0; i < 100 && (writer as unknown as { mining: Promise<void> | null }).mining; i++) await (writer as unknown as { mining: Promise<void> }).mining.catch(() => undefined);
      await tstate.storage.deleteAlarm();
    });

    expect(touched).toEqual([]);
    const rest = fake.calls.filter((c) => c.kind === "rest");
    expect(rest.length).toBeGreaterThan(10);
    expect(rest.every((c) => c.account === fake.accountId && c.bearer === fake.accessToken)).toBe(true);
    expect(fake.createdNamespaces.sort()).toEqual(["firetrident-trunk", "firetrident-ws-0", "firetrident-ws-1", "firetrident-ws-2", "firetrident-ws-3"]);
    // Git used repository tokens the API minted, never the Cloudflare access token.
    expect(fake.calls.filter((c) => c.kind === "git").every((c) => c.bearer.startsWith("art_v1_"))).toBe(true);
  });

  it("an operator colony goes the same way through the deployment's bindings, its refs unchanged and no grant asked", async () => {
    const colonyId = `op_${Date.now()}`;
    const e = operatorEnv();
    const ownedCalls = fake.calls.length;
    const asked = grantsAsked;
    const { trunk, trunkSha } = await provisionTrunk(e, colonyId);
    expect(Object.keys(trunk).sort()).toEqual(["name", "namespace", "remote"]);
    await runInDurableObject(env.TRUNK.get(env.TRUNK.idFromName(`op-trunk-${colonyId}`)), async (_i: unknown, tstate: DurableObjectState) => {
      const writer = new TrunkDO(tstate, e);
      await writer.init({ colonyId, trunk });
      let lease: WorkspaceLease | null = null;
      await runInDurableObject(env.POOL.get(env.POOL.idFromName(`op-pool-${colonyId}`)), async (_p: unknown, pstate: DurableObjectState) => {
        const pool = new PoolDO(pstate, e);
        await pool.init({ colonyId, trunk, target: 1 });
        lease = await pool.lease("agt_op", trunkSha);
        await pstate.storage.deleteAlarm();
      });
      const l = lease as WorkspaceLease | null;
      expect(Object.keys(l!.repo).sort()).toEqual(["name", "namespace", "remote"]);
      const g: GitRepo = { fs: memoryFs(), dir: "/agent", cache: {} };
      await ensureRepo(g, l!.repo.remote);
      await fetchRef(g, { url: l!.trunk.remote, token: l!.trunk.token, ref: "refs/heads/main", depth: 1 });
      const blob = await writeLocalBlob(g, enc.encode("export const op = 1;\n"));
      const tree = await applyTreeChanges(g, (await commitTree(g, trunkSha))!, new Map([["op.ts", { blob, mode: NEW_FILE_MODE }]]));
      const headSha = await writeCommitObject(g, { tree, parents: [trunkSha], message: "Add op", at: Date.now() });
      await setRef(g, "refs/heads/main", headSha);
      await pushRef(g, { url: l!.repo.remote, token: l!.token, localRef: "refs/heads/main", remoteRef: "refs/heads/main", force: true });
      const proposal = { id: "prp_op", colonyId, intentId: "int_op", agentId: "agt_op", workspace: l!.repo, baseSha: trunkSha, headSha, writeSet: [{ path: "op.ts", blob }], readSet: [], declared: { footprint: ["op.ts"], summary: "Add op" }, evidence: { checks: [] }, status: "ready", createdAt: Date.now() } as unknown as Proposal;
      const result = await writer.land([proposal]);
      expect(result.returned).toEqual([]);
      expect(await operator.readText("ft-trunk", trunk.name, "op.ts")).toBe("export const op = 1;\n");
      await writer.flushNotes();
      for (let i = 0; i < 100 && (writer as unknown as { mining: Promise<void> | null }).mining; i++) await (writer as unknown as { mining: Promise<void> }).mining.catch(() => undefined);
      await tstate.storage.deleteAlarm();
    });
    expect(fake.calls.length).toBe(ownedCalls);
    expect(grantsAsked).toBe(asked);
    expect(operator.calls.filter((c) => c.kind === "rest").every((c) => c.bearer === operator.accessToken)).toBe(true);
  });

  it("a colony object reads and writes Artifacts in its owner's account, and an operator colony with its own env", async () => {
    const stamp = Date.now();
    // A workspace in the owner's account holding one README commit, and that README's blob id.
    const workspace = `byo_col_${stamp}--ws-1`;
    const made = await colonyStorageOf(OWNER).workspace(1).create(workspace);
    const head = await pushReadme(made.remote, made.token, "colony object read\n");
    const repo = await colonyStorageOf(OWNER).workspace(1).get(workspace);
    const readmeBlob = (await repo.readTree((await repo.readCommit(head))!.treeHash))![0]!.hash;
    const wsBlob = (e: Env): Promise<Map<string, Uint8Array | null>> => bindingReader(e)({ namespace: "ft-ws-1", name: workspace }, [readmeBlob]);
    type Inside = { env: Env; storageEnv(): Env; decider(): unknown; audits(): unknown };
    const hostEnv = (x: unknown): Env => (x as { host: { env: Env } }).host.env;
    await runInDurableObject(env.COLONY.get(env.COLONY.idFromName(`byo_col_${stamp}`)), async (instance: unknown) => {
      const c = instance as Inside & { init(p: unknown): Promise<unknown> };
      await c.init({ colonyId: `byo_col_${stamp}`, name: "owned", trunk: { namespace: "ft-trunk", name: `byo_col_${stamp}--trunk`, remote: "https://example.invalid/t.git", owner: OWNER }, trunkSha: "a".repeat(40) });
      const se = c.storageEnv();
      expect(se).not.toBe(c.env);
      expect(se.FT_ADMIN_TOKEN).toBe(c.env.FT_ADMIN_TOKEN);
      // The decide stage and the audit read through the owner's storage.
      expect(new TextDecoder().decode((await wsBlob(hostEnv(c.decider()))).get(readmeBlob)!)).toBe("colony object read\n");
      expect(new TextDecoder().decode((await wsBlob(hostEnv(c.audits()))).get(readmeBlob)!)).toBe("colony object read\n");
    });
    await runInDurableObject(env.COLONY.get(env.COLONY.idFromName(`op_col_${stamp}`)), async (instance: unknown) => {
      const c = instance as Inside & { init(p: unknown): Promise<unknown> };
      await c.init({ colonyId: `op_col_${stamp}`, name: "operator", trunk: { namespace: "ft-trunk", name: `op_col_${stamp}--trunk`, remote: "https://example.invalid/o.git" }, trunkSha: "b".repeat(40) });
      expect(c.storageEnv()).toBe(c.env);
      expect(hostEnv(c.decider())).toBe(c.env);
      expect(hostEnv(c.audits())).toBe(c.env);
    });
  });

  it("gives an in-platform agent its colony's owner at start, kept for its trunk reads", async () => {
    const colonyId = `byo_agent_${Date.now()}`;
    const { trunkSha } = await provisionOwnedTrunk(ownedEnv(), colonyId, OWNER);
    // The agent's model and colony calls are not part of this: it keeps the harness's colony binding.
    const e = Object.create(ownedEnv(), { COLONY: { value: env.COLONY, enumerable: true } }) as Env;
    const agentId = `agt_${colonyId}`;
    await runInDurableObject(env.POOL.get(env.POOL.idFromName(agentId)), async (_a: unknown, state: DurableObjectState) => {
      const agent = new AgentDO(state, e);
      await agent.start({ colonyId, agentId, owner: OWNER, delayMs: 60_000 });
      await state.storage.deleteAlarm();
      const internals = agent as unknown as { deps(colonyId: string): unknown; trunkRepo: { tip(): Promise<string | null>; release(): void } };
      internals.deps(colonyId);
      expect(await internals.trunkRepo.tip()).toBe(trunkSha);
      internals.trunkRepo.release();
    });
    expect(touched).toEqual([]);
  });
});
