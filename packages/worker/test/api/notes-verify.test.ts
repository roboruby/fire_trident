import { describe, expect, it } from "vitest";
import type { NotesVerification } from "@fire_trident/core";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";

/** GET /api/colonies/:id/notes/verify: the trunk writer's check of the newest notes on the trunk repository. */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};

const ANSWER: NotesVerification = {
  colonyId: "col",
  notesTip: "a".repeat(40),
  notes: [{ landingId: "lnd_1", trunkSha: "b".repeat(40), at: 1, status: "altered", trailer: "c".repeat(64), ownCopy: true, detail: "the note hashes to x" }],
  counts: { altered: 1 },
  at: 2,
};

/** An env whose colony exists (or not) and whose trunk writer records each limit it is asked for. */
function env(exists = true): { env: Env; asked: unknown[] } {
  const asked: unknown[] = [];
  const COLONY = { idFromName: (n: string) => n, get: () => ({ getColony: async () => (exists ? { id: "col" } : null) }) };
  const TRUNK = { idFromName: (n: string) => n, get: () => ({ verifyNotes: async (limit?: number) => (asked.push(limit), ANSWER) }) };
  return { env: { COLONY, TRUNK } as unknown as Env, asked };
}

const get = async (e: Env, path: string): Promise<{ status: number; json: unknown }> => {
  const res = await createApi(deps).request(path, {}, e);
  return { status: res.status, json: await res.json() };
};

describe("notes verify route", () => {
  it("answers the trunk writer's report to anyone, as other lineage reads", async () => {
    const { env: e, asked } = env();
    expect(await get(e, "/colonies/col/notes/verify")).toEqual({ status: 200, json: ANSWER });
    expect(await get(e, "/colonies/col/notes/verify?limit=50")).toEqual({ status: 200, json: ANSWER });
    expect(asked).toEqual([undefined, 50]);
  });

  it("refuses a limit that is not a whole number, and an unknown colony", async () => {
    const { env: e, asked } = env();
    for (const bad of ["-1", "x", "1.5", "99999"]) expect((await get(e, `/colonies/col/notes/verify?limit=${bad}`)).status).toBe(400);
    expect(asked).toEqual([]);
    expect((await get(env(false).env, "/colonies/col/notes/verify")).status).toBe(404);
    expect((await get(e, "/colonies/Not_A_Slug/notes/verify")).status).toBe(404);
  });
});
