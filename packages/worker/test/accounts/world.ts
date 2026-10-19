import { Hono } from "hono";
import { expect, vi } from "vitest";
import type { Env } from "../../src/env.ts";
import { createApi } from "../../src/api/app.ts";
import { accountsApp, type AccountsDeps } from "../../src/accounts/routes.ts";
import type { CloudflareGrant } from "../../src/accounts/types.ts";
import { ADMIN, CookieJar, FakeGithub, ORIGIN, accountsEnv, memoryStore, type Calls, type FakeUser } from "./fakes.ts";

/**
 * A deployment for the accounts tests: the accounts routes and the API mounted as index.ts mounts them, colonies that
 * remember being created, a fake GitHub, a Cloudflare connection per account, and people with their own browsers.
 */
export function world(opts: { grants?: boolean; provision?: boolean; vars?: Partial<Env> } = {}) {
  const store = memoryStore();
  const calls: Calls = [];
  const colonies = new Map<string, { id: string; name: string; createdAt: number }>();
  let agents = 0;
  const env = accountsEnv(store, {
    calls,
    vars: opts.vars,
    colonies: {
      getColony: (name: string) => colonies.get(name) ?? null,
      init: (name: string, p: { name: string }) => {
        const c = { id: name, name: p.name, createdAt: 1 };
        colonies.set(name, c);
        return c;
      },
      declareIntent: (_name: string, p: { title: string }) => ({ intent: { id: "int_1", title: p.title, priority: 1, source: "human" } }),
      listAgents: () => Array.from({ length: agents }, (_, i) => ({ id: `agt_${i}`, kind: "internal", state: "working" })),
    },
  });
  // The registry is a colony object too; it answers like any other.
  const connected = new Set<string>();
  const provisioned: Array<{ colonyId: string; owner: string; ownerAtProvision: string | null }> = [];
  let failProvision = false;
  const deps: AccountsDeps = {
    ...(opts.grants === false ? {} : { grantFor: async (_env: Env, account: string): Promise<CloudflareGrant | null> => (connected.has(account) ? { accountId: "cf-account", accessToken: "test-cf-token", scopes: ["artifacts.read", "artifacts.write"] } : null) }),
    ...(opts.provision === false
      ? {}
      : {
          provisionOwned: async (_env: Env, colonyId: string, owner: string) => {
            provisioned.push({ colonyId, owner, ownerAtProvision: store.ownerOf(colonyId) });
            if (failProvision) throw new Error("[ft:502] the owner's Artifacts refused the repository");
            return { trunk: { namespace: "firetrident-trunk", name: `${colonyId}--trunk`, remote: `https://artifacts.invalid/${colonyId}.git` }, trunkSha: "b".repeat(40) };
          },
        }),
  };
  const github = new FakeGithub();
  // One clock for every part (the API's write check reads Date.now): the tests move it with tick() and restore real timers after each test.
  vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
  const now = () => Date.now();
  const spawned: Array<{ colonyId: string; count: number }> = [];
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", accountsApp({ ...deps, fetch: github.fetch, now }));
  app.route(
    "/api",
    createApi({
      provisionTrunk: async (_env, colonyId) => ({ trunk: { namespace: "ft-trunk", name: `${colonyId}--trunk`, remote: `https://artifacts.invalid/${colonyId}.git` }, trunkSha: "c".repeat(40) }),
      spawnSwarm: async (_env, colonyId, o) => {
        spawned.push({ colonyId, count: o.count });
        return { started: o.count };
      },
    }),
  );

  /** A person's browser: their cookies, their calls (with this site's Origin on writes unless told otherwise). */
  const browser = () => {
    const jar = new CookieJar();
    const call = async (method: string, path: string, init: { body?: unknown; origin?: string | null; bearer?: string } = {}) => {
      const headers: Record<string, string> = {};
      const cookie = jar.header(new URL(path, ORIGIN).pathname);
      if (cookie) headers.cookie = cookie;
      if (init.origin !== null && method !== "GET") headers.origin = init.origin ?? ORIGIN;
      if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const res = await app.request(`${ORIGIN}${path}`, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, env);
      jar.take(res);
      return res;
    };
    return { jar, call };
  };

  /** A person who signed in with GitHub and opened their account with an invite code. */
  const person = async (user: FakeUser, opts2: { connect?: boolean } = {}) => {
    const b = browser();
    const invite = await app.request("/api/accounts/invites", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{}" }, env);
    const code = ((await invite.json()) as { code: string }).code;
    const start = await b.call("GET", "/auth/github/start");
    const back = new URL(github.authorize(start.headers.get("location") ?? "", user));
    await b.call("GET", back.pathname + back.search);
    const opened = await b.call("POST", "/auth/github/invite", { body: { code } });
    expect(opened.status).toBe(201);
    const id = ((await opened.json()) as { account: { id: string } }).account.id;
    if (opts2.connect !== false) connected.add(id);
    return { ...b, id };
  };

  /** Raw API call with headers of the caller's choosing. */
  const request = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    app.request(`${ORIGIN}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env);

  return {
    store,
    env,
    calls,
    colonies,
    connected,
    provisioned,
    spawned,
    app,
    github,
    browser,
    person,
    request,
    now,
    tick: (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
    },
    failProvision: (on: boolean) => {
      failProvision = on;
    },
    setAgents: (n: number) => {
      agents = n;
    },
    /** An operator colony: created with the admin token, owned by nobody. */
    operatorColony: async (name: string) => {
      const res = await request("POST", "/api/colonies", { authorization: `Bearer ${ADMIN}` }, { name });
      expect(res.status).toBe(201);
    },
  };
}
