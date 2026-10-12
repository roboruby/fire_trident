import { Hono } from "hono";
import type { Env } from "./env.ts";
import { api } from "./api/routes.ts";
import { FireTridentMcp } from "./mcp/FireTridentMcp.ts";

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
app.all("/mcp", (c) => mcpHttp.fetch(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext));
app.all("/mcp/*", (c) => mcpHttp.fetch(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext));
app.all("/sse", (c) => mcpSse.fetch(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext));
app.all("/sse/*", (c) => mcpSse.fetch(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext));
// Static UI falls through to ASSETS.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
