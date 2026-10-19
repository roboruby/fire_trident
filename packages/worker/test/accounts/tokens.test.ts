import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../src/api/app.ts";
import { identityAnswers, type ApproverWho } from "../../src/decide/receipt.ts";
import { MAX_AGENTS_PER_COLONY, MAX_LIVE_TOKENS_PER_COLONY, TOKEN_MAX_DAYS } from "../../src/accounts/limits.ts";
import { ROUTE_NEEDS } from "../../src/accounts/scope.ts";
import type { Capability, TokenRole } from "../../src/accounts/types.ts";
import { ADMIN, ORIGIN } from "./fakes.ts";
import { world } from "./world.ts";

/** Scoped tokens: minted, listed and revoked by a colony's owner, and authorizing exactly their role on exactly their colony. */

// The world fakes Date so every part shares one clock (accounts/scope.ts reads Date.now).
afterEach(() => {
  vi.useRealTimers();
});

const ada = { id: 101, login: "ada", name: "Ada" };
const bob = { id: 202, login: "bob" };
const DAY = 24 * 60 * 60_000;

async function owned() {
  const w = world();
  const me = await w.person(ada);
  expect((await me.call("POST", "/api/me/colonies", { body: { name: "web" } })).status).toBe(201);
  const mint = async (role: TokenRole, extra: Record<string, unknown> = {}) => {
    const res = await me.call("POST", "/api/me/colonies/web/tokens", { body: { role, label: `${role} token`, ...extra } });
    expect(res.status).toBe(201);
    return (await res.json()) as { secret: string; token: { id: string; expiresAt: number; role: TokenRole } };
  };
  return { w, me, mint };
}

/** A route's path with its parameters filled in. */
function concrete(path: string, colony: string): string {
  return path
    .replace(":id", colony)
    .replace(":aid", "agt_1")
    .replace(":pid", "prp_1")
    .replace(":iid", "int_1")
    .replace(":rid", "rul_1")
    .replace(":ref", "lnd_1")
    .replace(":lessonId", "les_1");
}

const ALLOWS: Record<TokenRole, Capability[]> = { agent: ["agent"], reviewer: ["review"], owner: ["agent", "review", "owner"] };

describe("minting, listing and revoking", () => {
  it("shows the secret once, keeps it out of every list, and caps a token's life at 30 days", async () => {
    const { w, me, mint } = await owned();
    const made = await mint("agent", { days: 7 });
    expect(made.secret).toMatch(/^ftt_[a-z2-7]{32}$/);
    expect(made.token).toMatchObject({ role: "agent", label: "agent token", expiresAt: w.now() + 7 * DAY, live: true });
    const listed = await (await me.call("GET", "/api/me/colonies/web/tokens")).text();
    expect(listed).toContain(made.token.id);
    expect(listed).not.toContain(made.secret);
    expect(JSON.parse(listed)).toMatchObject({ colonyId: "web", live: 1, max: MAX_LIVE_TOKENS_PER_COLONY });
    expect((await mint("owner")).token.expiresAt).toBe(w.now() + TOKEN_MAX_DAYS * DAY);
    expect((await me.call("POST", "/api/me/colonies/web/tokens", { body: { role: "agent", label: "x", days: TOKEN_MAX_DAYS + 1 } })).status).toBe(400);
    expect((await me.call("POST", "/api/me/colonies/web/tokens", { body: { role: "admin", label: "x" } })).status).toBe(400);
    expect((await me.call("POST", "/api/me/colonies/web/tokens", { body: { role: "agent", label: "\u0000 " } })).status).toBe(400);
    const gone = await me.call("DELETE", `/api/me/colonies/web/tokens/${made.token.id}`);
    expect(await gone.json()).toMatchObject({ ok: true, token: { id: made.token.id, live: false } });
    expect((await me.call("DELETE", "/api/me/colonies/web/tokens/tok_missing")).status).toBe(404);
  });

  it("holds a colony to its live tokens", async () => {
    const { me, mint } = await owned();
    for (let i = 0; i < MAX_LIVE_TOKENS_PER_COLONY; i++) await mint("agent");
    const over = await me.call("POST", "/api/me/colonies/web/tokens", { body: { role: "agent", label: "one more" } });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toMatch(/Revoke one first/);
  });

  it("is the owner's alone: not another person, not from another site, and an owner token's children never outlive it", async () => {
    const { w, mint } = await owned();
    const other = await w.person(bob);
    expect((await other.call("GET", "/api/me/colonies/web/tokens")).status).toBe(403);
    expect((await other.call("POST", "/api/me/colonies/web/tokens", { body: { role: "owner", label: "mine now" } })).status).toBe(403);
    expect((await w.browser().call("GET", "/api/me/colonies/web/tokens")).status).toBe(401);
    const owner = await mint("owner", { days: 2 });
    const agent = await mint("agent");
    // With an owner token (no cookie, no Origin needed: a bearer cannot be sent by another site).
    const child = await w.request("POST", "/api/me/colonies/web/tokens", { authorization: `Bearer ${owner.secret}` }, { role: "agent", label: "child", days: 30 });
    expect(child.status).toBe(201);
    expect(((await child.json()) as { token: { expiresAt: number } }).token.expiresAt).toBe(owner.token.expiresAt);
    expect((await w.request("GET", "/api/me/colonies/web/tokens", { authorization: `Bearer ${agent.secret}` })).status).toBe(403);
    expect((await w.request("GET", "/api/me/colonies/web/tokens", { authorization: `Bearer ${ADMIN}` })).status).toBe(401);
  });

  it("refuses the session's writes from another site", async () => {
    const { me } = await owned();
    expect((await me.call("POST", "/api/me/colonies/web/tokens", { body: { role: "agent", label: "x" }, origin: "https://evil.test" })).status).toBe(403);
    expect((await me.call("POST", "/api/me/colonies/web/tokens", { body: { role: "agent", label: "x" }, origin: null })).status).toBe(403);
  });
});

