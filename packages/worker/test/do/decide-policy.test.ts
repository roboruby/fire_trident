import { describe, expect, it } from "vitest";
import { api, newColony } from "./helpers.ts";

/** The decide policy route: protected paths and the comment-only proof are set and read through it. */
describe("decide policy route", () => {
  it("reads the defaults, sets protected paths and the comment-only proof, and keeps what a later patch leaves out", async () => {
    const c = await newColony();
    const path = `/colonies/${c.id}/decide/policy`;
    const fresh = await api("GET", path);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ commentProof: true, protectedPaths: [], deterministic: true });

    const set = await api("POST", path, { protectedPaths: ["src/auth/**", "./db/migrations/"], commentProof: false });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ protectedPaths: ["src/auth/**", "db/migrations"], commentProof: false });
    expect((await api("GET", path)).body).toMatchObject({ protectedPaths: ["src/auth/**", "db/migrations"], commentProof: false });

    const later = await api("POST", path, { commentProof: true });
    expect(later.body).toMatchObject({ protectedPaths: ["src/auth/**", "db/migrations"], commentProof: true });
    expect((await api("GET", `/colonies/${c.id}/immune`)).body.policy).toMatchObject({ protectedPaths: ["src/auth/**", "db/migrations"], commentProof: true });

    expect((await api("POST", path, { protectedPaths: [] })).body.protectedPaths).toEqual([]);
  });

  it("refuses what it would otherwise drop silently, and changes nothing then", async () => {
    const c = await newColony();
    const path = `/colonies/${c.id}/decide/policy`;
    await api("POST", path, { protectedPaths: ["src/auth/**"] });
    const empty = await api("POST", path, { protectedPaths: ["db/**", " "] });
    expect(empty).toEqual({ status: 400, body: { error: "invalid request: protectedPaths.1: a protected path cannot be empty" } });
    expect((await api("POST", path, { commentProof: "off" })).status).toBe(400);
    const tooMany = await api("POST", path, { protectedPaths: Array.from({ length: 51 }, (_, i) => `dir${i}/**`) });
    expect(tooMany.body.error).toBe("invalid request: protectedPaths: at most 50 globs, got 51");
    expect((await api("GET", path)).body.protectedPaths).toEqual(["src/auth/**"]);
  });

  it("needs the operator token to change, not to read", async () => {
    const c = await newColony();
    const path = `/colonies/${c.id}/decide/policy`;
    expect((await api("POST", path, { protectedPaths: ["x/**"] }, {})).status).toBe(401);
    expect((await api("GET", path, undefined, {})).status).toBe(200);
    expect((await api("GET", "/colonies/no-such-colony/decide/policy")).status).toBe(404);
  });
});
