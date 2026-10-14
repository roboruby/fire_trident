import { describe, expect, it } from "vitest";
import type { FieldReading, ImpactReport } from "@fire_trident/core";
import { IMPACT_DATA_NOTE } from "../../src/colony/impact.ts";
import { addAgent, addIntent, api, newColony, proposal, proposeEdit, region, take, tick, trunk } from "./helpers.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * GET /api/colonies/:id/impact through the real ColonyDO and RegionDOs (the trunk writer is the harness's stand-in, which
 * walks the import links a test sets): what a change to a file reaches, who works on those files now, and the latest
 * landings on them. A public read, bounded and failing open.
 */

/** src/app/main.ts imports src/lib/util.ts. */
const LINKS = {
  "src/lib/util.ts": { imports: [], importers: ["src/app/main.ts"] },
  "src/app/main.ts": { imports: ["src/lib/util.ts"], importers: [] },
};

/** A public read: no admin token. */
const impact = (colonyId: string, query: string) => api<ImpactReport & { error?: string }>("GET", `/colonies/${colonyId}/impact?${query}`, undefined, {});

describe("GET /impact", () => {
  it("serves the importers, who claims them now and the latest landings on them, to anyone", async () => {
    const c = await newColony();
    await trunk(c.id).setImports(LINKS);
    // util.ts lands for one intent; then an agent takes the intent on main.ts, which imports it.
    const fix = await addIntent(c.id, ["src/lib/util.ts"], { title: "Make helper return two", why: "The app needs two.", priority: 5 });
    const later = await addIntent(c.id, ["src/app/main.ts"], { title: "Print the helper's value", why: "Show it.", priority: 3 });
    const a = await addAgent(c.id, "a");
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("landed");
    const b = await addAgent(c.id, "b");
    expect((await take(c.id, b.id)).intent.id).toBe(later.id);

    const res = await impact(c.id, "path=src/lib/util.ts");
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r).toMatchObject({ colonyId: c.id, paths: ["src/lib/util.ts"], index: { read: true, current: true }, truncated: false, limits: { depth: 3, files: 200, landings: 10 }, about: IMPACT_DATA_NOTE });
    expect(r.files).toEqual([
      { path: "src/lib/util.ts", depth: 0 },
      { path: "src/app/main.ts", depth: 1, via: "src/lib/util.ts", claimedBy: [b.id] },
    ]);
    expect(r.claims).toHaveLength(1);
    const claim = r.claims[0]!;
    expect(claim).toMatchObject({ agentId: b.id, name: "b", kind: "synthetic", intentId: later.id, title: "Print the helper's value", status: "claimed", paths: ["src/app/main.ts"] });
    expect(claim.ageMs).toBeGreaterThanOrEqual(0);
    expect(claim.ageMs).toBeLessThan(10_000);
    expect(claim.strength).toBeGreaterThan(0.95);
    expect(claim.claimedAt).toBe(r.at - claim.ageMs!);
    expect(r.landings).toHaveLength(1);
    expect(r.landings[0]).toMatchObject({ intentId: fix.id, title: "Make helper return two", why: "The app needs two.", paths: ["src/lib/util.ts"] });
    expect(r.landings[0]!.trunkSha).toMatch(/^[0-9a-f]{40}$/);

    // A footprint: a directory names the trunk files under it; one level only.
    const dir = (await impact(c.id, "path=src/&depth=1")).body;
    expect(dir.files.map((f) => f.path)).toEqual(["src/app/main.ts", "src/lib/util.ts"]);
    expect(dir.limits.depth).toBe(1);
    expect(dir.claims.map((k) => k.agentId)).toEqual([b.id]);
  });

  it("fails open when the trunk writer cannot walk, and refuses a bad request plainly", async () => {
    const c = await newColony();
    await trunk(c.id).setImports("fail");
    const res = await impact(c.id, "path=src/lib/util.ts&path=docs/");
    expect(res.status).toBe(200);
    expect(res.body.index).toEqual({ read: false, current: false, note: "the importers could not be read (simulated import links failure): only the paths asked about were looked at" });
    expect(res.body.files).toEqual([{ path: "src/lib/util.ts", depth: 0 }, { path: "docs/", depth: 0 }]);
    for (const [query, status, error] of [
      ["", 400, "name the file to look at: ?path=src/index.ts (repeat path for a footprint, at most 20)"],
      ["path=../etc/passwd", 400, 'invalid path "../etc/passwd": give a path relative to the repository root, such as src/index.ts'],
      ["path=src/a.ts&depth=9", 400, "depth must be a whole number from 1 to 3"],
      ["path=src/a.ts&depth=two", 400, "depth must be a whole number from 1 to 3"],
    ] as const) {
      const bad = await impact(c.id, query);
      expect(bad.status, query).toBe(status);
      expect(bad.body.error).toBe(error);
    }
    const missing = await impact("no-such-colony", "path=src/a.ts");
    expect(missing.status).toBe(404);
  });
});

