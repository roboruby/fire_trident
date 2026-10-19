import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Colony } from "@fire_trident/core";
import { spawnSwarm } from "../../src/agents/swarm.ts";
import { ArtifactsTrunkAccess } from "../../src/api/git-proxy.ts";
import { deleteColony } from "../../src/api/ops.ts";
import { forgetKnownNamespaces } from "../../src/artifacts/rest.ts";
import { colonyStorage, ownedStorage, setStorageResolver, storageEnv, type CloudflareGrant } from "../../src/artifacts/storage.ts";
import { bindingReader } from "../../src/colony/innate.ts";
import { pushQuarantine, quarantineRepoName } from "../../src/decide/quarantine.ts";
import type { Env } from "../../src/env.ts";
import { FakeArtifacts } from "./fake-artifacts.ts";
import { pushReadme } from "./rest-helpers.ts";

/**
 * The places that reach Artifacts outside the trunk writer and the pool, for a colony a person owns: the public git
 * proxy, the swarm, colony deletion, the decide stage's blob reads and the quarantine repo. Each goes to the owner's
 * Cloudflare account (a fake), and the deployment's own bindings, tripwires here, are never touched.
 */

const OWNER = "acc_paths_owner";
let fake: FakeArtifacts;
let touched: string[];

function tripwire(name: string): Artifacts {
  return new Proxy({} as Artifacts, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      touched.push(`${name}.${String(prop)}`);
      return () => {
        throw new Error(`the deployment's ${name} binding was used`);
      };
    },
  });
}

function env(extra: Record<string, unknown> = {}): Env {
  return { ARTIFACTS: tripwire("ARTIFACTS"), WS0: tripwire("WS0"), WS1: tripwire("WS1"), WS2: tripwire("WS2"), WS3: tripwire("WS3"), SESSIONS: tripwire("SESSIONS"), FT_ACCOUNTS: "on", FT_DEFAULT_MODEL: "m", FT_BULK_MODEL: "b", ...extra } as unknown as Env;
}

/** The owner's connection: Artifacts, and Workers AI unless a test says otherwise (in-platform agents need it). */
let scopes: string[];
const grant = (): CloudflareGrant => ({ accountId: fake.accountId, accessToken: fake.accessToken, scopes });

beforeEach(() => {
  fake = new FakeArtifacts();
  touched = [];
  scopes = ["artifacts.read", "artifacts.write", "ai.read", "ai.write"];
  forgetKnownNamespaces();
  vi.stubGlobal("fetch", fake.fetch);
  setStorageResolver({ ownerOf: async (_e, colonyId) => (colonyId.startsWith("own") ? OWNER : null), grantFor: async (_e, a) => (a === OWNER ? grant() : null) });
});

afterEach(() => {
  setStorageResolver(null);
  vi.unstubAllGlobals();
});

describe("the public git proxy", () => {
  it("finds an owned colony's trunk in the owner's account and an operator colony's in the deployment's binding", async () => {
    const made = await colonyStorage(env(), OWNER).trunk.create("own1--trunk");
    const operator = { stats: { gets: 0 }, async get(name: string) {
      this.stats.gets++;
      throw Object.assign(new Error(`no repo ${name}`), { code: "NOT_FOUND" });
    } };
    const lookups: string[] = [];
    const access = new ArtifactsTrunkAccess(operator as unknown as Artifacts, async (colony) => {
      lookups.push(colony);
      return colony.startsWith("own") ? colonyStorage(env(), OWNER).trunk : null;
    });
    expect(await access.remote("own1")).toBe(made.remote);
    expect((await access.token("own1")).startsWith("art_v1_")).toBe(true);
    expect(await access.remote("plain")).toBeNull();
    expect(operator.stats.gets).toBe(1);
    // The owner is looked up once per colony.
    expect(lookups).toEqual(["own1", "plain"]);
    const failing = new ArtifactsTrunkAccess(operator as unknown as Artifacts, async () => {
      throw new Error("accounts unavailable");
    });
    await expect(failing.remote("own2")).rejects.toThrow("accounts unavailable");
    expect(touched).toEqual([]);
  });
});

