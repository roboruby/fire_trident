import { describe, expect, it } from "vitest";
import { PRESETS } from "../../src/decide/presets.ts";
import { api, newColony } from "./helpers.ts";

/** GET /colonies/:id/decides: a public read of the preset a colony's decide policy equals, and its 30-day split. */
describe("how a colony decides", () => {
  it("reads central development on a new colony, with nothing landed, and needs no token", async () => {
    const c = await newColony();
    const res = await api("GET", `/colonies/${c.id}/decides`, undefined, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ colonyId: c.id, preset: "central-development", nearest: "central-development", differs: [], protectedPaths: 0 });
    expect(res.body.split).toMatchObject({ days: 30, total: 0, counts: { deterministic: 0, model: 0, autonomy: 0, person: 0, unreviewed: 0 } });
    expect(res.body.presets.map((p: { name: string }) => p.name)).toEqual(["local-development", "central-development", "pre-production", "production"]);
    expect(typeof res.body.lets).toBe("string");
  });

  it("names the preset an admin set through the policy route, and custom with what differs", async () => {
    const c = await newColony();
    const production = PRESETS.find((p) => p.name === "production")!;
    expect((await api("POST", `/colonies/${c.id}/decide/policy`, production.values)).status).toBe(200);
    expect((await api("GET", `/colonies/${c.id}/decides`)).body.preset).toBe("production");

    await api("POST", `/colonies/${c.id}/decide/policy`, { needsHuman: 0.25, protectedPaths: ["src/auth/**"] });
    const custom = await api("GET", `/colonies/${c.id}/decides`);
    expect(custom.body).toMatchObject({ preset: "custom", nearest: "production", protectedPaths: 1 });
    expect(custom.body.differs).toEqual([{ field: "needsHuman", label: "p(needs_human) a landing stays under", value: 0.25, preset: 0.2 }]);
  });

  it("answers 404 for a colony that does not exist, and changes nothing on a write", async () => {
    expect((await api("GET", "/colonies/no-such-colony/decides")).status).toBe(404);
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/decides`, { preset: "production" })).status).toBe(404);
    expect((await api("GET", `/colonies/${c.id}/decides`)).body.preset).toBe("central-development");
  });
});
