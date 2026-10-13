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
  /** Optional (load tests only): when set, ColonyDO logs event-loop lag and streams it as colony.lagMs. */
  FT_LAG_PROBE?: string;
  /**
   * Optional: colonies whose trunk anyone may clone and fetch read-only with plain git at
   * /git/<colony>.git (comma-separated colony ids). Empty or unset turns the proxy off.
   */
  FT_PUBLIC_GIT?: string;
  /** Local development only: "1" lets writes and MCP through when their tokens are not configured. Never set it on a deployment. */
  FT_OPEN_WRITES?: string;
  /** Secret (optional): token MCP clients must present at /mcp and /sse. */
  FT_MCP_TOKEN?: string;
  /** Secret (optional): enables Claude agents via AI Gateway / Anthropic. */
  ANTHROPIC_API_KEY?: string;
  /** Dynamic Workers (Worker Loader): trunk certification runs each colony's own tests in one. */
  LOADER?: WorkerLoader;
  /** "on": certify trunk after landings by running the colony's own tests (each colony's policy can turn it off). */
  FT_TRUNK_TESTS?: string;
}

export const WORKSPACE_SHARDS = 4;
