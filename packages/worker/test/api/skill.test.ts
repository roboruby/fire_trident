import { describe, expect, it } from "vitest";
import { publicAddCommand, tokenAddCommand, connectInfo } from "@fire_trident/core";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import { colonySkill, skillLine } from "../../src/api/skill.ts";
import type { Env } from "../../src/env.ts";

/**
 * A colony's SKILL.md (GET /colonies/:id/skill): onboarding for an agent, with the colony's name, rules and protected
 * paths and nothing else of the colony: how to connect (read only first), what to do on arrival, while working and
 * before leaving, and how a scheduler brings the agent back to its inbox.
 */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};

const SITE = "http://localhost";

/** A colony "web" with two rules (one retracted), protected globs, and an intent and files the skill must not repeat. */
function env(opts: { immune?: "fails" | "older"; missing?: boolean } = {}): { env: Env; asked: string[] } {
  const asked: string[] = [];
  const COLONY = {
    idFromName: (n: string) => n,
    get: (id: string) => ({
      getColony: async () => {
        asked.push(`getColony ${id}`);
        return opts.missing || id !== "web" ? null : { id: "web", name: "Web `app`\n# shop", trunk: {}, trunkSha: "a".repeat(40), createdAt: 1 };
      },
      snapshot: async () => {
        asked.push("snapshot");
        return {
          intents: [{ id: "int_1", title: "SECRET-INTENT-TITLE" }],
          files: [{ path: "src/very/private/file.ts", size: 1 }],
          rules: [
            { id: "r1", colonyId: "web", kind: "pattern", description: "No console calls in src", spec: { pattern: "console\\.", include: ["src/**/*.ts"], hint: "Return errors instead" }, approvedBy: "ops", createdAt: 1 },
            { id: "r2", colonyId: "web", kind: "pattern", description: "Old rule", spec: {}, approvedBy: "ops", createdAt: 1, retractedAt: 2 },
          ],
        };
      },
      immune: async () => {
        asked.push("immune");
        if (opts.immune === "fails") throw new Error("decide pipeline unavailable");
        return opts.immune === "older" ? {} : { policy: { protectedPaths: ["migrations/**", "src/__init__.py"] } };
      },
    }),
  };
  return { env: { COLONY } as unknown as Env, asked };
}

const get = async (e: Env, path: string): Promise<{ status: number; type: string | null; text: string }> => {
  const res = await createApi(deps).request(path, {}, e);
  return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
};

/** The level-2 headings of a markdown text, in order. */
const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

describe("GET /colonies/:id/skill", () => {
  it("answers the colony's SKILL.md as markdown, with no token, named for the colony", async () => {
    const { env: e } = env();
    const res = await get(e, "/colonies/web/skill");
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/markdown; charset=utf-8");
    const [, front = ""] = /^---\n([\s\S]*?)\n---\n/.exec(res.text) ?? [];
    const fields = Object.fromEntries(front.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
    expect(fields.name).toBe("firetrident-web");
    const description = JSON.parse(fields.description ?? '""') as string;
    expect(description).toMatch(/^Work in the FireTrident colony Web app # shop \(web\) over MCP\./);
    expect(description.length).toBeLessThan(1024);
  });

  it("goes connect, arrival, work, rules, protected paths, leaving, coming back", async () => {
    const { text } = await get(env().env, "/colonies/web/skill");
    expect(headings(text)).toEqual(["Connect", "On arrival", "While working", "Rules of this colony", "Protected paths", "Before leaving", "Come back on a schedule"]);
    const info = connectInfo(SITE, "web");
    expect(text.indexOf(publicAddCommand(info))).toBeGreaterThan(0);
    expect(text.indexOf(publicAddCommand(info))).toBeLessThan(text.indexOf(tokenAddCommand(info)));
    expect(text).toContain(`${SITE}/connect?colony=web`);
    expect(text).toContain(`${SITE}/c/web`);
  });

  it("tells an agent what to do on arrival, while working and before leaving", async () => {
    const { text } = await get(env().env, "/colonies/web/skill");
    const section = (name: string) => text.slice(text.indexOf(`## ${name}`), text.indexOf("\n## ", text.indexOf(`## ${name}`) + 3));
    const arrival = section("On arrival");
    for (const s of ['Call `join` with `colony` "web"', "Call `inbox`", "`lastReturn.reason`", "Call `sense`", "needs"]) expect(arrival).toContain(s);
    const work = section("While working");
    for (const s of ["Call `read`", "`propose` with `notVerified`", "heed the notices", "the hunk that beat it (`lastReturn.movedBy[].hunks`", "never undo another agent's landed change", "`escalate`"]) expect(work).toContain(s);
    const leaving = section("Before leaving");
    expect(leaving).toContain("call `release` with a `reason`");
    expect(leaving).toContain("until your proposal is final");
    const back = section("Come back on a schedule");
    expect(back).toContain("*/5 * * * *");
    expect(back).toContain('agentId $FT_AGENT and resumeKey $FT_RESUME_KEY. Call inbox.');
    expect(back).toContain('--allowedTools "mcp__firetrident__*');
  });

  it("lists the active rules with their paths and hints, and the protected globs as written", async () => {
    const { text } = await get(env().env, "/colonies/web/skill");
    expect(text).toContain("- No console calls in src (pattern rule, on `src/**/*.ts`). Hint: Return errors instead.");
    expect(text).not.toContain("Old rule");
    expect(text).toContain("- `migrations/**`");
    expect(text).toContain("- `src/__init__.py`");
    expect(text).toContain("Do not commit your client's MCP configuration (.mcp.json, .cursor/, .vscode/) to this colony");
  });

  it("carries nothing else of the colony: no intent, no file, no token", async () => {
    const { text } = await get(env().env, "/colonies/web/skill");
    expect(text).not.toContain("SECRET-INTENT-TITLE");
    expect(text).not.toContain("src/very/private");
    for (const m of text.matchAll(/Bearer ([^"'\s]+)/g)) expect(m[1]).toMatch(/^(?:\$FT_MCP_TOKEN|\$\{FT_MCP_TOKEN\})$/);
    expect(text.match(/[^\x09\x0a\x0d\x20-\x7e]/g)).toBeNull();
  });

  it("says so when the protected paths cannot be read, or the colony protects none", async () => {
    expect((await get(env({ immune: "fails" }).env, "/colonies/web/skill")).text).toContain("could not be read just now");
    expect((await get(env({ immune: "older" }).env, "/colonies/web/skill")).text).toContain("could not be read just now");
    const none = colonySkill(SITE, { id: "web", name: "web", rules: [], protectedPaths: [] });
    expect(none).toContain("This colony protects no paths beyond the ones review always holds.");
    expect(none).toContain("This colony has no rules yet.");
  });

  it("answers 404 for a colony that does not exist or an id that cannot name one, without reading more", async () => {
    const missing = env({ missing: true });
    expect((await get(missing.env, "/colonies/web/skill")).status).toBe(404);
    expect(missing.asked).toEqual(["getColony web"]);
    const bad = env();
    expect((await get(bad.env, "/colonies/Not_A_Colony/skill")).status).toBe(404);
    expect(bad.asked).toEqual([]);
  });
});

describe("skillLine", () => {
  it("keeps one line of operator text: no control characters or backticks, glob characters kept, capped", () => {
    expect(skillLine("a\n\tb `c`\u0007 d")).toBe("a b c d");
    expect(skillLine("src/**/__init__.py")).toBe("src/**/__init__.py");
    expect(skillLine("x".repeat(300), 20)).toBe(`${"x".repeat(17)}...`);
    expect(skillLine(42)).toBe("");
  });
});
