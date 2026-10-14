import { Hono } from "hono";
import type { Env } from "./env.ts";
import { api } from "./api/routes.ts";
import { gitProxy } from "./api/git-proxy.ts";
import { FireTridentMcp } from "./mcp/FireTridentMcp.ts";
import { mcpRefusal } from "./mcp/gate.ts";
import { publicMcp } from "./mcp/public.ts";

export { ColonyDO } from "./colony/ColonyDO.ts";
export { RegionDO } from "./region/RegionDO.ts";
export { TrunkDO } from "./trunk/TrunkDO.ts";
export { PoolDO } from "./pool/PoolDO.ts";
export { AgentDO } from "./agents/AgentDO.ts";
export { FireTridentMcp } from "./mcp/FireTridentMcp.ts";
export { IngestWorkflow } from "./workflows/IngestWorkflow.ts";
export { VerifyWorkflow } from "./workflows/VerifyWorkflow.ts";

const app = new Hono<{ Bindings: Env }>();
app.route("/api", api);
app.get("/healthz", (c) => c.json({ ok: true, service: "firetrident" }));
// MCP for external agents: Streamable HTTP at /mcp, legacy SSE at /sse (one Durable Object per session, binding MCP).
const mcpHttp = FireTridentMcp.serve("/mcp", { binding: "MCP" });
const mcpSse = FireTridentMcp.serveSSE("/sse", { binding: "MCP" });

/**
 * MCP clients must send FT_MCP_TOKEN as an `Authorization: Bearer` header (never in the URL), checked in
 * constant time. Without that secret the endpoint refuses (fail closed), unless FT_OPEN_WRITES is "1"
 * (local development only). See mcp/gate.ts.
 */
const mcpGate = (handler: typeof mcpHttp) => async (c: { req: { raw: Request }; env: Env; executionCtx: unknown }) =>
  (await mcpRefusal(c.req.raw, c.env)) ?? handler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);

app.all("/mcp", mcpGate(mcpHttp));
app.all("/mcp/*", mcpGate(mcpHttp));
app.all("/sse", mcpGate(mcpSse));
app.all("/sse/*", mcpGate(mcpSse));
// Read-only plain git (upload-pack only) for the colonies in FT_PUBLIC_GIT.
app.all("/git/*", (c) => gitProxy(c.req.raw, c.env));
// Read-only, stateless MCP with no token for the colonies in FT_PUBLIC_MCP (status, why, intent, sense); 404 when none are listed.
app.all("/public/mcp", (c) => publicMcp(c.req.raw, c.env));
// Static UI falls through to ASSETS.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
