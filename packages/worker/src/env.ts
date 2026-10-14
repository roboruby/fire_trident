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
  /** Version metadata: the Worker version serving a request (id, tag, upload time), for GET /api/about (front/about.ts). */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  FT_PUBLIC_URL: string;
  /**
   * Optional: the short git commit this deployment was built from, set by the deploy command
   * (`wrangler deploy --var FT_BUILD:$(git rev-parse --short HEAD)`). GET /api/about, every page's footer or top bar
   * and `ft status` show it as "build <commit>"; absent, they show the Worker version instead.
   */
  FT_BUILD?: string;
  FT_DEFAULT_MODEL: string;
  FT_BULK_MODEL: string;
  FT_REFLEX_MODEL: string;
  /** Secret: bearer token for mutating API routes. */
  FT_ADMIN_TOKEN?: string;
  /**
   * Secret (optional): the key that signs lineage notes, an Ed25519 private key as a JWK JSON string
   * ({"kty":"OKP","crv":"Ed25519","d":"…","x":"…"}, with an optional "since": the ISO date it started signing). With it,
   * the trunk writer signs each landing commit it builds (an FT-Note-Signature trailer just above FT-Note, over the note's
   * digest, the commit's tree and its parent: trunk/signature.ts), its public key is published at
   * /.well-known/firetrident-keys.json, GET /api/about names its key id, and the note checks say whether each commit is
   * signed. Absent, or not such a key (logged once, never printed), landings stay unsigned and nothing fails.
   */
  FT_NOTE_KEY?: string;
  /** Optional: co-change repulsion weight (see ColonyDO; the simulator favors 5). */
  FT_COCHANGE_WEIGHT?: string;
  /** Optional: lateral inhibition threshold as a fraction of a fresh claim, or "off". */
  FT_LATERAL_INHIBITION?: string;
  /** Optional: import-aware repulsion weight in take() (imports and importers of claimed files); absent or 0 is off. */
  FT_IMPORT_WEIGHT?: string;
  /**
   * Optional: import-name revalidation, "on", or a comma-separated list of colony ids; absent or "off" is off. A change
   * stale only on files it read lands when the names it imports from them are still exported and each of those files only
   * gained top-level declarations since the version it read; otherwise it goes back naming the file and the line.
   */
  FT_REVALIDATE?: string;
  /**
   * Optional: text merge, "on", or a comma-separated list of colony ids; absent or "off" is off. A change stale only on
   * files it writes (trunk changed them after its base) lands when each of them merges cleanly, line by line, with the
   * version it would land on (core/textmerge.ts); otherwise it goes back as before, a conflict named in the reason.
   */
  FT_TEXT_MERGE?: string;
  /**
   * Optional: text merge's insertion rule, "on", or a comma-separated list of colony ids; absent or "off" is off. Where
   * text merge is on too, a file whose only conflicting hunks are lines both sides inserted at the same place of the base
   * lands as the union of the two insertions, trunk's lines first, leaving out the lines of the change trunk already
   * inserted there (core/insertions.ts); its merged entry records `rule: "insertions"`, and the trunk writer counts
   * `trunk.mergedInsertions`. A hunk that edits or deletes a base line still sends the change back, naming the hunk.
   */
  FT_MERGE_INSERTIONS?: string;
  /**
   * Optional: the conflict resolver, "on", or a comma-separated list of colony ids; absent or "off" is off. A change that
   * text merge sent back for overlapping hunks is merged by the platform (colony/resolver.ts): one model call writes each
   * conflicting file keeping both changes, deterministic checks validate it, and it goes through the decide stage as a new
   * proposal for the same intent. When that fails, the return stands and the intent reopens as before.
   */
  FT_RESOLVER?: string;
  /** Optional: the model the conflict resolver calls; FT_DEFAULT_MODEL when absent ("default" and "bulk" name the server's models). */
  FT_RESOLVER_MODEL?: string;
  /**
   * Optional: model step-up, "on", or a comma-separated list of colony ids; absent or "off" is off. When an intent's
   * changes have come back twice since it last changed course (a landing or a substantive amendment), its next take asks
   * for the stronger model class ("default", FT_DEFAULT_MODEL) and says why (colony/stepup.ts): in-platform agents write
   * that attempt's files with it, and outside agents get it as advice. A third return still reaches the needs-you strip.
   */
  FT_MODEL_STEPUP?: string;
  /**
   * Optional: the deletion guard, "on", or a comma-separated list of colony ids; absent or "off" is off. In a trunk
   * cycle that deletes files, a change goes back while a trunk file's import of a file it deletes would resolve to nothing.
   */
  FT_DELETION_GUARD?: string;
  /**
   * Optional: the export guard, "on", or a comma-separated list of colony ids; absent or "off" is off. In a trunk cycle
   * that changes script files, a change goes back while a script file imports a name it stops exporting (an importer
   * on trunk, or a file a change ahead of it in the cycle writes), unless the same change or one accepted ahead of it
   * rewrites that importer without the import; of a change that stops exporting a name and one that imports it anew in
   * the same cycle, the second goes back naming the first (trunk/plan.ts brokenExports). It fails open: what it cannot
   * read for sure is skipped and counted as `trunk.exportsUncovered`.
   */
  FT_EXPORT_GUARD?: string;
  /**
   * Optional: the goal-conflict check, "on", or a comma-separated list of colony ids; absent or "off" is off. In the
   * decide stage, a change that would undo lines a recent landing wrote for another intent (neither an ancestor nor a
   * descendant of its own; at least 3 lines and half of that landing's lines in the file) waits for a person instead of
   * landing, the reason naming the landing and its intent's why (decide/goalconflict.ts, core/goalconflict.ts). Recent:
   * the decide policy's goalConflictMinutes (60) and goalConflictLandings (200). The check fails open.
   */
  FT_GOAL_CONFLICT?: string;
  /**
   * Optional: twin intents caught at declare, "on", or a comma-separated list of colony ids; absent or "off" is off. An
   * intent a person or an agent declares (POST /intents, MCP declare) whose normalized title words score at least 0.8
   * (Jaccard) against an intent open, claimed, proposed or landed in the last 30 minutes, and whose footprint overlaps
   * it, is not created: the answer is that intent with `duplicateOf`, `similar` and a note (REST 200 instead of 201),
   * unless the declare says `force: true` (core/twins.ts, colony/twins.ts). Rule intents, certification repairs, spec
   * imports (`ft new` declares with force) and the colony's own intents are never checked.
   */
  FT_TWINS?: string;
  /**
   * Optional: the megafile alarm, "on", or a comma-separated list of colony ids; absent or "off" is off. A script file
   * that grew fast while many agents wrote it, or that changes keep colliding on, turns hot (core/hotness.ts): the
   * colony declares an intent to split it and holds the file (no other change may write it, no other intent covering
   * it is offered) until the split lands, is withdrawn or reported, or an hour passes (colony/megafile.ts).
   */
  FT_MEGAFILE?: string;
  /**
   * Optional: inline changes from outside, "on", or a comma-separated list of colony ids; absent or "off" is off. A
   * proposal may then carry the text of the files it writes (`contents` on POST /proposals, `files` on MCP propose)
   * instead of a commit pushed to its workspace, and the MCP server offers `files` and says so in its instructions.
   * The colony, the decide stage and the trunk writer handle an inline change whoever sends it (colony/inline.ts).
   */
  FT_INLINE?: string;
  /**
   * Optional: virtual checkouts for in-platform agents, "on", or a comma-separated list of colony ids; absent or "off" is
   * off. An agent then never clones: it reads trunk object by object through the ARTIFACTS binding at its lease base
   * (agents/virtual.ts) and proposes its change inline (Proposal.contents). A change over the inline limits, or with
   * binary content, is still committed and pushed to the agent's workspace.
   */
  FT_VIRTUAL_CHECKOUT?: string;
  /**
   * Optional: asynchronous trunk publishing, "on", or a comma-separated list of colony ids; absent or "off" is off.
   * A landing counts once the trunk writer records it; a publish loop beside the landing cycles pushes the recorded
   * commits to the trunk repository in order (trunk/publish.ts). Leases, `certified` and the lineage notes follow the
   * published head; lanes validate against the recorded one.
   */
  FT_ASYNC_PUBLISH?: string;
  /** Optional (load tests only): when set, ColonyDO logs event-loop lag and streams it as colony.lagMs. */
  FT_LAG_PROBE?: string;
  /**
   * Test hook (previews only; never set in production): the trunk writer sleeps this many milliseconds in each landing
   * cycle between its direction check and its push (at most 60 s), so a live check can withdraw an intent while its
   * change is mid-cycle (scripts/direction_race.rb). Read only when set.
   */
  FT_TEST_PUSH_DELAY_MS?: string;
  /**
   * Optional: colonies whose trunk anyone may clone and fetch read-only with plain git at
   * /git/<colony>.git (comma-separated colony ids). Empty or unset turns the proxy off.
   */
  FT_PUBLIC_GIT?: string;
  /**
   * Optional: colonies anyone's agent may ask about over a read-only, stateless MCP endpoint at /public/mcp, with no
   * token (comma-separated colony ids, parsed like FT_PUBLIC_GIT; there is no "on"): tools status, why, intent and
   * sense, over read stubs only (mcp/public.ts). Empty or unset turns the endpoint off (404).
   */
  FT_PUBLIC_MCP?: string;
  /** Local development only: "1" lets writes and MCP through when their tokens are not configured. Never set it on a deployment. */
  FT_OPEN_WRITES?: string;
  /** Secret (optional): token MCP clients must present at /mcp and /sse. */
  FT_MCP_TOKEN?: string;
  /**
   * Optional: a call budget for each MCP session at /mcp and /sse, "on" (4 tool calls a second, 20 at once after a
   * pause) or "<calls per second>,<burst>" such as "8,40"; absent, "off" or anything else is off. Global, since a
   * session may not have joined a colony yet. A call that finds its session's bucket empty answers rate_limit (429,
   * retryable after retryAfterMs, the time until a token is back) without running, so it never reaches the colony
   * (mcp/budget.ts). The bucket lives in the session object's memory: a new session starts with a full one. The
   * public read-only MCP (/public/mcp) keeps its own caps.
   */
  FT_AGENT_CALL_BUDGET?: string;
  /** Secret (optional): enables Claude agents via AI Gateway / Anthropic. */
  ANTHROPIC_API_KEY?: string;
  /** Dynamic Workers (Worker Loader): trunk certification runs each colony's own tests in one. */
  LOADER?: WorkerLoader;
  /** "on": certify trunk after landings by running the colony's own tests (each colony's policy can turn it off). */
  FT_TRUNK_TESTS?: string;
  /**
   * Optional: the field guide, "on", or a comma-separated list of colony ids; absent or "off" is off. An agent may leave
   * one lesson with a proposal (`lesson` on MCP and REST propose, a `LESSON:` line from in-platform agents); it reaches
   * other agents' takes, with its author, model and landing, once its change landed and the first certification of
   * trunk after it is green, or a person approves it (colony/guide.ts). Its landing reverted, a red certification naming
   * it, or a person's rejection drops it.
   */
  FT_FIELD_GUIDE?: string;
  /**
   * Optional: culprit finding, "on", or a comma-separated list of colony ids; absent or "off" is off. A red certification
   * names the landings that changed what its failing test files load since the last green commit (its `suspects`), and
   * its repair intent's why names them too.
   */
  FT_CULPRITS?: string;
  /**
   * Optional: the first red search, "on", or a comma-separated list of colony ids; absent or "off" is off. After a red
   * certification is recorded, its failing test files and what they load run alone on the commits since the last green
   * certification (from the trunk writer's landing log), halving the range each run, at most 8 runs and 60 s in all; the
   * result gains `firstRed` (the commit, its landing and intents, the proposals that changed what the tests load), a
   * `bisect` event says so, and the open repair intent's why names it (certify/bisect.ts). Never on a landing's path.
   */
  FT_BISECT?: string;
}

export const WORKSPACE_SHARDS = 4;
