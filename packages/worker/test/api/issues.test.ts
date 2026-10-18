import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import type { IssueImportInput } from "../../src/colony/issues.ts";
import type { Env } from "../../src/env.ts";

/**
 * POST /api/colonies/:id/issues/import through the API: the admin token, the body, GitHub read (a fake: no test calls
 * GitHub), and what the colony is asked. The colony's side is test/colony/issues.test.ts and test/do/issues.test.ts.
 */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};
const bearer = { Authorization: "Bearer s3cret", "content-type": "application/json" };

/** A colony that records the imports it is asked for, and the env around it. */
function world(token?: string) {
  const asked: IssueImportInput[] = [];
  const COLONY = {
    idFromName: (n: string) => n,
    get: (id: string) => ({
      getColony: async () => (id === "web" ? { id: "web" } : null),
      importIssues: async (p: IssueImportInput) => {
        asked.push(p);
        return { colonyId: "web", repo: p.repo, imported: p.issues.map((i) => ({ number: i.number, intentId: `int_${i.number}`, title: i.title, url: "u", footprint: ["src/**"] })), skipped: [], writeBack: "off", note: "n" };
      },
    }),
  };
  return { env: { COLONY, FT_ADMIN_TOKEN: "s3cret", ...(token ? { FT_GITHUB_TOKEN: token } : {}) } as unknown as Env, asked };
}

/** A GitHub that lists `items` for every issues read, and records each call. */
function github(items: unknown[], status = 200) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(items), { status });
  });
  vi.stubGlobal("fetch", fake);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const post = (body: unknown, headers: Record<string, string> = bearer) => ({ method: "POST", body: JSON.stringify(body), headers });

describe("POST /colonies/:id/issues/import", () => {
  it("needs the admin token and a repository, and calls GitHub only once both are good", async () => {
    const calls = github([]);
    const w = world();
    const api = createApi(deps);
    expect((await api.request("/colonies/web/issues/import", post({ repo: "o/r" }, { "content-type": "application/json" }), w.env)).status).toBe(401);
    const bad = await api.request("/colonies/web/issues/import", post({ repo: "not/a/repo" }), w.env);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'repo must name a GitHub repository as owner/name, such as octo-org/hello-world; got "not/a/repo"' });
    const close = await api.request("/colonies/web/issues/import", post({ repo: "o/r", close: true }), w.env);
    expect(await close.json()).toEqual({ error: "close needs closeOnLand: an issue is closed only after the colony comments on it at landing" });
    expect((await api.request("/colonies/web/issues/import", post({ repo: "o/r", limit: 500 }), w.env)).status).toBe(400);
    expect((await api.request("/colonies/web/issues/import", post({ repo: "o/r", extra: 1 }), w.env)).status).toBe(400);
    expect((await api.request("/colonies/nope/issues/import", post({ repo: "o/r" }), w.env)).status).toBe(404);
    expect(calls).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  it("reads the open issues without a token, drops pull requests, and asks the colony to import them", async () => {
    const long = "x".repeat(20_000);
    const calls = github([
      { number: 5, title: "Five", body: long, user: { login: "octocat" }, labels: [] },
      { number: 4, title: "A pull request", pull_request: {}, user: { login: "octocat" } },
    ]);
    const w = world();
    const res = await createApi(deps).request("/colonies/web/issues/import", post({ repo: "https://github.com/o/r", labels: ["bug"], limit: 3, footprint: ["src/**"], closeOnLand: true, by: "lee" }), w.env);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ repo: "o/r", imported: [{ number: 5, intentId: "int_5" }], read: { issues: 1, pullRequests: 1, unreadable: 0 } });
    expect(calls).toEqual([{ url: "https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=1&labels=bug", auth: null }]);
    expect(w.asked).toHaveLength(1);
    const asked = w.asked[0]!;
    expect({ ...asked, issues: asked.issues.map((i) => ({ ...i, body: i.body.length })) }).toEqual({
      repo: "o/r",
      issues: [{ number: 5, title: "Five", body: 8_000, author: "octocat", labels: [] }],
      footprint: ["src/**"],
      closeOnLand: true,
      close: false,
      by: "lee",
      tokenSet: false,
    });
  });

  it("sends FT_GITHUB_TOKEN to GitHub when it is set, answers 200 when nothing was imported, and passes GitHub's refusal on", async () => {
    const calls = github([]);
    const w = world("ghp_test_not_a_real_token");
    const none = await createApi(deps).request("/colonies/web/issues/import", post({ repo: "o/r" }), w.env);
    expect(none.status).toBe(200);
    expect(calls[0]!.auth).toBe("Bearer ghp_test_not_a_real_token");
    expect(w.asked[0]!.tokenSet).toBe(true);
    github([], 404);
    const missing = await createApi(deps).request("/colonies/web/issues/import", post({ repo: "o/r" }), world().env);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain("GitHub has no public repository o/r");
  });
});
