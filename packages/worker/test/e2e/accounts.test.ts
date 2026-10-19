import { env } from "cloudflare:test";
import type { Env } from "../../src/env.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODELS_OFF, PERSON_DECIDES } from "../../src/cloudflare/models.ts";
import { decisionReceipt, receiptText } from "../../../web/src/receipt.ts";
import { ACCOUNT_A, ALL_SCOPES, NO_AI_SCOPES } from "../cloudflare/fake-cloudflare.ts";
import { Browser, Network, McpClient, admin, connectCloudflare, eventually, signUp } from "./deployment.ts";

/**
 * Accounts end to end, on the Worker itself (src/index.ts) with every Durable Object real: a person is invited, signs in
 * with GitHub, connects their Cloudflare account and chooses which one, creates a colony from a public repository (its
 * trunk imported into their Artifacts), mints an agent token; their agent joins over MCP, takes the work, proposes and,
 * once the owner approved what review put before them (on the owner's Workers AI), the change lands on trunk in the
 * owner's Artifacts. The token works nowhere else. The owner deletes the colony and its repositories are gone.
 */

/** Every object with a `layer` in a JSON answer: the decisions a lineage note keeps. */
function decisionsIn(x: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(x)) return x.flatMap(decisionsIn);
  if (!x || typeof x !== "object") return [];
  const o = x as Record<string, unknown>;
  return [...(typeof o.layer === "string" && typeof o.action === "string" ? [o] : []), ...Object.values(o).flatMap(decisionsIn)];
}

/** The models the deployment's own Workers AI binding ran (the e2e project binds a counting stand-in, vitest.config.ts). */
function deploymentAiCalls(): Promise<string[]> {
  return (env as unknown as { AI: { calls(): Promise<string[]> } }).AI.calls();
}

const net = new Network();
beforeAll(() => net.install());
afterAll(() => net.uninstall());

const SOURCE = "https://github.com/example/shop.git";
const HELLO = "export const hello = (name: string): string => `hello, ${name}`;\n";

