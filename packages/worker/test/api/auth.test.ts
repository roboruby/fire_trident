import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type ApiEnv, hideRemotes, requireAdmin, requireAdminStrict } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";

function app() {
  const a = new Hono<ApiEnv>();
  a.post("/write", requireAdmin, (c) => c.json({ ok: true }));
  a.delete("/erase", requireAdminStrict, (c) => c.json({ ok: true }));
  return a;
}
const env = (vars: Partial<Env>) => vars as Env;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("admin gates", () => {
  it("refuse writes when no admin token is configured (fail closed)", async () => {
    const res = await app().request("/write", { method: "POST" }, env({}));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/FT_ADMIN_TOKEN/) });
  });

  it("let writes through without a token only when FT_OPEN_WRITES is 1 (local development)", async () => {
    expect((await app().request("/write", { method: "POST" }, env({ FT_OPEN_WRITES: "1" }))).status).toBe(200);
    expect((await app().request("/write", { method: "POST" }, env({ FT_OPEN_WRITES: "true" }))).status).toBe(403);
  });

  it("check the bearer token when one is configured, whatever FT_OPEN_WRITES says", async () => {
    const configured = env({ FT_ADMIN_TOKEN: "s3cret", FT_OPEN_WRITES: "1" });
    expect((await app().request("/write", { method: "POST" }, configured)).status).toBe(401);
    expect((await app().request("/write", { method: "POST", headers: bearer("wrong") }, configured)).status).toBe(401);
    expect((await app().request("/write", { method: "POST", headers: bearer("s3cret") }, configured)).status).toBe(200);
  });

  it("always need the token for destructive routes, even in local development", async () => {
    expect((await app().request("/erase", { method: "DELETE" }, env({ FT_OPEN_WRITES: "1" }))).status).toBe(403);
    expect((await app().request("/erase", { method: "DELETE", headers: bearer("s3cret") }, env({ FT_ADMIN_TOKEN: "s3cret" }))).status).toBe(200);
  });

  it("hide the account id in Artifacts remotes from public reads, not from the operator", async () => {
    const remote = "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/ft-trunk/hono--trunk.git";
    const a = new Hono<ApiEnv>();
    a.use("*", hideRemotes);
    a.get("/snap", (c) => c.json({ trunk: { remote, name: "hono--trunk" } }));
    a.get("/text", (c) => c.text(remote));
    const configured = env({ FT_ADMIN_TOKEN: "s3cret" });
    expect(await (await a.request("/snap", {}, configured)).json()).toEqual({ trunk: { remote: "artifacts://ft-trunk/hono--trunk.git", name: "hono--trunk" } });
    expect(await (await a.request("/snap", { headers: bearer("s3cret") }, configured)).json()).toEqual({ trunk: { remote, name: "hono--trunk" } });
    expect(await (await a.request("/snap", { headers: bearer("wrong") }, configured)).json()).toEqual({ trunk: { remote: "artifacts://ft-trunk/hono--trunk.git", name: "hono--trunk" } });
    expect(await (await a.request("/text", {}, configured)).text()).toBe(remote);
  });
});
