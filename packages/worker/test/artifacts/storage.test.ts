import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetKnownNamespaces } from "../../src/artifacts/rest.ts";
import { bindingFor } from "../../src/artifacts/shards.ts";
import {
  OWNED_SESSIONS_NAMESPACE,
  OWNED_TRUNK_NAMESPACE,
  colonyOwnerOf,
  colonyStorage,
  ownedStorage,
  ownedWorkspaceNamespace,
  provisionOwnedTrunk,
  setStorageResolver,
  storageEnv,
  storageFor,
  type CloudflareGrant,
  type StorageResolver,
} from "../../src/artifacts/storage.ts";
import type { Env } from "../../src/env.ts";
import { FakeArtifacts } from "./fake-artifacts.ts";

/** An env whose Artifacts bindings are plain marker objects (identity is what these tests compare). */
function operatorEnv(extra: Record<string, unknown> = {}): Env {
  return { ARTIFACTS: { ns: "ft-trunk" }, WS0: { ns: 0 }, WS1: { ns: 1 }, WS2: { ns: 2 }, WS3: { ns: 3 }, SESSIONS: { ns: "s" }, FT_DEFAULT_MODEL: "m", ...extra } as unknown as Env;
}

let fake: FakeArtifacts;
let grants = 0;
const OWNER = "acc_owner";
const grantFor = async (account: string): Promise<CloudflareGrant | null> => {
  grants++;
  return account === OWNER ? { accountId: fake.accountId, accessToken: fake.accessToken, scopes: ["artifacts.read", "artifacts.write"] } : null;
};

beforeEach(() => {
  fake = new FakeArtifacts();
  grants = 0;
  forgetKnownNamespaces();
  setStorageResolver(null);
});

afterEach(() => {
  setStorageResolver(null);
  vi.unstubAllGlobals();
});

describe("storageFor: an operator colony", () => {
  it("is the deployment's own binding objects, unwrapped, and asks for no grant", async () => {
    const env = operatorEnv();
    const s = await storageFor(env, "col_a", null, grantFor);
    expect(s.owner).toBeNull();
    expect(s.trunk).toBe(env.ARTIFACTS);
    expect(s.sessions).toBe(env.SESSIONS);
    expect(s.workspace(5)).toBe(env.WS1);
    for (const ns of ["ft-trunk", "ft-ws-0", "ft-ws-3", "ft-sessions", "ft-ws-4", "firetrident-trunk", "elsewhere"]) expect(s.bindingFor(ns)).toBe(bindingFor(env, ns));
    expect(s.namespaces().map((n) => n.namespace)).toEqual(["ft-trunk", "ft-ws-0", "ft-ws-1", "ft-ws-2", "ft-ws-3", "ft-sessions"]);
    expect(s.namespaces()[0]!.binding).toBe(env.ARTIFACTS);
    expect(storageEnv(env, s)).toBe(env);
    expect(colonyStorage(env, undefined).trunk).toBe(env.ARTIFACTS);
    expect(colonyStorage(env, "").workspace(2)).toBe(env.WS2);
    expect(grants).toBe(0);
  });
});