describe("tokens on the REST API", () => {
  it("name only real routes", () => {
    const routes = new Set(createApi({ provisionTrunk: async () => ({ trunk: { namespace: "", name: "", remote: "" }, trunkSha: "" }), spawnSwarm: async () => null }).routes.map((r) => `${r.method} ${r.path}`));
    for (const key of Object.keys(ROUTE_NEEDS)) expect(routes, key).toContain(key);
  });

  it("authorize exactly their role on exactly their colony", async () => {
    const { w, mint } = await owned();
    const tokens = { agent: await mint("agent"), reviewer: await mint("reviewer"), owner: await mint("owner") };
    for (const [key, need] of Object.entries(ROUTE_NEEDS)) {
      const [method = "", path = ""] = key.split(" ");
      for (const role of ["agent", "reviewer", "owner"] as const) {
        const res = await w.request(method, `/api${concrete(path, "web")}`, { authorization: `Bearer ${tokens[role].secret}` }, method === "GET" ? undefined : {});
        if (ALLOWS[role].includes(need)) expect([401, 403], `${role} on ${key}`).not.toContain(res.status);
        else {
          expect(res.status, `${role} on ${key}`).toBe(403);
          expect(((await res.json()) as { error: string }).error).toMatch(new RegExp(`^This is an? ${role} token`));
        }
      }
      // The deployment's admin token works on every one, as before.
      expect([401, 403], `admin on ${key}`).not.toContain((await w.request(method, `/api${concrete(path, "web")}`, { authorization: `Bearer ${ADMIN}` }, method === "GET" ? undefined : {})).status);
    }
  });

  it("never work on an operator colony or another person's colony, nor on routes only the admin token takes", async () => {
    const { w, mint } = await owned();
    await w.operatorColony("showcase");
    const other = await w.person(bob);
    expect((await other.call("POST", "/api/me/colonies", { body: { name: "bobs" } })).status).toBe(201);
    const owner = await mint("owner");
    for (const colony of ["showcase", "bobs"]) {
      for (const path of ["/colonies/:id/intents", "/colonies/:id/review/:pid", "/colonies/:id/agents/:aid/take"]) {
        const res = await w.request("POST", `/api${concrete(path, colony)}`, { authorization: `Bearer ${owner.secret}` }, {});
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe(`This token is for colony web only, so it cannot act on colony ${colony}.`);
      }
    }
    for (const [method, path] of [
      ["DELETE", "/api/colonies/web"],
      ["POST", "/api/pause"],
      ["POST", "/api/colonies"],
      ["POST", "/api/accounts/invites"],
    ] as const) {
      const res = await w.request(method, path, { authorization: `Bearer ${owner.secret}` }, method === "DELETE" ? undefined : { name: "x" });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // No token at all: 401, exactly as before.
    expect((await w.request("POST", "/api/colonies/web/intents", {}, {})).status).toBe(401);
  });

  it("stop working once revoked, expired, or their colony is deleted", async () => {
    const { w, me, mint } = await owned();
    const a = await mint("agent", { days: 1 });
    const b = await mint("agent");
    const take = (secret: string) => w.request("POST", "/api/colonies/web/agents/agt_1/take", { authorization: `Bearer ${secret}` }, {});
    expect((await take(a.secret)).status).toBe(200);
    await me.call("DELETE", `/api/me/colonies/web/tokens/${b.token.id}`);
    expect((await take(b.secret)).status).toBe(401);
    expect(((await (await take(b.secret)).json()) as { error: string }).error).toMatch(/^This token was revoked at /);
    w.tick(DAY + 1);
    const late = await take(a.secret);
    expect(late.status).toBe(401);
    expect(((await late.json()) as { error: string }).error).toMatch(/^This token expired at /);
    const c = await mint("owner");
    expect((await w.request("DELETE", "/api/colonies/web", { authorization: `Bearer ${ADMIN}` })).status).toBe(200);
    expect(w.store.ownerOf("web")).toBeNull();
    expect((await take(c.secret)).status).toBe(401);
    expect((await take(`ftt_${"a".repeat(32)}`)).status).toBe(401);
  });

  it("cap an owned colony's in-platform agents", async () => {
    const { w, mint } = await owned();
    const owner = await mint("owner");
    w.setAgents(MAX_AGENTS_PER_COLONY - 1);
    expect((await w.request("POST", "/api/colonies/web/swarm", { authorization: `Bearer ${owner.secret}` }, { count: 1 })).status).toBe(202);
    const over = await w.request("POST", "/api/colonies/web/swarm", { authorization: `Bearer ${owner.secret}` }, { count: 2 });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toMatch(/at most 1 more can start/);
    expect(w.spawned).toEqual([{ colonyId: "web", count: 1 }]);
    // The operator's admin token is not held to an account's quota.
    expect((await w.request("POST", "/api/colonies/web/swarm", { authorization: `Bearer ${ADMIN}` }, { count: 5 })).status).toBe(202);
  });

  it("are ignored entirely with FT_ACCOUNTS off: a scoped token is just a wrong admin token", async () => {
    const { w, mint } = await owned();
    const owner = await mint("owner");
    const off = { ...w.env, FT_ACCOUNTS: "off" };
    const res = await w.app.request(`${ORIGIN}/api/colonies/web/intents`, { method: "POST", headers: { authorization: `Bearer ${owner.secret}`, "content-type": "application/json" }, body: "{}" }, off);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("the owner's session on the REST API", () => {
  it("decides reviews on their own colony as github:<login>, verified", async () => {
    const { w, me } = await owned();
    const res = await me.call("POST", "/api/colonies/web/review/prp_1", { body: { decision: "approve", reason: "looks right", by: "Ada L" } });
    expect(res.status).toBe(200);
    const decide = w.calls.filter((c) => c.object === "colony:web" && c.method === "decide").at(-1);
    expect(decide?.args.slice(0, 5)).toEqual(["prp_1", "approve", "looks right", "github:ada", true]);
    expect(decide?.args[5]).toEqual({ by: "github:ada", identity: "verified", verifiedBy: "github", stated: "Ada L" });
    // The decision row (and from it the lineage note) records it as verified, by the GitHub sign-in.
    expect(identityAnswers(decide?.args[5] as ApproverWho)).toEqual({ identity: "verified", verifiedBy: "github", stated: "Ada L" });
    expect(identityAnswers({ by: "ada@example.com", identity: "verified" })).toEqual({ identity: "verified", verifiedBy: "access" });
    // With the admin token instead, the approver is recorded as before: the stated name.
    await w.request("POST", "/api/colonies/web/review/prp_1", { authorization: `Bearer ${ADMIN}` }, { decision: "approve", reason: "ok", by: "ops" });
    expect(w.calls.filter((c) => c.method === "decide").at(-1)?.args[5]).toEqual({ by: "ops", identity: "stated" });
  });

  it("is refused from another site, and is no key to anyone else's colony", async () => {
    const { w, me } = await owned();
    await w.operatorColony("showcase");
    const cross = await me.call("POST", "/api/colonies/web/intents", { body: { title: "t", footprint: ["a.ts"] }, origin: "https://evil.test" });
    expect(cross.status).toBe(403);
    expect((await me.call("POST", "/api/colonies/showcase/intents", { body: { title: "t", footprint: ["a.ts"] } })).status).toBe(401);
    const other = await w.person(bob);
    expect((await other.call("POST", "/api/colonies/web/intents", { body: { title: "t", footprint: ["a.ts"] } })).status).toBe(401);
    expect((await me.call("POST", "/api/colonies/web/intents", { body: { title: "t", footprint: ["a.ts"] } })).status).toBe(201);
// A read the session may make (an agent's inbox) needs no Origin: browsers send none on a GET.
expect((await me.call("GET", "/api/colonies/web/agents/agt_1/inbox")).status).toBe(200);
    expect((await me.call("DELETE", "/api/colonies/web")).status).toBe(401);
  });
});
