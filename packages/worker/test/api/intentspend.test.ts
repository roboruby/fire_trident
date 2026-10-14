import { describe, expect, it } from "vitest";
import { intentSpend } from "@fire_trident/core";
import type { IntentSpend } from "@fire_trident/core";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";

/**
 * The public reads of one intent's spend: GET /colonies/:id/intents/:iid/spend answers the colony's report, and GET
 * /colonies/:id/intents/:iid carries it beside the intent's history when something was counted.
 */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const CLEF = "@cf/cloudflare/clef";

const COUNTED: IntentSpend = intentSpend("int_1", [
  { layer: "agents", model: GEMMA, calls: 2, input: 900, output: 60 },
  { layer: "review", model: CLEF, calls: 1, input: 1_500, output: 0 },
]);
const NONE: IntentSpend = intentSpend("int_2", []);

const HISTORY = (id: string) => ({ intent: { id, colonyId: "col", title: `Intent ${id}`, why: "w", source: "human", footprint: ["src/a.ts"], priority: 1, status: "landed", createdAt: 1, createdBy: "t" }, revisions: [], directives: [] });

/** An env with one colony whose intent int_1 was counted for, int_2 was not, and int_x does not exist. */
function env(opts: { older?: boolean } = {}): { env: Env; asked: string[] } {
  const asked: string[] = [];
  const COLONY = {
    idFromName: (n: string) => n,
    get: () => ({
      intentSpend: async (id: string) => {
        asked.push(`intentSpend ${id}`);
        if (opts.older) throw new Error('The RPC receiver does not implement the method "intentSpend".');
        return id === "int_1" ? COUNTED : id === "int_2" ? { ...NONE, note: "not counting" } : null;
      },
      intentHistory: async (id: string) => {
        asked.push(`intentHistory ${id}`);
        return id === "int_1" || id === "int_2" ? HISTORY(id) : null;
      },
    }),
  };
  return { env: { COLONY } as unknown as Env, asked };
}

const get = async (e: Env, path: string): Promise<{ status: number; json: any }> => {
  const res = await createApi(deps).request(path, {}, e);
  return { status: res.status, json: await res.json() };
};

describe("GET /colonies/:id/intents/:iid/spend", () => {
  it("answers the colony's report for the intent, without a token", async () => {
    const { env: e, asked } = env();
    const res = await get(e, "/colonies/col/intents/int_1/spend");
    expect(res.status).toBe(200);
    expect(res.json).toEqual(JSON.parse(JSON.stringify(COUNTED)));
    expect(res.json.usd).toBeCloseTo(0.000468, 10);
    expect(asked).toEqual(["intentSpend int_1"]);
  });

  it("says when nothing was counted, and names an unknown intent", async () => {
    const { env: e } = env();
    const none = await get(e, "/colonies/col/intents/int_2/spend");
    expect(none.status).toBe(200);
    expect(none.json).toMatchObject({ intentId: "int_2", usd: 0, tokens: { input: 0, output: 0 }, note: "not counting" });
    const unknown = await get(e, "/colonies/col/intents/int_x/spend");
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe("unknown intent int_x");
  });
});

describe("GET /colonies/:id/intents/:iid", () => {
  it("carries the intent's spend beside its history when something was counted, and nothing otherwise", async () => {
    const { env: e, asked } = env();
    const one = await get(e, "/colonies/col/intents/int_1");
    expect(one.status).toBe(200);
    expect(one.json.intent.id).toBe("int_1");
    expect(one.json.spend).toEqual(JSON.parse(JSON.stringify(COUNTED)));
    const two = await get(e, "/colonies/col/intents/int_2");
    expect(two.status).toBe(200);
    expect(two.json.spend).toBeUndefined();
    expect((await get(e, "/colonies/col/intents/int_x")).status).toBe(404);
    expect(asked).toEqual(["intentHistory int_1", "intentSpend int_1", "intentHistory int_2", "intentSpend int_2", "intentHistory int_x", "intentSpend int_x"]);
  });

  it("still answers the history while the colony object is on code without the spend", async () => {
    const { env: e } = env({ older: true });
    const one = await get(e, "/colonies/col/intents/int_1");
    expect(one.status).toBe(200);
    expect(one.json.intent.id).toBe("int_1");
    expect(one.json.spend).toBeUndefined();
  });
});