describe("storageFor: an owned colony", () => {
  it("maps the RepoRef namespace names (and the real ones) to the owner's namespaces, and nothing else", async () => {
    const s = await storageFor(operatorEnv(), "col_b", OWNER, grantFor);
    expect(s.owner).toBe(OWNER);
    expect(s.bindingFor("ft-trunk")).toBe(s.trunk);
    expect(s.bindingFor(OWNED_TRUNK_NAMESPACE)).toBe(s.trunk);
    expect(s.bindingFor("ft-sessions")).toBe(s.sessions);
    expect(s.bindingFor(OWNED_SESSIONS_NAMESPACE)).toBe(s.sessions);
    expect(s.bindingFor("ft-ws-2")).toBe(s.workspace(2));
    expect(s.bindingFor(ownedWorkspaceNamespace(2))).toBe(s.workspace(6));
    expect(s.bindingFor("ft-ws-4")).toBeNull();
    expect(s.bindingFor("elsewhere")).toBeNull();
    expect(s.namespaces().map((n) => n.namespace)).toEqual(["firetrident-trunk", "firetrident-ws-0", "firetrident-ws-1", "firetrident-ws-2", "firetrident-ws-3", "firetrident-sessions"]);
  });

  it("calls the connection's Cloudflare account with its token, refreshed per call", async () => {
    const s = ownedStorage(OWNER, grantFor, "Colony col_c", { fetch: fake.fetch });
    await s.workspace(1).create("col_c--seed");
    expect(fake.repo("firetrident-ws-1", "col_c--seed")).toBeDefined();
    expect(fake.createdNamespaces).toEqual(["firetrident-ws-1"]);
    const before = grants;
    fake.accessToken = "cf-access-next";
    const refreshed = ownedStorage(OWNER, async (a) => ({ ...(await grantFor(a))!, accessToken: "cf-access-next" }), "Colony col_c", { fetch: fake.fetch });
    expect(await refreshed.workspace(1).delete("col_c--seed")).toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({ account: fake.accountId, bearer: "cf-access-next" });
    expect(grants).toBeGreaterThan(before);
  });

  it("refuses in a plain sentence, and calls nothing, without a connection; never falls back to the deployment's bindings", async () => {
    const env = operatorEnv();
    const s = ownedStorage("acc_other", grantFor, "Colony col_d", { fetch: fake.fetch });
    await expect(s.trunk.get("col_d--trunk")).rejects.toMatchObject({ code: "NOT_CONNECTED", message: expect.stringMatching(/^Colony col_d's repositories are in its owner's Cloudflare account/) });
    expect(fake.calls).toHaveLength(0);
    expect(s.trunk).not.toBe(env.ARTIFACTS);
    const broken = ownedStorage(OWNER, async () => {
      throw new Error("grant store unavailable");
    }, "Colony col_d", { fetch: fake.fetch });
    await expect(broken.trunk.list()).rejects.toMatchObject({ code: "INTERNAL_ERROR", message: expect.stringContaining("grant store unavailable") });
  });

  it("storageEnv answers the Artifacts bindings from the owner's storage and keeps every other variable", async () => {
    const env = operatorEnv();
    const s = await storageFor(env, "col_e", OWNER, grantFor);
    const e = storageEnv(env, s);
    expect(e).not.toBe(env);
    expect(e.ARTIFACTS).toBe(s.trunk);
    expect(e.SESSIONS).toBe(s.sessions);
    expect(bindingFor(e, "ft-ws-3")).toBe(s.workspace(3));
    expect(e.FT_DEFAULT_MODEL).toBe("m");
    expect(env.ARTIFACTS).toEqual({ ns: "ft-trunk" });
  });
});

describe("the resolver", () => {
  it("looks nothing up without a resolver, or with FT_ACCOUNTS off", async () => {
    const ownerOf = vi.fn(async () => OWNER);
    expect(await colonyOwnerOf(operatorEnv({ FT_ACCOUNTS: "on" }), "col_f")).toBeNull();
    setStorageResolver({ ownerOf, grantFor: async (_env, a) => grantFor(a) });
    expect(await colonyOwnerOf(operatorEnv(), "col_f")).toBeNull();
    expect(await colonyOwnerOf(operatorEnv({ FT_ACCOUNTS: "off" }), "col_f")).toBeNull();
    expect(ownerOf).not.toHaveBeenCalled();
    expect(await colonyOwnerOf(operatorEnv({ FT_ACCOUNTS: "on" }), "col_f")).toBe(OWNER);
  });

  it("gives colonyStorage the installed resolver's grant; with none installed an owned colony is refused", async () => {
    vi.stubGlobal("fetch", fake.fetch);
    const env = operatorEnv();
    await expect(colonyStorage(env, OWNER).trunk.list()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    const r: StorageResolver = { ownerOf: async () => OWNER, grantFor: async (_env, a) => grantFor(a) };
    setStorageResolver(r);
    expect((await colonyStorage(env, OWNER).trunk.list()).repos).toEqual([]);
  });
});

describe("provisionOwnedTrunk", () => {
  it("makes the trunk in the owner's account with a README commit, and the RepoRef names the owner", async () => {
    vi.stubGlobal("fetch", fake.fetch);
    const env = operatorEnv();
    const { trunk, trunkSha } = await provisionOwnedTrunk(env, "col_g", OWNER, undefined, grantFor);
    expect(trunk).toEqual({ namespace: "ft-trunk", name: "col_g--trunk", remote: `${fake.gitHost}/git/firetrident-trunk/col_g--trunk.git`, owner: OWNER });
    expect(await fake.head("firetrident-trunk", "col_g--trunk")).toBe(trunkSha);
    expect(await fake.readText("firetrident-trunk", "col_g--trunk", "README.md")).toMatch(/FireTrident colony trunk/);
    // Idempotent: a second call reuses the trunk.
    expect((await provisionOwnedTrunk(env, "col_g", OWNER, undefined, grantFor)).trunkSha).toBe(trunkSha);
  });

  it("imports a public repository whose default branch is not main and gives it a main", async () => {
    vi.stubGlobal("fetch", fake.fetch);
    const head = await fake.addSource("https://git.example.invalid/acme/lib", { "lib.ts": "export {};\n" }, "trunk");
    const { trunk, trunkSha } = await provisionOwnedTrunk(operatorEnv(), "col_h", OWNER, { url: "https://git.example.invalid/acme/lib" }, grantFor);
    expect(trunk.owner).toBe(OWNER);
    expect(trunkSha).toBe(head);
    expect(await fake.head("firetrident-trunk", "col_h--trunk")).toBe(head);
  });
});