describe("TrunkDO.importerWalk (the real trunk writer, writer.ts)", () => {
  it("builds the import index on first use, walks importers with the file each imports, and follows landings", async () => {
    const files = {
      "src/lib/util.ts": "export const one = 1;\n",
      "src/app/main.ts": 'import { one } from "../lib/util.ts";\nconsole.log(one);\n',
      "src/app/server.ts": 'import "./main.ts";\n',
      "README.md": "# impact\n",
    };
    await withWriter(files, undefined, async (w) => {
      expect(w.indexed()).toBe(false);
      const first = await w.trunk.importerWalk(["src/lib/util.ts"]);
      expect(w.indexed()).toBe(true);
      expect(first).toEqual({
        trunkSha: w.head(),
        current: true,
        roots: ["src/lib/util.ts"],
        missing: [],
        files: [
          { path: "src/app/main.ts", depth: 1, via: "src/lib/util.ts" },
          { path: "src/app/server.ts", depth: 2, via: "src/app/main.ts" },
        ],
        truncated: false,
      });
      // A landing adds an importer; the next walk finds it, from a directory, one level deep.
      landed(await w.land(await w.proposal({ "test/util.test.ts": 'import { one } from "../src/lib/util.ts";\nvoid one;\n' })));
      const next = await w.trunk.importerWalk(["src/lib/"], { depth: 1 });
      expect(next).toMatchObject({ trunkSha: w.head(), current: true, roots: ["src/lib/util.ts"], truncated: true });
      expect(next.files.map((f) => f.path)).toEqual(["src/app/main.ts", "test/util.test.ts"]);
      expect((await w.trunk.importerWalk(["docs/", "README.md"])).missing).toEqual(["docs/"]);
    });
  });
});

describe("RegionDO readings with claim times", () => {
  it("give each holder when it last made or renewed a claim there, and only when asked", async () => {
    const c = await newColony();
    const r = region(c.id, "src");
    await r.configure({ colonyId: c.id, region: "src" });
    const at = Date.now() - 60_000;
    await r.deposit([
      { kind: "claim", path: "src/a.ts", strength: 1, at, agentId: "a1", intentId: "i1" },
      { kind: "claim", path: "src/b.ts", strength: 1, at: at + 5_000, agentId: "a1", intentId: "i1" },
    ]);
    const timed = (await r.reading({ paths: ["src/a.ts"], kinds: ["claim"], claimTimes: true })) as FieldReading;
    expect(timed.agents).toEqual([{ agentId: "a1", intentId: "i1", paths: ["src/a.ts", "src/b.ts"], at: at + 5_000 }]);
    expect(((await r.reading()) as FieldReading).agents).toEqual([{ agentId: "a1", intentId: "i1", paths: ["src/a.ts", "src/b.ts"] }]);
  });
});
