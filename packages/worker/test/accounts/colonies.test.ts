import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECT_FIRST } from "../../src/accounts/routes.ts";
import { MAX_COLONIES_PER_ACCOUNT } from "../../src/accounts/limits.ts";
import { world } from "./world.ts";

/** A person's own colonies: created through the admin route's code path, on their storage, after Cloudflare is connected. */

// The world fakes Date so every part shares one clock (accounts/scope.ts reads Date.now).
afterEach(() => {
  vi.useRealTimers();
});

const ada = { id: 101, login: "ada", name: "Ada" };

describe("POST /api/me/colonies", () => {
  it("creates a colony the account owns from before its objects exist, through the shared create path", async () => {
    const w = world();
    const me = await w.person(ada);
    const res = await me.call("POST", "/api/me/colonies", { body: { name: "My Web App", source: { url: "https://github.com/ada/web.git", branch: "main" } } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ colony: { id: "my-web-app", name: "My Web App" }, owner: me.id });
    expect(w.provisioned).toEqual([{ colonyId: "my-web-app", owner: me.id, ownerAtProvision: me.id }]);
    // The same sequence as POST /api/colonies: trunk writer, pool, colony, registry.
    const order = w.calls.filter((c) => c.method === "init").map((c) => c.object);
    expect(order).toEqual(["trunk:my-web-app", "pool:my-web-app", "colony:my-web-app"]);
    expect(w.calls.find((c) => c.object === "colony:my-web-app" && c.method === "init")?.args[0]).toMatchObject({ trunk: { namespace: "firetrident-trunk" }, source: { url: "https://github.com/ada/web.git", branch: "main" } });
    expect(w.store.coloniesOf(me.id)).toEqual([{ colonyId: "my-web-app", state: "active", createdAt: w.now() }]);
    const page = (await (await me.call("GET", "/api/me")).json()) as { colonies: unknown[] };
    expect(page.colonies).toEqual([{ id: "my-web-app", name: "My Web App", state: "active", createdAt: w.now() }]);
  });

  it("refuses with a plain sentence until the person's Cloudflare account is connected", async () => {
    const w = world();
    const me = await w.person(ada, { connect: false });
    const res = await me.call("POST", "/api/me/colonies", { body: { name: "web" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CONNECT_FIRST });
    expect(w.provisioned).toEqual([]);
    expect(w.store.ownerOf("web")).toBeNull();
    // Nothing wired to say whether anyone is connected: nobody is.
    const unwired = world({ grants: false });
    const other = await unwired.person(ada);
    expect((await other.call("POST", "/api/me/colonies", { body: { name: "web" } })).status).toBe(409);
  });

  it("never falls back to the deployment's own storage when the owner's is not wired", async () => {
    const w = world({ provision: false });
    const me = await w.person(ada);
    const res = await me.call("POST", "/api/me/colonies", { body: { name: "web" } });
    expect(res.status).toBe(503);
    expect(w.calls.filter((c) => c.method === "init")).toEqual([]);
  });

  it("holds an account to its quota, and a taken name to its owner", async () => {
    const w = world();
    await w.operatorColony("showcase");
    const me = await w.person(ada);
    const taken = await me.call("POST", "/api/me/colonies", { body: { name: "Showcase" } });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: string }).error).toBe("A colony named showcase exists already. Choose another name.");
    // The operator's colony stays nobody's.
    expect(w.store.ownerOf("showcase")).toBeNull();
    for (let i = 1; i <= MAX_COLONIES_PER_ACCOUNT; i++) expect((await me.call("POST", "/api/me/colonies", { body: { name: `app ${i}` } })).status).toBe(201);
    const over = await me.call("POST", "/api/me/colonies", { body: { name: "one more" } });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toBe(`You own ${MAX_COLONIES_PER_ACCOUNT} colonies, the most an account may own (${MAX_COLONIES_PER_ACCOUNT}).`);
  });

  it("keeps the names of the operator's public colonies, even ones not created yet", async () => {
    const w = world({ vars: { FT_PUBLIC_GIT: "hono,mosaic", FT_PUBLIC_MCP: "first-red" } });
    const me = await w.person(ada);
    for (const name of ["Mosaic", "first red"]) {
      const res = await me.call("POST", "/api/me/colonies", { body: { name } });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/kept for the operator's public colonies/);
    }
    expect(w.store.coloniesOf(me.id)).toEqual([]);
  });

  it("gives the name back when creation fails", async () => {
    const w = world();
    const me = await w.person(ada);
    w.failProvision(true);
    const res = await me.call("POST", "/api/me/colonies", { body: { name: "web" } });
    expect(res.status).toBe(502);
    expect(w.store.ownerOf("web")).toBeNull();
    w.failProvision(false);
    expect((await me.call("POST", "/api/me/colonies", { body: { name: "web" } })).status).toBe(201);
  });

  it("needs a session, from this site, and a usable name and repository", async () => {
    const w = world();
    expect((await w.browser().call("POST", "/api/me/colonies", { body: { name: "web" } })).status).toBe(401);
    const me = await w.person(ada);
    expect((await me.call("POST", "/api/me/colonies", { body: { name: "web" }, origin: "https://evil.test" })).status).toBe(403);
    expect((await me.call("POST", "/api/me/colonies", { body: { name: "!!!" } })).status).toBe(400);
    expect((await me.call("POST", "/api/me/colonies", { body: { name: "web", source: { url: "http://example.com/repo.git" } } })).status).toBe(400);
    expect((await me.call("POST", "/api/me/colonies", { body: { name: "web", source: { url: "file:///etc/passwd" } } })).status).toBe(400);
    // A scoped token is not a session: it cannot create colonies.
    expect((await w.request("POST", "/api/me/colonies", { origin: "https://ft.test", authorization: `Bearer ftt_${"a".repeat(32)}` }, { name: "web" })).status).toBe(401);
  });
});