describe("the swarm", () => {
  function swarmEnv(extra: Record<string, unknown> = {}) {
    const starts: Array<Record<string, unknown>> = [];
    const e = env({
      COLONY: { idFromName: (n: string) => n, get: () => ({ registerAgents: async (list: Array<{ name: string }>) => list.map((a, i) => ({ ...a, id: `agt_${i}` })) }) },
      AGENT: { idFromName: (n: string) => n, get: () => ({ start: async (p: Record<string, unknown>) => void starts.push(p) }) },
      ...extra,
    });
    return { e, starts };
  }

  it("tells each agent its colony's owner, and says nothing for an operator colony or with accounts off", async () => {
    const owned = swarmEnv();
    expect((await spawnSwarm(owned.e, "own-colony", { count: 2, staggerMs: 0 })).started).toBe(2);
    expect(owned.starts.map((s) => s.owner)).toEqual([OWNER, OWNER]);
    const plain = swarmEnv();
    await spawnSwarm(plain.e, "plain-colony", { count: 1, staggerMs: 0 });
    expect("owner" in plain.starts[0]!).toBe(false);
    const off = swarmEnv({ FT_ACCOUNTS: undefined });
    await spawnSwarm(off.e, "own-colony", { count: 1, staggerMs: 0 });
    expect("owner" in off.starts[0]!).toBe(false);
  });

  it("starts no agent on an owned colony whose connection has no Workers AI, and says why (409)", async () => {
    scopes = ["artifacts.read", "artifacts.write"];
    const owned = swarmEnv();
    await expect(spawnSwarm(owned.e, "own-colony", { count: 2, staggerMs: 0 })).rejects.toThrow(
      "[ft:409] In-platform agents and model review are off: this colony's Cloudflare connection has no Workers AI access.",
    );
    expect(owned.starts).toEqual([]);
    // An operator colony is not asked about it.
    const plain = swarmEnv();
    expect((await spawnSwarm(plain.e, "plain-colony", { count: 1, staggerMs: 0 })).started).toBe(1);
  });
});

describe("colony deletion", () => {
  it("sweeps the owner's namespaces for an owned colony's repos, leaving other repos", async () => {
    const s = colonyStorage(env(), OWNER);
    await s.trunk.create("own3--trunk");
    await s.workspace(0).create("own3--ws-0");
    await s.workspace(1).create("own3--seed");
    await s.trunk.create("other--trunk");
    const record = { id: "own3", name: "own3", trunk: { namespace: "ft-trunk", name: "own3--trunk", remote: "x", owner: OWNER } } as unknown as Colony;
    const stub = {
      getColony: async () => record,
      listRegions: async () => [],
      listAgents: async () => [],
      destroy: async () => undefined,
      unregisterColony: async () => true,
    };
    const e = env({
      COLONY: { idFromName: (n: string) => n, get: () => stub },
      POOL: { idFromName: (n: string) => n, get: () => ({ teardown: async () => ({ deleted: 0, errors: [] }), destroy: async () => undefined }) },
      TRUNK: { idFromName: (n: string) => n, get: () => ({ destroy: async () => undefined }) },
      REGION: { idFromName: (n: string) => n, get: () => ({}) },
    });
    const report = await deleteColony(e, "own3");
    expect(report.ok).toBe(true);
    expect(report.repos.deleted.sort()).toEqual(["firetrident-trunk/own3--trunk", "firetrident-ws-0/own3--ws-0", "firetrident-ws-1/own3--seed"]);
    expect(fake.repo("firetrident-trunk", "other--trunk")).toBeDefined();
    expect(touched).toEqual([]);
  });
});

describe("the decide stage's reads and the quarantine repo", () => {
  it("read a workspace blob and write the quarantine repo in the owner's account through storageEnv", async () => {
    const s = ownedStorage(OWNER, async () => grant(), "Colony own4");
    const ws = await s.workspace(2).create("own4--ws-2");
    await pushReadme(ws.remote, ws.token, "owned bytes\n");
    const tree = await (await s.workspace(2).get("own4--ws-2")).readTree((await (await s.workspace(2).get("own4--ws-2")).log({ ref: "main", limit: 1 }))[0]!.treeHash);
    const blob = tree![0]!.hash;
    const e = storageEnv(env(), s);
    const read = await bindingReader(e)({ namespace: "ft-ws-2", name: "own4--ws-2" }, [blob]);
    expect(new TextDecoder().decode(read.get(blob)!)).toBe("owned bytes\n");
    const q = await pushQuarantine(e, "own4", [{ files: [{ path: "a.ts", content: "x\n" }], message: "vaccine" }]);
    expect(q.repo).toMatchObject({ namespace: "ft-sessions", name: quarantineRepoName("own4") });
    expect(fake.repo("firetrident-sessions", quarantineRepoName("own4"))).toBeDefined();
    expect(touched).toEqual([]);
  });
});