describe("a person's colony on their own Cloudflare account", () => {
  it("runs from invite to landing, reviewed on the owner's Workers AI, and is deleted from the owner's Artifacts", async () => {
    await net.artifacts.addSource(SOURCE, { "README.md": "# shop\n", "src/index.ts": "export const ready = true;\n" });
    net.clef = { needs_human: { type: "noul", noul: 0.95 }, off_intent: { type: "noul", noul: 0.95 } };
    const ada = await signUp(net, { id: 101, login: "ada-dev", name: "Ada" });

    // Without a Cloudflare connection, no colony.
    const early = await ada.browser.json("POST", "/api/me/colonies", { body: { name: "shop", source: { url: SOURCE } } });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/^Connect your Cloudflare account first/);

    // Signed out, connecting is refused; signed in, the session cookie (__Host-ft_session, Path=/) travels to /auth/cloudflare/*.
    expect((await new Browser().call("GET", "/auth/cloudflare/start")).status).toBe(401);
    expect(ada.browser.jar.header("/auth/cloudflare/callback")).toContain("__Host-ft_session=");
    expect(await connectCloudflare(net, ada, ALL_SCOPES)).toBe(`https://ft.test/account?cloudflare=choose`);
    const me = await ada.browser.json("GET", "/api/me");
    expect(me.body).toMatchObject({ signedIn: true, cloudflare: "connected", account: { id: ada.id, github: { login: "ada-dev" } } });
    expect(me.body.modelsOff).toBeUndefined();

    const created = await ada.browser.json("POST", "/api/me/colonies", { body: { name: "shop", source: { url: SOURCE } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.owner).toBe(ada.id);
    expect(await net.artifacts.readText("firetrident-trunk", "shop--trunk", "src/index.ts")).toBe("export const ready = true;\n");

    // The owner mints an agent token (shown once) and says what to do, from their session.
    const minted = await ada.browser.json("POST", "/api/me/colonies/shop/tokens", { body: { role: "agent", label: "Ada's agent", days: 7 } });
    expect(minted.status).toBe(201);
    const agentToken: string = minted.body.secret;
    const declared = await ada.browser.json("POST", "/api/colonies/shop/intents", { body: { title: "Say hello", why: "The shop greets people by name.", footprint: ["src/**"] } });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);

    // The agent joins over MCP with the token, takes the intent and proposes without git (FT_INLINE).
    const agent = new McpClient(agentToken);
    expect((await agent.initialize()).status).toBe(200);
    const joined = await agent.tool("join", { colony: "shop", name: "ada-agent", model: "@cf/test/author-model" });
    expect(joined.ok, joined.error).toBe(true);
    const took = await agent.tool("take", { wait: 30 });
    expect(took.ok, took.error).toBe(true);
    expect(took.data.intent.title).toBe("Say hello");
    const proposed = await agent.tool("propose", { files: [{ path: "src/hello.ts", content: HELLO }], summary: "Add hello", notVerified: "No tests were run." });
    expect(proposed.ok, proposed.error).toBe(true);
    const pid: string = proposed.data.proposal.id;
    expect(pid).toMatch(/^prp_/);

    // Review runs on the owner's Workers AI (its reflex sees a change a person should look at) and puts it before the owner.
    const queued = await eventually(
      () => admin<{ status: string; reason?: string }>("GET", `/api/colonies/shop/proposals/${pid}`),
      (r) => r.body?.status !== "checking",
    );
    expect(queued.body.status, JSON.stringify(queued.body)).toBe("escalated");
    expect(net.ai.length).toBeGreaterThan(0);
    const bearers = new Set(net.ai.map((c) => c.bearer));
    expect(net.ai.every((c) => c.account === ACCOUNT_A.id && net.live(c.bearer, ["ai.read", "ai.write"]))).toBe(true);
    expect(bearers.size).toBe(1);
    expect(await deploymentAiCalls()).toEqual([]);

    // The owner approves from their session: recorded as their GitHub login, verified by the GitHub sign-in.
    const approved = await ada.browser.json("POST", `/api/colonies/shop/review/${pid}`, { body: { decision: "approve", reason: "Reads well." } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.recorded).toEqual({ by: "github:ada-dev", identity: "verified" });

    // The change lands on trunk in the owner's Artifacts.
    const landed = await eventually(
      () => admin<{ status: string }>("GET", `/api/colonies/shop/proposals/${pid}`),
      (r) => r.body?.status === "landed",
      60_000,
    );
    expect(landed.body.status, JSON.stringify(landed.body)).toBe("landed");
    expect(await net.artifacts.readText("firetrident-trunk", "shop--trunk", "src/hello.ts")).toBe(HELLO);

    // The lineage note's receipt names the approver, verified; a public read never names the owning account.
    const why = await ada.browser.json("GET", "/api/colonies/shop/why?path=src/hello.ts");
    expect(why.status).toBe(200);
    const text = JSON.stringify(why.body);
    expect(text).toContain('"by":"github:ada-dev"');
    const human = decisionsIn(why.body).find((d) => d.layer === "human");
    expect(human).toMatchObject({ layer: "human", action: "approve", by: "github:ada-dev", identity: "verified" });
    expect(receiptText(decisionReceipt(human as never)!)).toMatch(/^verified by GitHub · at head [0-9a-f]{12}/);
    expect(text).not.toContain(ada.id);
    const publicColony = await ada.browser.json("GET", "/api/colonies/shop");
    expect(JSON.stringify(publicColony.body)).not.toContain(ada.id);
    expect(JSON.stringify((await admin("GET", "/api/colonies/shop")).body)).toContain(ada.id);

    // An in-platform agent the owner starts runs its model on the owner's Workers AI as well.
    const before = net.ai.length;
    const spawned = await ada.browser.json("POST", "/api/colonies/shop/swarm", { body: { count: 1 } });
    expect(spawned.status, JSON.stringify(spawned.body)).toBe(202);
    expect((await ada.browser.json("POST", "/api/colonies/shop/intents", { body: { title: "Say goodbye", why: "The shop says goodbye too.", footprint: ["src/**"] } })).status).toBe(201);
    const agentCalls = await eventually(
      async () => net.ai.slice(before).filter((c) => Array.isArray(c.input.messages)),
      (calls) => calls.length > 0,
      60_000,
    );
    expect(agentCalls.length).toBeGreaterThan(0);
    expect(agentCalls.every((c) => c.account === ACCOUNT_A.id && net.live(c.bearer, ["ai.read", "ai.write"]))).toBe(true);
    expect(await deploymentAiCalls()).toEqual([]);
    expect((await ada.browser.json("POST", "/api/colonies/shop/swarm/stop", { body: {} })).status).toBe(200);

    // The token works on its colony only: not on an operator colony, not on another person's colony, on REST or MCP.
    const colonies = (env as unknown as Env).COLONY;
    await colonies.get(colonies.idFromName("ops")).init({ colonyId: "ops", name: "ops", trunk: { namespace: "ft-trunk", name: "ops--trunk", remote: "https://artifacts.invalid/ops.git" }, trunkSha: "a".repeat(40) });
    const bob = await signUp(net, { id: 202, login: "bob-dev" });
    await connectCloudflare(net, bob, ALL_SCOPES);
    expect((await bob.browser.json("POST", "/api/me/colonies", { body: { name: "bobs" } })).status).toBe(201);
    for (const other of ["ops", "bobs"]) {
      const rest = await ada.browser.json("POST", `/api/colonies/${other}/intents`, { bearer: agentToken, body: { title: "Not yours", footprint: ["src/**"] } });
      expect(rest.status).toBe(403);
      expect(rest.body.error).toBe(`This token is for colony shop only, so it cannot act on colony ${other}.`);
      const mcp = await agent.tool("join", { colony: other });
      expect(mcp.ok).toBe(false);
      expect(mcp.error).toBe(`This token is for colony shop only, so it cannot join colony ${other}.`);
      // Nor does the owner's session reach past their own colonies: there the admin token decides, as before.
      expect((await ada.browser.json("POST", `/api/colonies/${other}/intents`, { body: { title: "Not yours", footprint: ["src/**"] } })).status).toBe(401);
    }
    expect(net.repos("bobs--")).toContain("firetrident-trunk/bobs--trunk");

    // Only the owner deletes their colony; then its repositories are gone from their Artifacts and its tokens stop working.
    expect((await bob.browser.json("DELETE", "/api/me/colonies/shop")).status).toBe(403);
    expect(net.repos("shop--").length).toBeGreaterThan(1);
    const deleted = await ada.browser.json("DELETE", "/api/me/colonies/shop");
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toMatchObject({ colonyId: "shop", found: true, ok: true });
    expect(net.repos("shop--")).toEqual([]);
    expect(net.repos("bobs--")).toContain("firetrident-trunk/bobs--trunk");
    expect((await ada.browser.json("GET", "/api/me")).body.colonies).toEqual([]);
    expect((await admin<{ colonies: Array<{ id: string }> }>("GET", "/api/colonies")).body.colonies.map((c) => c.id)).not.toContain("shop");
    const revoked = await ada.browser.json("POST", "/api/colonies/shop/agents", { bearer: agentToken, body: { kind: "external", name: "late" } });
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toMatch(/^This token was revoked at /);
    expect((await new McpClient(agentToken).initialize()).status).toBe(401);

    // The operator's delete of a person's colony does the same: the owner's Artifacts swept, the ownership released.
    const swept = await admin("DELETE", "/api/colonies/bobs");
    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(net.repos("bobs--")).toEqual([]);
    expect((await bob.browser.json("GET", "/api/me")).body.colonies).toEqual([]);
    expect(net.unexpected).toEqual([]);
  });
});

describe("a person's colony without Workers AI", () => {
  it("works with the owner's own MCP agent, sends what a model would have reviewed to the owner, and refuses in-platform agents", async () => {
    net.cloudflare.accounts = [ACCOUNT_A];
    net.clef = {};
    const cy = await signUp(net, { id: 303, login: "cy-dev" });
    // One account: connecting needs no choice. Workers AI is not allowed.
    expect(await connectCloudflare(net, cy, NO_AI_SCOPES)).toBe("https://ft.test/account?cloudflare=connected");
    expect((await cy.browser.json("GET", "/api/me/cloudflare")).body).toMatchObject({ state: "connected", workersAi: false });
    expect((await cy.browser.json("GET", "/api/me")).body).toMatchObject({ cloudflare: "connected", modelsOff: MODELS_OFF.no_workers_ai });

    expect((await cy.browser.json("POST", "/api/me/colonies", { body: { name: "garden" } })).status).toBe(201);
    expect(await net.artifacts.readText("firetrident-trunk", "garden--trunk", "README.md")).not.toBeNull();
    const aiBefore = net.ai.length;

    // In-platform agents: refused, with the sentence.
    const swarm = await cy.browser.json("POST", "/api/colonies/garden/swarm", { body: { count: 2 } });
    expect(swarm.status).toBe(409);
    expect(swarm.body.error).toBe(MODELS_OFF.no_workers_ai);
    expect((await admin<{ agents: unknown[] }>("GET", "/api/colonies/garden/agents")).body.agents).toEqual([]);

    // The owner's own agent over MCP: the deterministic layers run, and where a model would review the change, the owner
    // decides (it fails closed); once they approve, it lands.
    const token = (await cy.browser.json("POST", "/api/me/colonies/garden/tokens", { body: { role: "agent", label: "Cy's agent" } })).body.secret as string;
    expect((await cy.browser.json("POST", "/api/colonies/garden/intents", { body: { title: "Plant a tree", footprint: ["src/**"] } })).status).toBe(201);
    const agent = new McpClient(token);
    expect((await agent.initialize()).status).toBe(200);
    expect((await agent.tool("join", { colony: "garden", name: "cy-agent" })).ok).toBe(true);
    expect((await agent.tool("take", { wait: 30 })).ok).toBe(true);
    const proposed = await agent.tool("propose", { files: [{ path: "src/tree.ts", content: "export const tree = 1;\n" }], summary: "Plant a tree", notVerified: "No tests were run." });
    expect(proposed.ok, proposed.error).toBe(true);
    const pid: string = proposed.data.proposal.id;
    const waiting = await eventually(
      () => admin<{ status: string; reason?: string }>("GET", `/api/colonies/garden/proposals/${pid}`),
      (r) => r.body?.status !== "checking",
    );
    expect(waiting.body.status, JSON.stringify(waiting.body)).toBe("escalated");
    expect(waiting.body.reason).toBe(`escalated by deterministic: ${PERSON_DECIDES.no_workers_ai}`);
    const approved = await cy.browser.json("POST", `/api/colonies/garden/review/${pid}`, { body: { decision: "approve", reason: "Fine." } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.recorded).toEqual({ by: "github:cy-dev", identity: "verified" });
    const landed = await eventually(
      () => admin<{ status: string }>("GET", `/api/colonies/garden/proposals/${pid}`),
      (r) => r.body?.status === "landed",
      60_000,
    );
    expect(landed.body.status, JSON.stringify(landed.body)).toBe("landed");
    expect(await net.artifacts.readText("firetrident-trunk", "garden--trunk", "src/tree.ts")).toBe("export const tree = 1;\n");
    expect(net.ai.length).toBe(aiBefore);
    // The deployment's own Workers AI is bound here and was never asked.
    expect(await deploymentAiCalls()).toEqual([]);
    expect(net.unexpected).toEqual([]);
  });
});
