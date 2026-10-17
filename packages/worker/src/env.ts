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
  /**
   * Optional: hedged model calls, "on", or a comma-separated list of colony ids; absent or "off" is off. Where it covers
   * the colony, a model call with no answer after its call site's wait goes out once more (colony/hedge.ts): Clef, the
   * second opinion (to its next candidate model), antibody minting, the contest judge and jury, the conflict resolver
   * and in-platform agents. The first answer wins, the other copy is aborted, both copies' tokens count in the spend,
   * and the decision record (`hedged`) and the model's check say which copy answered. Metrics `hedge.<site>.sent` and
   * `hedge.<site>.copy` count copies sent and copies whose answer was used.
   */
  FT_HEDGE?: string;
  /**
   * Optional: the hedge's wait in ms, for every call site ("8000") or by site ("review=8000,agent=90000"; sites reflex,
   * review, judge, antibody, resolver, agent), held to 1 s .. 10 minutes; absent, each site's own (HEDGE_AFTER_MS).
   */
  FT_HEDGE_MS?: string;
  /** Secret: bearer token for mutating API routes. */
  FT_ADMIN_TOKEN?: string;
  /**
   * Secret (optional): the key that signs lineage notes, an Ed25519 private key as a JWK JSON string
   * ({"kty":"OKP","crv":"Ed25519","d":"…","x":"…"}, with an optional "since": the ISO date it started signing). With it,
   * the trunk writer signs each landing commit it builds (an FT-Note-Signature trailer just above FT-Note, over the note's
   * digest, the commit's tree and its parent: trunk/signature.ts), its public key is published at
   * /.well-known/firetrident-keys.json, GET /api/about names its key id, and the note checks say whether each commit is
   * signed. The same key also signs each commit the stock git way (a gpgsig header holding an SSH signature, namespace
   * "git": trunk/gitsig.ts), so `git verify-commit` with gpg.format=ssh and the allowed signers published at
   * /.well-known/firetrident-allowed-signers checks it. Absent, or not such a key (logged once, never printed), landings
   * stay unsigned and nothing fails.
   */
  FT_NOTE_KEY?: string;
  /**
   * Optional (public data, a var or a secret): the keys this deployment signed lineage notes with before FT_NOTE_KEY's,
   * as a JSON array of {"x": <raw Ed25519 public key, base64url>, "since": <ISO date, optional>, "until": <ISO date>}
   * (trunk/signature.ts). /.well-known/firetrident-keys.json and the allowed signers list each one with its window, and a
   * signature checks out when its key is listed and the key was signing at the commit's time, so a rotated key's older
   * signatures stay good. An entry that is not such a key is left out (logged once). Absent, only FT_NOTE_KEY is published.
   */
  FT_NOTE_KEYS_RETIRED?: string;
  /**
   * Optional: credit trailers on landing commits, "on", or a comma-separated list of colony ids; absent or "off" is off.
   * Above the FT trailers, each agent whose change the commit lands is a `Co-authored-by:` (its name and a no-reply
   * address made from its id and the colony, never a real mailbox), and each person who approved a change of it an
   * `Approved-by:` (trunk/credits.ts). FT-Note-Signature and FT-Note stay the last two lines.
   */
  FT_CREDIT_TRAILERS?: string;
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
   * Optional: return hunks, "on", or a comma-separated list of colony ids; absent or "off" is off. When a change goes back
   * because trunk moved files it read or wrote, its return quotes what beat it (colony/returnhunks.ts): each landing that
   * movedBy names carries its unified diff of each moved file (movedBy[].hunks: about 40 lines a file, 3 files a landing),
   * and a text merge conflict carries each contested region (contested: the base, trunk and own lines, from the base line
   * where it starts), at most 120 lines and 8,000 characters a return, masked where a line looks like a secret. The colony
   * asks the trunk writer once per batch of returns and waits at most a second; past that, the return goes out as before,
   * its landings named. Agents read the hunks in the take's lastReturn, the MCP inbox and the in-platform agent's redo
   * prompt (fenced as data there); review cards show them under what beat the intent's last change.
   */
  FT_RETURN_HUNKS?: string;
  /**
   * Optional: heads-up, "on", or a comma-separated list of colony ids; absent or "off" is off. Every MCP tool reply to an
   * agent that holds an intent carries, when there is something to say, `headsUp` (mcp/headsup.ts, colony/headsup.ts):
   * the landings since its lease base that changed files it read or will write (path, landing, intent title), and the
   * changes waiting to land whose write sets meet its read or write set (proposal, intent title), with `deliveredThrough`,
   * the newest landing it has been told of. The colony reads its landing path index and the in-flight proposals (kept for
   * two seconds); the session keeps an answer for three seconds and waits at most 50 ms for one (past that the reply goes
   * out without it). Its take and checkout add a git command that records the colony and agent in the clone's local git
   * config, which `ft hook check` reads. Its proposals carry what it was told (Proposal.toldOf); when one goes back because
   * trunk moved, its reason ends by saying whether and when the agent was told of the landing that beat it, and
   * /metrics counts the return as `headsUp.warned` (warned and proposed anyway) or `headsUp.unwarned` (could not have known).
   */
  FT_HEADS_UP?: string;
  /**
   * Optional: model step-up, "on", or a comma-separated list of colony ids; absent or "off" is off. When an intent's
   * changes have come back twice since it last changed course (a landing or a substantive amendment), its next take asks
   * for the stronger model class ("default", FT_DEFAULT_MODEL) and says why (colony/stepup.ts): in-platform agents write
   * that attempt's files with it, and outside agents get it as advice. A third return still reaches the needs-you strip.
   */
  FT_MODEL_STEPUP?: string;
  /**
   * Optional: spend per intent, "on", or a comma-separated list of colony ids; absent or "off" is off. Every model call
   * is also counted for the intent it serves, as it happens (colony/intentspend.ts): in-platform agents count each call
   * under their job's intent in their journals, which the colony's spend book reads with their totals, and the decide
   * stage's reflex, second opinion and contest judge count theirs by proposal. GET /api/colonies/:id/intents/:iid/spend
   * prices one intent's calls; the snapshot and /metrics carry `intentSpend` for the Intents tab. Reads work without the
   * flag and show nothing for an intent nothing was counted for.
   */
  FT_INTENT_SPEND?: string;
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
   * Optional: module recipes, "on", or a comma-separated list of colony ids; absent or "off" is off. Built-in recipes
   * (rename-identifier, replace-import, text-replace: POST /api/colonies/:id/recipes, `ft recipe`) need no flag. Where
   * this covers a colony and the deployment has a Worker Loader (LOADER), a person may also declare a `module` recipe:
   * their own `transform(path, text)` module, which the trunk writer runs in a sealed Dynamic Worker (no network, no
   * bindings) twice per batch and lands only when both runs agree (trunk/reciperunner.ts). Module recipes are not applied
   * to changes in flight: a change stale through one goes back as before.
   */
  FT_RECIPE_MODULES?: string;
  /**
   * Optional: the goal-conflict check, "on", or a comma-separated list of colony ids; absent or "off" is off. In the
   * decide stage, a change that would undo lines a recent landing wrote for another intent (neither an ancestor nor a
   * descendant of its own; at least 3 lines and half of that landing's lines in the file) waits for a person instead of
   * landing, the reason naming the landing and its intent's why (decide/goalconflict.ts, core/goalconflict.ts). Recent:
   * the decide policy's goalConflictMinutes (60) and goalConflictLandings (200). The check fails open.
   */
  FT_GOAL_CONFLICT?: string;
  /**
   * Optional: quoted acceptance, "on", or a comma-separated list of colony ids; absent or "off" is off. For a change whose
   * intent carries an acceptance list (and was not written by trunk certification or the colony itself), the second
   * opinion answers each line as met, not met or unclear, and each "met" names a file and quotes a line of the diff it
   * was shown; the platform looks for each quote in the added and unchanged lines (decide/quotes.ts). Its approval counts
   * only when every line is met with a quote found there: a line not met returns the change naming it, an unclear one
   * sends it to a person. A line stating what must not be there ("No other file changes") has no line to quote: its met
   * counts on the model's word, and the record says so (basis). The acceptance list of the newest landing by another
   * intent on the files the change modifies is asked too, as keep lines: one not met returns the change naming it. The
   * decision and the lineage note keep each line with its verdict and quote.
   */
  FT_QUOTED_ACCEPTANCE?: string;
  /**
   * Optional: the contest jury, "on", or a comma-separated list of colony ids; absent or "off" is off. Where it covers a
   * colony, contest mode compares two tied changes with a jury of two or three small models from different families (the
   * decide policy's `juryModels`, outside the contestants' families) instead of one judge model: each member is asked in
   * both orders at once, within the judge's deadline; a member whose answers agree casts a vote, one whose answers flip
   * with the order, times out or answers nothing usable counts for nobody; the side with more votes wins, and a split or
   * no vote is a tie broken as today (decide/jury.ts). The verdict names each member's vote in the loser's reason and
   * the winner's `contest` check, so the lineage note and `ft why` show it; members' tokens count in the judge layer of
   * the colony's spend, per model, and `contest.jury.majority`, `contest.jury.ties`, `contest.jury.consistent` and
   * `contest.jury.inconsistent` count the verdicts and votes.
   */
  FT_CONTEST_JURY?: string;
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
   * Optional: the intent chain gate, "on", or a comma-separated list of colony ids; absent or "off" is off. An
   * agent-declared intent (MCP declare, Agent2Agent, POST /intents with source agent) whose ancestry, parent by parent,
   * holds as many agent-declared intents as the decide policy's intentChainDepth (2: the third agent-declared intent in
   * a row) is held for a person before any agent can take it: an open report of kind "chain" on the intent says who
   * declared it and from what, GET /escalations and the Review tab show it, take offers it to no agent, and a person's
   * dismiss releases it or withdraw ends it (colony/chain.ts). The same gate holds the intents one agent declares past
   * the policy's intentFanout (5) in an hour, however shallow, since each reaches another agent. Who declared an intent
   * (TakeResult.declaredBy: its source, the declarer and its model, the chain depth) is shown at every take, flag or no flag.
   */
  FT_INTENT_CHAIN_GATE?: string;
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
  /**
   * Optional: the Agent2Agent door for orchestrators, "on", or a comma-separated list of colony ids; absent or "off" is
   * off (404). A covered colony serves an agent card at GET /api/colonies/:id/.well-known/agent-card.json and JSON-RPC
   * at POST /api/colonies/:id/a2a (api/a2a.ts): SendMessage declares an intent and CancelTask withdraws one, both with
   * the admin token like POST /intents; GetTask and ListTasks follow intents as tasks to their landing commit, public
   * like every read.
   */
  FT_A2A?: string;
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
   * Optional: lesson scopes in the field guide's takes, "on", or a comma-separated list of colony ids; absent or "off" is
   * off. Every lesson keeps the files its change read and wrote with their blobs either way (colony/lessonscope.ts); where
   * this is on as well as FT_FIELD_GUIDE, a take ranks the lessons on its intent's footprint first, names the files of a
   * lesson's scope that landings changed since it was written (`movedSince`, with each landing and intent; prompts and the
   * MCP take say "Written before these files changed"), and leaves a lesson out once every file of its scope changed.
   */
  FT_LESSON_SCOPE?: string;
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
   * `bisect` event says so, and the open repair intent's why names it (certify/bisect.ts). When that landing holds several
   * proposals, the culprit is isolated inside it, with a revert probe that proves cause (certify/isolate.ts, at most 10 runs
   * and 60 s). Never on a landing's path.
   */
  FT_BISECT?: string;
  /**
   * Optional: tests before landing, "on", or a comma-separated list of colony ids; absent or "off" is off. Where it
   * covers a colony whose certification is on, a change that writes a path the certify policy's `prelandPaths` match
   * (every change when they are empty) has the test files that reach it (at most 5) run on its base with its files laid
   * over it, in the decide stage before the gate, in the sandbox certification uses (certify/preland.ts): a test that
   * passed on trunk and fails with the change sends it back to its agent; a time-out (2 s), a runner problem, no trunk
   * result to compare with or 3 runs already going in the colony let it go on as before, recorded as not checked.
   * Takes the decide path with review off too. Never inside the trunk writer's cycle; landing still validates read sets.
   */
  FT_PRELAND?: string;
}

export const WORKSPACE_SHARDS = 4;
