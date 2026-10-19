import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDO } from "../../src/agents/AgentDO.ts";
import { setStorageResolver } from "../../src/artifacts/storage.ts";
import { MODELS_OFF, PERSON_DECIDES } from "../../src/cloudflare/models.ts";
import type { CloudflareGrant } from "../../src/cloudflare/types.ts";
import type { Env } from "../../src/env.ts";
import { env } from "./helpers.ts";

/**
 * Where the models of a colony a person owns run (cloudflare/models.ts colonyModelsOf, wired into ColonyDO and AgentDO):
 * the owner's Workers AI when their Cloudflare connection allows it, and nowhere at all otherwise, never the deployment's
 * binding. The owner's connection comes from the storage resolver the Worker installs (artifacts/storage.ts).
 */

const OWNER = "acc_models_owner";
const WITH_AI: CloudflareGrant = { accountId: "c".repeat(32), accessToken: "owner-access", scopes: ["artifacts.read", "artifacts.write", "ai.read"] };
const WITHOUT_AI: CloudflareGrant = { ...WITH_AI, scopes: ["artifacts.read", "artifacts.write"] };

/** Install a resolver whose owner's connection is `grant()` (a function, so a test can change it or make it fail). */
function connection(grant: () => Promise<CloudflareGrant | null>): void {
  setStorageResolver({ ownerOf: async () => OWNER, grantFor: async (_env, account) => (account === OWNER ? grant() : null) });
}

afterEach(() => setStorageResolver(null));

/** The deployment's Workers AI as a binding that fails the test if anything runs a model on it. */
const tripwireAi = {
  run: async () => {
    throw new Error("the deployment's Workers AI ran a model for a colony a person owns");
  },
};

describe("an owned colony's models in the colony object", () => {
  type Inside = { env: Env; refreshModels(): Promise<void>; modelEnv(): Env; modelsOffReason(): string | null; decider(): { enabled(): boolean }; ownedModels: { at: number } | null; init(p: unknown): Promise<unknown> };

  it("reads the owner's Workers AI, keeps review off until it has, and turns it off when the connection loses it", async () => {
    let grant: CloudflareGrant | null = WITH_AI;
    connection(async () => grant);
    const id = `owned_models_${Date.now()}`;
    await runInDurableObject(env.COLONY.get(env.COLONY.idFromName(id)), async (instance: unknown) => {
      const c = instance as Inside;
      c.env = Object.create(c.env, { AI: { value: tripwireAi, enumerable: true }, ANTHROPIC_API_KEY: { value: "deployment-key", enumerable: true } }) as Env;
      await c.init({ colonyId: id, name: "owned", trunk: { namespace: "ft-trunk", name: `${id}--trunk`, remote: "https://example.invalid/t.git", owner: OWNER }, trunkSha: "a".repeat(40) });
      // Not read yet: no model at all (fail closed), not the deployment's; review stays on, with a person for every model.
      expect(c.modelEnv().AI).toBeUndefined();
      expect(c.decider().enabled()).toBe(true);
      expect(c.modelsOffReason()).toBe(PERSON_DECIDES.not_connected);
      await c.refreshModels();
      const on = c.modelEnv();
      expect(on.AI).toBeDefined();
      expect(on.AI).not.toBe(tripwireAi);
      expect(on.ANTHROPIC_API_KEY).toBeUndefined();
      expect(on.FT_ADMIN_TOKEN).toBe(c.env.FT_ADMIN_TOKEN);
      expect(c.decider().enabled()).toBe(true);
      expect(c.modelsOffReason()).toBeNull();
      // Within the minute the read stands; after it, a connection without Workers AI leaves review to a person.
      grant = WITHOUT_AI;
      await c.refreshModels();
      expect(c.modelEnv().AI).toBe(on.AI);
      c.ownedModels!.at -= 61_000;
      await c.refreshModels();
      expect(c.modelEnv().AI).toBeUndefined();
      expect(c.decider().enabled()).toBe(true);
      expect(c.modelsOffReason()).toBe(PERSON_DECIDES.no_workers_ai);
    });
  });

  it("leaves an operator colony on the deployment's env, the same object, and never asks for a connection", async () => {
    let asked = 0;
    connection(async () => {
      asked++;
      return WITH_AI;
    });
    const id = `operator_models_${Date.now()}`;
    await runInDurableObject(env.COLONY.get(env.COLONY.idFromName(id)), async (instance: unknown) => {
      const c = instance as Inside;
      await c.init({ colonyId: id, name: "operator", trunk: { namespace: "ft-trunk", name: `${id}--trunk`, remote: "https://example.invalid/o.git" }, trunkSha: "b".repeat(40) });
      await c.refreshModels();
      expect(c.modelEnv()).toBe(c.env);
      expect(c.modelsOffReason()).toBeNull();
      // The harness binds no Workers AI: an operator colony's review stays off, as before.
      expect(c.decider().enabled()).toBe(false);
    });
    expect(asked).toBe(0);
  });
});

describe("an owned colony's in-platform agent", () => {
  /** An agent object over a spare object's storage, started for an owned colony, and its first tick. */
  async function tick(grant: () => Promise<CloudflareGrant | null>): Promise<{ running: boolean; stopReason?: string; alarm: number | null }> {
    connection(grant);
    const agentId = `agt_models_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    let out: { running: boolean; stopReason?: string; alarm: number | null } = { running: false, alarm: null };
    await runInDurableObject(env.POOL.get(env.POOL.idFromName(agentId)), async (_i: unknown, state: DurableObjectState) => {
      const e = Object.create(env, { AI: { value: tripwireAi, enumerable: true } }) as Env;
      const agent = new AgentDO(state, e);
      await agent.start({ colonyId: "owned-agents", agentId, owner: OWNER, delayMs: 60_000 });
      await agent.alarm();
      const status = (await agent.status()) as { running: boolean; stopReason?: string };
      out = { running: status.running, ...(status.stopReason ? { stopReason: status.stopReason } : {}), alarm: await state.storage.getAlarm() };
      await state.storage.deleteAlarm();
    });
    return out;
  }

  it("stops with the sentence when the owner's connection has no Workers AI", async () => {
    expect(await tick(async () => WITHOUT_AI)).toEqual({ running: false, stopReason: MODELS_OFF.no_workers_ai, alarm: null });
    expect(await tick(async () => null)).toEqual({ running: false, stopReason: MODELS_OFF.not_connected, alarm: null });
  });

  it("tries again shortly when the connection could not be read, still running", async () => {
    const before = Date.now();
    const r = await tick(async () => {
      throw new Error("the grant object did not answer");
    });
    expect(r.running).toBe(true);
    expect(r.alarm).toBeGreaterThanOrEqual(before + 29_000);
  });
});
