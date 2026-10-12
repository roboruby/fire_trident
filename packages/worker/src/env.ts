import type { AgentDO } from "./agents/AgentDO.ts";
import type { ColonyDO } from "./colony/ColonyDO.ts";
import type { FireTridentMcp } from "./mcp/FireTridentMcp.ts";
import type { PoolDO } from "./pool/PoolDO.ts";
import type { RegionDO } from "./region/RegionDO.ts";
import type { TrunkDO } from "./trunk/TrunkDO.ts";

/** Every binding the Worker has. Mirrors wrangler.jsonc; keep them in sync. */
export interface Env {
  ASSETS: Fetcher;
  COLONY: DurableObjectNamespace<ColonyDO>;
  REGION: DurableObjectNamespace<RegionDO>;
  TRUNK: DurableObjectNamespace<TrunkDO>;
  POOL: DurableObjectNamespace<PoolDO>;
  AGENT: DurableObjectNamespace<AgentDO>;
  MCP: DurableObjectNamespace<FireTridentMcp>;
  /** Trunks and lane repos (namespace ft-trunk). */
  ARTIFACTS: Artifacts;
  /** Workspace shards (namespaces ft-ws-0..3). Use workspaceBinding() to pick one. */
  WS0: Artifacts;
  WS1: Artifacts;
  WS2: Artifacts;
  WS3: Artifacts;
  /** Agent session repos (namespace ft-sessions). */
  SESSIONS: Artifacts;
  AI: Ai;
  INGEST: Workflow;
  VERIFY: Workflow;
  METRICS: AnalyticsEngineDataset;
  FT_PUBLIC_URL: string;
  FT_DEFAULT_MODEL: string;
  FT_BULK_MODEL: string;
  FT_REFLEX_MODEL: string;
  /** Secret: bearer token for mutating API routes. */
  FT_ADMIN_TOKEN?: string;
  /** Optional: co-change repulsion weight (see ColonyDO; the simulator favors 5). */
  FT_COCHANGE_WEIGHT?: string;
  /** Optional: lateral inhibition threshold as a fraction of a fresh claim, or "off". */
  FT_LATERAL_INHIBITION?: string;
  /** Secret (optional): token MCP clients must present at /mcp and /sse. */
  FT_MCP_TOKEN?: string;
  /** Secret (optional): enables Claude agents via AI Gateway / Anthropic. */
  ANTHROPIC_API_KEY?: string;
}

export const WORKSPACE_SHARDS = 4;
