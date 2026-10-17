import { describe, expect, it } from "vitest";
import type { TrunkRoot } from "@fire_trident/core";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";

/** GET /api/colonies/:id/root: the colony's root commit, which pins a clone of its history. */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};

const ROOT: TrunkRoot = { colonyId: "col", rootSha: "f".repeat(40), shallow: true, at: 2 };

function env(exists = true): { env: Env; asked: number[] } {
  const asked: number[] = [];
  const COLONY = { idFromName: (n: string) => n, get: () => ({ getColony: async () => (exists ? { id: "col" } : null) }) };
  const TRUNK = { idFromName: (n: string) => n, get: () => ({ rootCommit: async () => (asked.push(1), ROOT) }) };
  return { env: { COLONY, TRUNK } as unknown as Env, asked };
}

const get = async (e: Env, path: string): Promise<{ status: number; json: unknown }> => {
  const res = await createApi(deps).request(path, {}, e);
  return { status: res.status, json: await res.json() };
};

describe("root route", () => {
  it("answers the trunk writer's root to anyone", async () => {
    const { env: e, asked } = env();
    expect(await get(e, "/colonies/col/root")).toEqual({ status: 200, json: ROOT });
    expect(asked).toEqual([1]);
  });

  it("is 404 for an unknown colony or a name that is not one, without asking the trunk writer", async () => {
    const { env: e, asked } = env(false);
    expect((await get(e, "/colonies/col/root")).status).toBe(404);
    expect((await get(env().env, "/colonies/Not_A_Slug/root")).status).toBe(404);
    expect(asked).toEqual([]);
  });
});
