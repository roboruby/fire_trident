import { describe, expect, it } from "vitest";
import type { LandingTests } from "@fire_trident/core";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";

/** GET /colonies/:id/landings/:ref/tests: one landing's test row, a public read for any colony, like the certification reads. */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};

const ROW: LandingTests = {
  colonyId: "col",
  landingId: "lnd_one",
  trunkSha: "2".repeat(40),
  baseSha: "1".repeat(40),
  status: "certified",
  base: { sha: "1".repeat(40), status: "red", pass: 433, tests: 434, failing: 1, exact: true },
  certified: { sha: "2".repeat(40), status: "green", pass: 434, tests: 434, failing: 0 },
  lost: 0,
  proof: { rungs: [{ rung: "deterministic", count: 1 }], text: "deterministic" },
  spend: { usd: 0.0003, calls: 1, intents: 1 },
  text: "433/434 at base, 434/434 certified, 0 lost · proof: deterministic · $0.0003 (model calls this platform made)",
};

function env(known = true): { env: Env; asked: string[] } {
  const asked: string[] = [];
  const COLONY = {
    idFromName: (n: string) => n,
    get: () => ({
      getColony: async () => (known ? { id: "col" } : null),
      landingTests: async (ref: string) => (asked.push(ref), ref === "lnd_one" || "2".repeat(40).startsWith(ref) ? ROW : null),
    }),
  };
  return { env: { COLONY, FT_ADMIN_TOKEN: "secret" } as unknown as Env, asked };
}

const get = async (e: Env, path: string): Promise<{ status: number; json: any }> => {
  const res = await createApi(deps).request(path, {}, e);
  return { status: res.status, json: JSON.parse(await res.text()) };
};

describe("a landing's test row over the API", () => {
  it("answers the row without a token, by landing id or by the commit it made", async () => {
    const w = env();
    expect(await get(w.env, "/colonies/col/landings/lnd_one/tests")).toEqual({ status: 200, json: ROW });
    expect((await get(w.env, "/colonies/col/landings/2222222/tests")).json.text).toBe(ROW.text);
    expect(w.asked).toEqual(["lnd_one", "2222222"]);
  });

  it("says what is wrong: an unknown landing or colony, or a ref that names neither", async () => {
    const w = env();
    expect(await get(w.env, "/colonies/col/landings/lnd_two/tests")).toMatchObject({ status: 404, json: { error: "no landing lnd_two in colony col: name a landing by its id or by the trunk commit it made" } });
    expect((await get(w.env, "/colonies/col/landings/zz/tests")).status).toBe(400);
    expect(await get(env(false).env, "/colonies/col/landings/lnd_one/tests")).toMatchObject({ status: 404, json: { error: "colony not found" } });
  });
});
