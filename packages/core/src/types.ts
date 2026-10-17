/**
 * FireTrident core contracts.
 *
 * Every package codes against these types. Change them only through the
 * orchestrator: a field added here ripples into the Worker, the UI, the CLI,
 * and the benchmark.
 */

export type Id = string;
/** A 40-character lowercase hex git object id. */
export type Sha = string;
/** A repository-relative POSIX path, no leading slash. */
export type Path = string;
/** Milliseconds since the Unix epoch. */
export type Millis = number;

// ---------------------------------------------------------------------------
// Repositories (Artifacts)
// ---------------------------------------------------------------------------

/** Address of one Artifacts repository. */
export interface RepoRef {
  namespace: string;
  name: string;
  /** Smart-HTTP remote returned by Artifacts. */
  remote: string;
}

/** A colony is one codebase: a trunk repo plus everything coordinating on it. */
export interface Colony {
  id: Id;
  name: string;
  trunk: RepoRef;
  /** Certified ref: the newest trunk commit whose own tests all passed (see Certification). */
  greenSha?: Sha;
  trunkSha: Sha;
  /** The latest trunk certification (served with the snapshot; absent before the first one). */
  certification?: Certification;
  /** Trunk publishing when it is asynchronous (served with the snapshot when FT_ASYNC_PUBLISH is on for the colony). */
  publish?: TrunkPublish;
  source?: { url: string; branch: string };
  createdAt: Millis;
  /** Directory depth that defines a region (1 = top-level directories). */
  regionDepth: number;
}

/**
 * Asynchronous trunk publishing (FT_ASYNC_PUBLISH): a landing counts once the trunk writer records it,
 * and a publish loop pushes the recorded commits to the trunk repository in order. `trunkSha` runs ahead
 * of `publishedSha` by the commits waiting to be pushed.
 */
export interface TrunkPublish {
  /** Whether publishing is asynchronous for this colony. */
  on: boolean;
  /** The newest commit on the trunk repository's main: leases start from it, `certified` and the lineage notes follow it. */
  publishedSha: Sha;
  /** The newest recorded trunk commit, unpublished ones included (lanes validate against it). */
  trunkSha: Sha;
  /** Landings recorded but not published yet (the publish queue). */
  unpublished: number;
  /** How long the oldest of them has waited, in ms (0 when none). */
  lagMs: number;
  /** A publish push is in flight. */
  running: boolean;
  /** Publish attempts that failed in a row, and the latest failure. */
  failures: number;
  lastError?: string;
  /** When a publish last succeeded. */
  publishedAt?: Millis;
}

// ---------------------------------------------------------------------------
// The field (stigmergy)
// ---------------------------------------------------------------------------

export type MarkKind = "claim" | "need" | "trail" | "failure" | "danger";

/**
 * A mark deposited on a path. Its value decays exponentially with the time
 * constant for its kind (see TAU_MS); `need` marks do not decay until removed.
 */
export interface Mark {
  id: Id;
  kind: MarkKind;
  path: Path;
  /** Deposit amplitude at time `at`. */
  strength: number;
  at: Millis;
  agentId?: Id;
  intentId?: Id;
}

/** Aggregated field values for one region at one instant. */
export interface FieldReading {
  region: string;
  at: Millis;
  totals: Record<MarkKind, number>;
  byPath: Record<Path, Partial<Record<MarkKind, number>>>;
  /**
   * Agents currently holding claims in the region. `at`: when the agent last made or renewed a claim here, only in a
   * reading asked for claim times (impact reads, colony/impact.ts).
   */
  agents: Array<{ agentId: Id; intentId?: Id; paths: Path[]; at?: Millis }>;
  /** Causal branching ratio of recent events (criticality governor). */
  sigma: number;
  /** Harvester-ant admission control: may new agents enter this region now? */
  admission: { open: boolean; landingsPerMin: number; activeAgents: number };
}

/** One trunk file a change reaches through imports (ImpactReport.files). */
export interface ImpactFile {
  path: Path;
  /** 0: a file asked about; 1 to 3: a file that imports one at the level before it (its `via`). */
  depth: number;
  /** The file it imports on the way to a file asked about (absent at depth 0). */
  via?: Path;
  /** Agents holding a live claim on it now (ImpactReport.claims has who they are). */
  claimedBy?: Id[];
}

/** An agent holding a live claim on files a change reaches (ImpactReport.claims), from the regions' fields. */
export interface ImpactClaim {
  agentId: Id;
  /** The agent as the colony keeps it: its name, kind and latest status note (agent-written text). */
  name?: string;
  kind?: AgentKind;
  note?: string;
  /** The intent the claim is for: its title, its status, and since when it has had that status. */
  intentId?: Id;
  title?: string;
  status?: IntentStatus;
  since?: Millis;
  /** The reached files the claim covers, nearest first; `morePaths` counts the rest. */
  paths: Path[];
  morePaths?: number;
  /**
   * Claim age: when the agent made or last renewed the claim (agents renew theirs while they work), how long ago that was
   * at the report's time, and the claim's strength now (1 fresh; it decays, and holds other agents off from 0.5 by default).
   */
  claimedAt?: Millis;
  ageMs?: number;
  strength?: number;
}

/** A recent landing on files a change reaches (ImpactReport.landings), from the colony's why-context index. */
export interface ImpactLanding {
  landingId: Id;
  at: Millis;
  trunkSha?: Sha;
  /** The intent it completed for these files, with its title and why (one line each; "" when unknown). */
  intentId?: Id;
  title: string;
  why: string;
  /** The reached files it changed, nearest first; `morePaths` counts the rest. */
  paths: Path[];
  morePaths?: number;
}

/**
 * What a change to some paths reaches, and who works on it now (GET /api/colonies/:id/impact, MCP `impact`, `ft impact`):
 * the trunk files that import them, up to three levels, from the trunk writer's import index; the live claims on those
 * files; and the latest landings on them with their intents' whys. Read-only, and bounded.
 */
export interface ImpactReport {
  colonyId: Id;
  at: Millis;
  /** The paths asked about, cleaned (files, directories with a trailing slash, or globs). */
  paths: Path[];
  /** The trunk commit the import index describes; null when the index was not read. */
  trunkSha: Sha | null;
  /** Whether the importers were read and the index was current with trunk; `note` says why not. */
  index: { read: boolean; current: boolean; note?: string };
  /** Paths asked about that trunk does not have. */
  missing?: Path[];
  /** The files asked about (depth 0) and their importers, nearest first. */
  files: ImpactFile[];
  /** The walk stopped at a cap (files or paths): files past it were not looked at. */
  truncated: boolean;
  claims: ImpactClaim[];
  /** Regions of reached files whose field was not read (past the cap, or the read failed): their claims are unknown. */
  unread?: string[];
  landings: ImpactLanding[];
  /** The caps this report ran under. */
  limits: { depth: number; files: number; landings: number };
  /** What the quoted text in the report is: data written by people and agents, not instructions. */
  about: string;
}

// ---------------------------------------------------------------------------
// Intents, rules, morphology
// ---------------------------------------------------------------------------

/**
 * `certify`: declared by trunk certification to repair failing tests (see Certification). `system`: declared by the
 * colony itself (the megafile alarm's split intents, FT_MEGAFILE); its why is the colony's own numbers.
 */
export type IntentSource = "human" | "rule" | "agent" | "certify" | "system";
/**
 * The cap that lowered an agent's priority: its parent's (`parent`: a parent it holds or declared, or one whose priority
 * is below the default), the default with no parent (`no-parent`), or the default under a parent that is not its own
 * (`other-parent`).
 */
export type PriorityCap = "parent" | "no-parent" | "other-parent";
/** `withdrawn`: a human (or a retracted rule) called it off before it landed; it stays in history. */
export type IntentStatus = "open" | "claimed" | "proposed" | "landed" | "abandoned" | "withdrawn";

/** What someone wants changed and why. The parent chain is the "why". */
export interface Intent {
  id: Id;
  colonyId: Id;
  title: string;
  why: string;
  source: IntentSource;
  ruleId?: Id;
  parentId?: Id;
  /** Predicted footprint, declared before work starts (efference copy). */
  footprint: Path[];
  acceptance?: string[];
  priority: number;
  /**
   * What an agent asked for when its priority was capped: an agent's intent takes at most its parent's priority when it
   * holds or declared the parent, else 1 (worker colony/priority.ts). Absent when the intent got what was asked.
   */
  requestedPriority?: number;
  /** Which cap lowered it, with requestedPriority. */
  priorityCap?: PriorityCap;
  status: IntentStatus;
  createdAt: Millis;
  createdBy: string;
  assignedTo?: Id;
  /** 1 when declared, +1 on every amendment (see IntentRevision). Absent means 1. */
  revision?: number;
  /** Why it was withdrawn (status "withdrawn"). */
  withdrawnReason?: string;
  /**
   * Contest mode: how many agents may hold this intent at once (2 to 4). Each builds its own change and
   * the colony lands one of them; the others are kept as alternatives in the winner's lineage. Absent or 1:
   * one holder, as usual.
   */
  contest?: number;
  /**
   * An agent reported that the intent cannot be done as written. While unresolved, no agent takes the
   * intent; a person resolves it (amend, withdraw or dismiss).
   */
  escalation?: IntentEscalation;
  /**
   * The closure ledger (worker colony/closure.ts): why the intent last closed or reopened while an agent held it, with
   * that agent and how long it had been silent. Absent for an intent no agent has let go of since the ledger began.
   */
  closure?: IntentClosure;
}

/**
 * What an agent can report instead of working around it. "chain" is never an agent's report: it is the colony's own
 * hold on an agent-declared intent whose ancestry holds as many agent-declared intents as the decide policy's
 * intentChainDepth (FT_INTENT_CHAIN_GATE, worker colony/chain.ts), kept as an open report so a person's answer releases it.
 */
export type EscalationKind = "broken-test" | "contradictory-spec" | "impossible" | "other" | "chain";

/** An agent's report that an intent cannot be done as written, and a person's answer. */
export interface IntentEscalation {
  kind: EscalationKind;
  /** The agent's report, in its own words (untrusted text). */
  report: string;
  /** The agent that reported it. */
  by: Id;
  at: Millis;
  /** The person's answer; absent while the intent waits for one. */
  resolved?: { by: string; at: Millis; decision: "amend" | "withdraw" | "dismiss"; note: string };
}

/**
 * Why an intent an agent held closed or reopened (the closure ledger, worker colony/closure.ts): `landed` (its change
 * landed), `released` (the agent gave it back), `escalated` (the agent reported it to a person), `withdrawn` (a person
 * or a change of direction called it off), `gave_up` (an in-platform agent's loop gave up on it), `reaped_silent` (the
 * agent was silent past the colony's limit and the colony took it back), `returned` (review or a person sent its change
 * back, or rejected it) and `stopped` (a person stopped the agent, or the colony was deleted).
 */
export type ClosureCause = "landed" | "released" | "escalated" | "withdrawn" | "gave_up" | "reaped_silent" | "returned" | "stopped";

/** One close or reopen of an intent an agent held, as the closure ledger keeps it. */
export interface IntentClosure {
  cause: ClosureCause;
  at: Millis;
  /** What the intent became: open (reopened for the next taker), landed or withdrawn. */
  status: IntentStatus;
  /** The agent that held it, and its kind. */
  agentId?: Id;
  agentKind?: AgentKind;
  /**
   * How long the agent had been silent when it closed or reopened: from its last sign of life the colony recorded (a
   * heartbeat or a call) to then. 0 when the agent's own call closed it (released, escalated, gave_up).
   */
  gapMs?: number;
}

/** One agent kind's closures in the ledger: how many, and per cause the count and its share of them. */
export interface ClosureKindShare {
  total: number;
  counts: Partial<Record<ClosureCause, number>>;
  shares: Partial<Record<ClosureCause, number>>;
}

/** The closure ledger in the colony's metrics report (GET /api/colonies/:id/metrics). */
export interface ClosureReport {
  /** Closures counted since the ledger began in this colony. */
  total: number;
  /** Per agent kind (internal: in-platform, external: MCP and API agents, synthetic). */
  byKind: Partial<Record<AgentKind, ClosureKindShare>>;
  /** Intents the colony took back from silent agents: how many, and how long those agents had been silent. */
  reaped: { count: number; medianGapMs: number | null; maxGapMs: number | null };
  /** The colony's silent-agent limit now (an agent outside the platform silent this long loses its intents), and whether it is the default. */
  silentTtlMs: number;
  silentTtlDefault: boolean;
}

/** Intent fields an amendment may change. */
export type IntentField = "title" | "why" | "footprint" | "priority";

/** One amendment of an intent: what changed, from what to what, why, and who asked. */
export interface IntentRevision {
  intentId: Id;
  /** The revision this amendment produced (2 for the first amendment). */
  revision: number;
  changed: IntentField[];
  before: Partial<Pick<Intent, IntentField>>;
  after: Partial<Pick<Intent, IntentField>>;
  reason: string;
  by: string;
  at: Millis;
  /**
   * True when work in progress no longer fits (title, why or footprint changed): changes built on an
   * older revision are sent back. A priority-only amendment only moves the intent in the queue.
   */
  substantive: boolean;
}

/**
 * Directives change an agent's course. `guidance` is free text from a human; `revision` and
 * `withdrawal` are the colony telling the agent that the intent it holds was amended or called off.
 * `resolution`: the conflict resolver (FT_RESOLVER) telling the agent whose change came back with
 * overlapping hunks that the platform is merging it, and then how that ended (inbox only, never pushed).
 */
export type DirectiveKind = "guidance" | "revision" | "withdrawal" | "landing" | "resolution";

/**
 * A landing notice: files an agent read or holds changed on trunk while it worked. Facts it can check
 * (paths, blobs, the landing and its intent), never instructions.
 */
export interface LandingNotice {
  landingId: Id;
  trunkSha: Sha;
  paths: Array<{ path: Path; before: Sha | null; after: Sha | null }>;
  /** The intent the landing completed, and its why. */
  intentTitle: string;
  why: string;
}

/** A change of direction for one agent. In-platform agents get it pushed; external agents read it in their inbox. */
export interface Directive {
  id: Id;
  colonyId: Id;
  agentId: Id;
  kind: DirectiveKind;
  /** The intent it is about (guidance defaults to the intent the agent holds when it is sent). */
  intentId?: Id;
  /** The guidance, or the reason for the revision or withdrawal. */
  message: string;
  by: string;
  at: Millis;
  /** Revision notices: the intent's new revision and what changed. */
  revision?: number;
  changed?: IntentField[];
  /** When and how it reached the agent: pushed to an in-platform agent, or read from the inbox. */
  deliveredAt?: Millis;
  via?: "push" | "inbox";
  /** Landing notices: what landed (kind "landing"). */
  landing?: LandingNotice;
}

/**
 * A directive as an agent's inbox lists it, beside its proposals. `id`, `intentId`, `status`,
 * `reason` (what to do) and `createdAt` line up with a proposal entry, so inbox readers that only
 * know proposals still show it.
 */
export interface InboxDirective {
  kind: "directive";
  id: Id;
  /** "" when the directive names no intent. */
  intentId: Id;
  agentId: Id;
  status: "directive";
  reason: string;
  createdAt: Millis;
  headSha: "";
  directive: Directive;
}

/** The direction a change was built under, recorded in its evidence and so in the lineage note. */
export interface Direction {
  /** The intent revision the change was built on. */
  intentRevision: number;
  /** The intent's amendments up to that revision, oldest first. */
  revisions?: Array<Pick<IntentRevision, "revision" | "changed" | "reason" | "by" | "at">>;
  /** Human guidance the agent had received for this intent when it proposed. */
  directives?: Array<Pick<Directive, "id" | "message" | "by" | "at">>;
  /** The agent's last status note before it proposed. */
  note?: string;
}

export type RuleKind = "forbid-pattern" | "forbid-import";

/**
 * One declared architecture rule. Violations become `need` marks and intents.
 * - forbid-pattern: spec { pattern: string (RegExp source), flags?: string, include?: string[] (globs), exclude?: string[], hint: string, replacement?: string (deterministic fix for synthetic agents) }
 * - forbid-import:  spec { from: string[] (globs of importing files), module: string (RegExp source of forbidden specifier), hint: string }
 */
export interface Rule {
  id: Id;
  colonyId: Id;
  kind: RuleKind;
  spec: Record<string, unknown>;
  description: string;
  approvedBy: string;
  createdAt: Millis;
  /** Set when the rule was retracted: it stays in history, its unlanded intents are withdrawn. */
  retractedAt?: Millis;
  retractedBy?: string;
  retractReason?: string;
}

export interface Violation {
  ruleId: Id;
  path: Path;
  line: number;
  excerpt: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Agents and workspaces
// ---------------------------------------------------------------------------

export type AgentKind = "internal" | "external" | "synthetic";
export type AgentState = "idle" | "working" | "proposing" | "waiting" | "dead";

export interface AgentInfo {
  id: Id;
  colonyId: Id;
  kind: AgentKind;
  name: string;
  model?: string;
  /** Response threshold per region (lower = more eager). */
  thresholds: Record<string, number>;
  state: AgentState;
  intentId?: Id;
  workspace?: WorkspaceLease;
  lastSeen: Millis;
  /** The agent's own one-line "what I am doing now" (relayed by the agent), and when it said it. */
  note?: string;
  noteAt?: Millis;
}

/**
 * An Artifacts fork leased to one agent. Tokens are short-lived. The agent clones
 * trunk at `baseSha` with the read-only trunk token, commits, and force-pushes its
 * commit to its own workspace (`repo`) with the workspace write token. Agents never
 * hold a trunk write token.
 */
export interface WorkspaceLease {
  repo: RepoRef;
  token: string;
  tokenExpiresAt: Millis;
  baseSha: Sha;
  leasedAt: Millis;
  trunk: { remote: string; token: string; sha: Sha };
}

// ---------------------------------------------------------------------------
// Proposals, landing, lineage
// ---------------------------------------------------------------------------

/** A path and the blob it held. `blob: null` means absent or deleted. */
export interface FileVersion {
  path: Path;
  blob: Sha | null;
}

export type ProposalStatus =
  | "pending" // received, not yet checked
  | "checking" // innate checks running
  | "ready" // waiting in a lane
  | "landed"
  | "returned" // stale read or conflict: sent back to its agent with the delta
  | "rejected"
  | "escalated"; // waiting for a human

export interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
  /**
   * `agent`: the check came with the proposal (the colony marks each one it is sent), so it is the agent's own claim.
   * Absent: a check FireTrident or a model ran, known by its name (core/answerable.ts checkSpeaker).
   */
  by?: "agent";
  /**
   * The gate check only (worker decide/ruleline.ts): the rule that decided, the colony's preset then, and the values the
   * rule used, each with the policy bound it met. Absent on other checks and on notes written before it was kept.
   */
  gate?: GateRecord;
}

/** One value a gate rule used, with the policy bound it was held to when it has one ("confidence 0.93 ≥ 0.85"). */
export interface GateValue {
  /** What it is, as a reader names it: "confidence", "p(needs_human)", "approved landings", "model", ... */
  name: string;
  value: number | string | boolean;
  /** How the value met the bound. Absent when the value has no bound (a model name, a count). */
  op?: "≥" | ">" | "<" | "≤" | "=";
  bound?: number;
}

/**
 * What the gate check keeps of its decision (core/decides.ts reads it): the rule ("R3 innate+autonomy"), the preset the
 * colony's policy equalled when it decided ("production", or "custom"; worker decide/presets.ts), and the rule's values.
 */
export interface GateRecord {
  rule: string;
  preset: string;
  values: GateValue[];
}

/**
 * Tests before landing (FT_PRELAND): the test files a change reaches, run on its base with its files laid over it, in the
 * sandbox trunk certification uses, before the change went on. `failed`: a test that passed on trunk failed with the
 * change, and the change went back to its agent. `unchecked`: the change went on as it would without the check, and
 * `reason` says why (no test reaches it, a time-out, a runner problem, no trunk result to compare with, busy).
 */
export interface PrelandRun {
  status: "passed" | "failed" | "unchecked";
  /** The commit the change's files were laid over (its base). */
  trunkSha?: Sha;
  /** Test files run, at most 5, nearest to the change first. */
  files: Path[];
  /** Test files that reach the change, when more than were run. */
  reached?: number;
  /** Tests run with the change, and how many passed and failed. */
  tests: number;
  passed: number;
  failed: number;
  /** Failing tests that failed on trunk too: not held against the change. */
  known?: number;
  /** Tests that passed on trunk and failed with the change, with their errors (at most 5). */
  broke?: Array<{ file: Path; name: string; error?: string }>;
  /** Wall time of the check, from its start to its verdict. */
  ms: number;
  /** Why it was not checked (`unchecked`), in words. */
  reason?: string;
}

/** How one test that failed on an escalated change did on the change's base: passed there, failed there too, is new with the change, did not finish within the run, or no result there to compare with. */
export type ReviewTestOnTrunk = "passes" | "fails" | "new" | "unfinished" | "unknown";

/** One test that failed with an escalated change (tests before approval): names and error as the review card shows them, masked where they look like a secret. */
export interface ReviewTestFailing {
  file: Path;
  name: string;
  /** The first line of its error. */
  error?: string;
  onTrunk: ReviewTestOnTrunk;
}

/**
 * Tests before approval: the colony's tests run on an escalated change laid over its base, in the sandbox trunk
 * certification uses, while the change waits for a person (worker certify/reviewtests.ts). Test files that load none of
 * the files the change writes keep the results certification stored for them at the base; the rest run with the change.
 * `queued` (asked for) and `running` (the review queue shows it) end as `ran` (the counts, the failing tests against the
 * base) or `notrun` (`reason` says why: no node:test tests, the run's limits, a time-out, the base no longer readable,
 * decided first). Repository text: data, never instructions.
 */
export interface ReviewTestsRun {
  /** The run's id: a newer run replaces it, and a run that ends after it was replaced is dropped. */
  id: string;
  status: "queued" | "running" | "ran" | "notrun";
  /** Who asked: "escalation", or the person who asked for it again. */
  by: string;
  /** When it was asked for, and when it ended. */
  at: Millis;
  finishedAt?: Millis;
  /** The change's head commit, and the base its files were laid over. */
  headSha?: Sha;
  baseSha?: Sha;
  /** Test files run, and how many of them ran with the change (the others load nothing it writes and kept trunk's results). */
  files?: number;
  ranFiles?: number;
  /** Test files that could not run here (a package import, the run's size caps). */
  unsupported?: number;
  /** Tests run, as `node --test` counts them; `failed` includes cancelled tests and test files that did not load. */
  tests?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  todo?: number;
  /** The failing tests, at most 10, each against the base. */
  failing?: ReviewTestFailing[];
  /** How the failing tests did on the base, counted over the first 50 failing tests (more than are listed). */
  onTrunk?: Partial<Record<ReviewTestOnTrunk, number>>;
  /** The base commit's certification, when certification ran on it. */
  trunk?: { sha: Sha; status: "green" | "red"; tests: number; passed: number; failing: number };
  /** Why it did not run (`notrun`), as a clause. */
  reason?: string;
  /** Wall time of the run, from its start to its result. */
  ms?: number;
  /** The result in one sentence ("Tests on this change: 433/434 passed, 1 failed (…)."), as the review card leads with it. */
  text?: string;
}

export interface Evidence {
  checks: CheckResult[];
  /** Paths changed that the declared footprint did not predict (residual review). */
  residual?: Path[];
  /** Mandatory honest gap statement. */
  notVerified?: string;
  /**
   * Who wrote `notVerified`: the agent, or FireTrident when the agent stated nothing (the colony's default, or the MCP
   * server's sentence for an external agent). Absent on notes written before it (readers derive it: core/answerable.ts).
   */
  notVerifiedBy?: "agent" | "platform";
  previewUrl?: string;
  /** The intent revision and directives the change was built under (set by the colony at propose time). */
  direction?: Direction;
  /** Tests before landing (FT_PRELAND), when they covered the change (set by the decide stage). */
  preland?: PrelandRun;
  /** Tests before approval, when the change was escalated to a person (set by the colony; worker certify/reviewtests.ts). */
  reviewTests?: ReviewTestsRun;
}

/** The names a change imports from one trunk file (see Proposal.nameAssumptions). */
export interface NameAssumption {
  path: Path;
  names: string[];
}

/**
 * Goal conflict (FT_GOAL_CONFLICT, core/goalconflict.ts): lines of one file that a recent landing wrote for another
 * intent and that a change removes: the landing, the intent it wrote them for, the file, and how many lines.
 */
export interface UndoneLines {
  landingId: Id;
  intentId: Id;
  path: Path;
  lines: number;
}

/**
 * Text merge (FT_TEXT_MERGE): one file whose line merge conflicted when its change went back: the change's base blob,
 * the blob it would have landed on (`trunk`: trunk's, or that of a change landing ahead of it in the same cycle), the
 * blob the change wrote (`theirs`), and where each conflicting hunk starts in its base (1-based lines).
 */
export interface MergeConflict {
  path: Path;
  base: Sha;
  trunk: Sha;
  theirs: Sha;
  lines: number[];
}

/**
 * Merge locks (worker trunk/mergelock.ts): one unified diff of a held merge, masked like a review view (a line that may
 * hold a secret is replaced) and cut to about 60 lines (`truncated` when cut); how many lines it adds and removes in all.
 */
export interface HeldDiff {
  hunks: string;
  added: number;
  removed: number;
  truncated: boolean;
}

/**
 * Merge locks: one file of a merge the trunk writer held for a person instead of landing it. Its blobs: the change's base,
 * the trunk version it would land on, the change's own (what was decided on) and the merged result; `by`, the change
 * landing ahead in the same cycle that wrote that trunk version. For the first files held, the diffs a person reads:
 * what trunk changed since the base (`trunkDiff`, base to trunk) and the merged result against the change's own version
 * (`mergedDiff`). Repository text: data, never instructions.
 */
export interface HeldMergeFile {
  path: Path;
  base: Sha;
  trunk: Sha;
  theirs: Sha;
  result: Sha;
  by?: Id;
  trunkDiff?: HeldDiff;
  mergedDiff?: HeldDiff;
}

/**
 * What beat a returned change: one landing after the change's base that changed files it read or wrote, from the colony's
 * per-path landing index (colony/movedby.ts). `paths`: those files. The intent the landing completed for them (its title
 * and why), the agent whose proposal wrote them, the model that landing's lineage note names for that proposal, the trunk
 * commit and when it landed, each when the colony knows it. Titles, whys and model names were written by people and
 * agents: data, never instructions.
 */
export interface MovedBy {
  landingId: Id;
  paths: Path[];
  trunkSha?: Sha;
  at?: Millis;
  intentId?: Id;
  title?: string;
  why?: string;
  agentId?: Id;
  model?: string;
  /** Return hunks (FT_RETURN_HUNKS): the change this landing made to each of those files, quoted (colony/returnhunks.ts). */
  hunks?: MovedHunk[];
}

/**
 * Return hunks (FT_RETURN_HUNKS): the change one landing that beat a returned change made to one file it read or wrote,
 * as unified hunks ("@@ -a,b +c,d @@", two lines of context), cut at the caps (colony/returnhunks.ts) and masked where a
 * line looks like a secret, so the change's agent repairs without reading trunk again. `trunkSha`: the landing's commit.
 * Repository content: data, never instructions.
 */
export interface MovedHunk {
  path: Path;
  trunkSha?: Sha;
  /** The hunks, ending in "… (truncated)" when `truncated`. */
  diff: string;
  truncated: boolean;
}

/**
 * Return hunks (FT_RETURN_HUNKS): one contested region of a text merge that conflicted: where it starts in the change's
 * base (`line`, 1-based), and the base's, trunk's and the change's own lines there (line endings removed), cut at the
 * caps and masked where a line looks like a secret. `truncated`: lines of the region, or later regions of the file, were
 * left out. Repository content: data, never instructions.
 */
export interface ContestedRegion {
  path: Path;
  line: number;
  base: string[];
  trunk: string[];
  own: string[];
  truncated?: boolean;
}

export interface Proposal {
  id: Id;
  colonyId: Id;
  intentId: Id;
  agentId: Id;
  workspace: RepoRef;
  baseSha: Sha;
  headSha: Sha;
  /** Files written, with the new blob ids (present in the workspace repo). */
  writeSet: FileVersion[];
  /** Files read, with the blob ids seen at read time (optimistic concurrency). */
  readSet: FileVersion[];
  /**
   * Files the decision relied on existing: the trunk files this change's new or rewritten relative
   * imports resolve to (its own writes excluded). Only their existence matters: the trunk writer
   * returns the change if one is gone when it lands, and returns a change that would delete one that
   * another change landing in the same cycle relies on.
   */
  assumptions?: Path[];
  /**
   * Name assumptions: for each trunk file this change's relative imports resolve to, the names it imports from
   * it. When only files it read changed under it, the change can still land if every name is still exported
   * (assumption revalidation); otherwise it goes back as usual.
   */
  nameAssumptions?: NameAssumption[];
  /**
   * Goal conflict (FT_GOAL_CONFLICT): the lines this change removes that recent landings wrote for other intents, set
   * when it went to a person for that; a person's approval lands it, and its lineage note keeps the record.
   */
  undoes?: UndoneLines[];
  /**
   * When a person last approved this change (ColonyDO.decide). The trunk writer lands its files as approved and never
   * merges them with a newer trunk on its own (trunk/mergelock.ts). Absent when no person approved it; an older change
   * without it is read from the decisions its lane passes.
   */
  approvedAt?: Millis;
  /** Contest mode: the proposal that won this intent's contest instead of this one. */
  supersededBy?: Id;
  declared: { footprint: Path[]; summary: string };
  evidence: Evidence;
  status: ProposalStatus;
  createdAt: Millis;
  landingId?: Id;
  /** Why it was returned/rejected, including the exact stale paths. */
  reason?: string;
  /**
   * Text merge: the files whose line merge conflicted, when that is why it went back (set by the trunk writer only while
   * the conflict resolver, FT_RESOLVER, or return hunks, FT_RETURN_HUNKS, cover the colony; colony/resolver.ts reads them
   * only under FT_RESOLVER).
   */
  mergeConflicts?: MergeConflict[];
  /**
   * Merge locks: the merge the trunk writer held for a person instead of landing it (each file with its blobs and diffs),
   * while the change waits for that person; a person's approval clears it.
   */
  mergeHold?: HeldMergeFile[];
  /**
   * What beat it: when it went back because trunk moved files it read or wrote (stale, or a text merge conflict), the
   * landings that moved them, newest first. Set by the colony as the return arrives (colony/movedby.ts); its reason then
   * ends by naming them and saying to keep what they did unless the intent says otherwise.
   */
  movedBy?: MovedBy[];
  /**
   * Return hunks (FT_RETURN_HUNKS): when a text merge conflict sent it back, each contested region, quoted (base, trunk
   * and its own lines, from the base line where the region starts). Set by the colony as the return arrives.
   */
  contested?: ContestedRegion[];
  /**
   * The intent revision the change was built on. An agent passes the revision it worked from; the
   * colony refuses a proposal built on an older substantive revision, and the lane returns one before
   * landing if the intent was revised meanwhile.
   */
  intentRevision?: number;
  /**
   * An inline change (core/changeset.ts): the text of every file it writes, keyed by git blob id, so the
   * trunk writer builds it without reading the agent's workspace. Its headSha is then its changesetId.
   */
  contents?: Record<Sha, string>;
}

/** One trunk commit produced by a lane cycle. */
export interface Landing {
  id: Id;
  colonyId: Id;
  trunkSha: Sha;
  parentSha: Sha;
  proposalIds: Id[];
  intentIds: Id[];
  paths: Path[];
  regions: string[];
  at: Millis;
  /**
   * Text merge (FT_TEXT_MERGE): files a proposal of this landing wrote on an older version, merged line by line with the
   * version they landed on, each with the blob that landed in place of the one the proposal wrote. Absent when none was.
   * `rule`: the rule beyond git's that resolved its conflicting hunks (FT_MERGE_INSERTIONS: `insertions`), when one did.
   */
  merged?: Array<{ proposalId: Id; path: Path; blob: Sha; rule?: "insertions" }>;
  /** Who answers for this landing, from its lineage note as the trunk writer wrote it (see LandingAnswer); absent on landings recorded before it. */
  answerable?: LandingAnswer;
}

/**
 * Who answers for a landing, from its lineage note (core/answerable.ts landingAnswerable): `person` a person answers for
 * every change in it (one who approved it, approved the rule whose proof landed it, or asked for its intent), `none` no
 * person answers for one of its changes, `unknown` the note cannot say for one (it lacks who declared the intent).
 */
export type LandingAnswer = "person" | "none" | "unknown";

/**
 * A change in flight that landed although a person withdrew or amended its intent: the trunk writer's
 * cycle had read the old direction (its commit point) before the change of direction reached it.
 */
export interface LandedChange {
  proposalId: Id;
  landingId: Id;
  trunkSha: Sha;
}

/**
 * What became of the changes in flight when a person withdrew or amended intents, or retracted a rule:
 * `returned` were stopped and never land; `landed` had already landed (ft revert undoes a landing); when
 * `confirmed` is false the trunk writer did not answer for `unconfirmed`, which may still land.
 */
export interface RedirectOutcome {
  returned: number;
  landed: LandedChange[];
  confirmed: boolean;
  unconfirmed?: Id[];
}

/** One decide-arc decision as a lineage note records it (the optional fields are compact context). */
export interface NoteDecision extends Pick<Decision, "kind" | "layer" | "p" | "action"> {
  at?: Millis;
  /** What the layer was asked: the reflex questions, the second opinion, the human review. */
  question?: string;
  /** The model that answered, or the human who decided. */
  by?: string;
  /** The answer in one line: the reflex probabilities, the reviewer's reason, the human's reason. */
  answer?: string;
  /** The second opinion's answer for each acceptance line, its quote checked by the platform (FT_QUOTED_ACCEPTANCE); absent elsewhere. */
  acceptance?: NoteAcceptance[];
}

/** What counts for one acceptance line: met (with a quote the platform found, or on the model's word for an absence), not met, or unclear. */
export type AcceptanceVerdict = "met" | "not met" | "unclear";

/**
 * What a "met" rests on: `quote` when the platform found the model's quote in the diff it showed, `absence` when the
 * line states what must not be there ("No other file changes"), so there is no changed line to quote and the met rests
 * on the model's word (decide/quotes.ts isAbsence).
 */
export type AcceptanceBasis = "quote" | "absence";

/**
 * One acceptance line as the second opinion answered it, and what the platform counts (FT_QUOTED_ACCEPTANCE,
 * decide/quotes.ts). `intent`: a line of the change's own intent; `keep`: a line of the intent of the newest landing by
 * another intent on the files the change modifies, which the change must not break.
 */
export interface NoteAcceptance {
  kind: "intent" | "keep";
  /** The line as its intent states it. */
  line: string;
  /**
   * What the platform counts: `met` only when the model answered met and named a file and a quote of at least 8
   * characters that the platform found in the added or unchanged lines of the diff the model was shown, or, for a line
   * stating an absence, answered met at all (`basis` says which).
   */
  verdict: AcceptanceVerdict;
  /** What a `met` rests on: a quote the platform found, or the model's word for a line stating an absence. Absent on other verdicts and on records written before it. */
  basis?: AcceptanceBasis;
  /** The model's own answer, when the platform counts another (a "met" whose quote it could not find). */
  said?: AcceptanceVerdict;
  /** The file the model named for it. */
  path?: Path;
  /** The line the model quoted, whitespace collapsed. */
  quote?: string;
  /** Why a "met" was not counted, in words. */
  problem?: string;
  /** Keep lines: the landing whose intent's acceptance list this line comes from. */
  landingId?: Id;
}

/**
 * Who wrote a landed change, as the platform knows it: `platform` for an in-platform agent (FireTrident's own agent
 * object ran the loop), `external` for an agent that joined over MCP or the API, `synthetic` for a bench agent.
 */
export type ProvenanceAuthor = "platform" | "external" | "synthetic";

/**
 * What authenticated an agent's calls, as far as the colony knows: `platform` (FireTrident's own agent object, no outside
 * credential), `mcp` (the deployment's MCP token, bound to this agent by its MCP session or its per-agent resume key),
 * `token` (a deployment token only, the MCP token or the operator's API token, neither bound to this agent).
 */
export type ProvenanceAuth = "platform" | "mcp" | "token";

/** How a note knows a change's model: `observed` when FireTrident made the model calls itself, `declared` when the agent named the model. */
export type ModelEvidence = "observed" | "declared";

/** Model calls FireTrident made for a change and counted as they returned (in-platform agents), per model. */
export interface ObservedModel {
  model: string;
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

/**
 * How a landed change's author and model are known. The trunk writer computes it from the colony's record of the agent,
 * never from the proposal's claims about itself; notes written before it have none, and readers treat unknown values
 * as unknown. `model` is absent when the model is not known.
 */
export interface NoteProvenance {
  author: ProvenanceAuthor;
  /** Absent when the colony did not say. */
  auth?: ProvenanceAuth;
  model?: {
    evidence: ModelEvidence;
    /** The model named on the agent's record: assigned by FireTrident for in-platform agents; otherwise given by the agent when it joined, or failing that in its proposal. */
    name?: string;
    /** `observed` only: the models FireTrident called for this change, with the calls and tokens counted. */
    observed?: ObservedModel[];
  };
}

/**
 * A change the platform's conflict resolver wrote (FT_RESOLVER): the proposal that came back with overlapping hunks, the
 * landings that changed those files after its base (the other side), and the files it merged. From the colony's record of
 * the resolution, never from the proposal.
 */
export interface NoteResolves {
  proposalId: Id;
  landingIds: Id[];
  paths: Path[];
}

/** The JSON stored under refs/notes/firetrident for each landed commit. */
export interface LineageNote {
  schema: "firetrident.lineage/v1";
  landingId: Id;
  colonyId: Id;
  proposals: Array<{
    id: Id;
    agentId: Id;
    agentKind: AgentKind;
    model?: string;
    /**
     * `priority` and `requestedPriority` only when an agent asked for more than its intent was granted (worker colony/priority.ts).
     * `source` and `createdBy`: who declared the intent, as the colony recorded it; `ruleApprovedBy`: for a rule's intent,
     * who approved the rule. The trunk writer adds them from the land context (absent on older notes, and when the writer
     * did not know them); they name the nearest person answerable for the change (core/answerable.ts).
     */
    intent: { id: Id; title: string; why: string; ruleId?: Id; parentId?: Id; priority?: number; requestedPriority?: number; source?: IntentSource; createdBy?: string; ruleApprovedBy?: string };
    writeSet: FileVersion[];
    readSet: FileVersion[];
    decisions: NoteDecision[];
    /** Includes `direction` (intent revision, directives, status note) for changes built under one. */
    evidence: Evidence;
    /** Contest mode: the other attempts at the same intent, and why each lost. */
    alternatives?: Array<{ proposalId: Id; agentId: Id; model?: string; reason: string }>;
    /** Import-name revalidation: files that changed after this change read them, the names it relies on that still held, and (notes written since the growth check) that each only grew. */
    revalidated?: Array<{ path: Path; read: Sha | null; landedOn: Sha | null; names: string[]; grew?: true }>;
    /** How the author and model are known (computed by the trunk writer; absent on older notes). */
    provenance?: NoteProvenance;
    /**
     * Text merge: files this change wrote on a version that had changed by the time it landed, merged line by line: its
     * base blob, the blob it landed on (`trunk`: trunk's, or a change's landing ahead in the same cycle), the blob it
     * wrote (`theirs`) and the result, which its `writeSet` names. `rule`: `insertions` when both sides only inserted lines
     * at the same place and their union landed (FT_MERGE_INSERTIONS), where git's rules call it a conflict.
     */
    merged?: Array<{ path: Path; base: Sha; trunk: Sha; theirs: Sha; result: Sha; rule?: "insertions" }>;
    /** Goal conflict: lines recent landings wrote for other intents that this change undid, which a person approved. */
    undoes?: UndoneLines[];
    /** Conflict resolver: the returned change this one resolves, the landings it merged with, and the files (see NoteResolves). */
    resolves?: NoteResolves;
  }>;
  /** The project's own tests on this commit, when trunk certification ran on it (added after landing). */
  certification?: NoteCertification;
}

/**
 * One landing's lineage note on the trunk repository against the FT-Note trailer of its commit (the sha256 of the note as
 * the trunk writer wrote it, without `certification`): `intact` (they match), `altered` (they do not, or the note is not
 * in the form the trunk writer writes), `missing` (no note for the commit), `pending` (the note is not pushed yet),
 * `no-trailer` (the commit predates the trailer), `unreadable` (the commit or the note could not be read).
 */
export type NoteCheckStatus = "intact" | "altered" | "missing" | "pending" | "no-trailer" | "unreadable";

/**
 * A landing commit's FT-Note-Signature trailer (signed lineage notes, FT_NOTE_KEY) against the trunk writer's published
 * key: `signed` (the signature over the commit's note digest, tree and parent verifies), `bad-signature` (it does not,
 * it names a key that is not published, or it is not in the form the trunk writer writes), `unsigned` (the commit carries
 * none: it landed before signing).
 */
export type NoteSignatureStatus = "signed" | "bad-signature" | "unsigned";

/** The signature check of one landing commit. */
export interface NoteSignatureCheck {
  status: NoteSignatureStatus;
  /** The key the signature names (16 hex digits of the SHA-256 of the raw public key). */
  keyId?: string;
  /** `bad-signature`: why, in words. */
  detail?: string;
}

/** The check of one landing's lineage note (`ft verify`, GET /api/colonies/:id/notes/verify). */
export interface NoteCheck {
  landingId: Id;
  trunkSha: Sha;
  at: Millis;
  status: NoteCheckStatus;
  /** The sha256 the commit's FT-Note trailer carries. */
  trailer?: string;
  /** `altered`: the sha256 of the note found, when it could be computed. */
  found?: string;
  /** Whether the trunk writer's own copy of the note still matches the trailer (an altered or missing note can be put back from it). */
  ownCopy?: boolean;
  /** Why the note is not intact, in words. */
  detail?: string;
  /** Whether the commit is signed by the trunk writer's published key; present where the deployment signs notes (FT_NOTE_KEY) and the commit could be read. */
  signature?: NoteSignatureCheck;
}

/** The newest landings' lineage notes on the trunk repository, checked against their commits. */
export interface NotesVerification {
  colonyId: Id;
  /** The notes commit read (refs/notes/firetrident on the trunk repository); null when the repository has none. */
  notesTip: Sha | null;
  /** Newest first. */
  notes: NoteCheck[];
  counts: Partial<Record<NoteCheckStatus, number>>;
  at: Millis;
}

/**
 * A colony's root commit (GET /api/colonies/:id/root): the first commit of its trunk, first parent from the tip, as the
 * trunk repository held it when the trunk writer first read it, and kept from then on. It pins the colony's history: a
 * clone checked with `scripts/verify_note.mjs --colony <root>` or `ft verify --all --colony <root>` fails when its root
 * is another (a clone of another colony, or history rewritten from its first commit).
 */
export interface TrunkRoot {
  colonyId: Id;
  /** The root commit, or null when it could not be read (`detail` says why). */
  rootSha: Sha | null;
  /** The root names a parent the trunk repository does not hold: an import keeps the newest 200 commits of its source, so its root is the oldest one kept. */
  shallow: boolean;
  /** When the root was first read. */
  at: Millis;
  /** Why the root could not be read, in words. */
  detail?: string;
}

/**
 * The change one landing made to one file (GET /api/colonies/:id/landings/:ref/diff?path=, served for the colonies listed in
 * FT_PUBLIC_GIT or FT_PUBLIC_MCP): the file's blob in the landing's lineage note write set against its blob in the parent
 * commit, as unified hunks cut on a line boundary so the answer stays within 64 KB. `before` and `after` are null where the
 * file is absent.
 */
export interface LandingDiff {
  colonyId: Id;
  landingId: Id;
  trunkSha: Sha;
  parentSha: Sha;
  path: Path;
  before: Sha | null;
  after: Sha | null;
  /** `binary`, `too-large` (a version over 512 KB) and `unreadable` carry no hunks; `unchanged`: the landing left the file as it was. */
  status: "added" | "deleted" | "modified" | "unchanged" | "binary" | "too-large" | "unreadable";
  /** Lines added and removed by the whole change, also when the hunks were cut. */
  added: number;
  removed: number;
  /** Unified hunks ("@@ -a,b +c,d @@", two lines of context), ending in "… (truncated)" when `truncated`. */
  hunks: string;
  truncated: boolean;
  /** Why no lines are shown, as a sentence, when none are. */
  detail?: string;
}

/**
 * A landing's test row (GET /api/colonies/:id/landings/:ref/tests; worker certify/landingtests.ts, core/testdelta.ts): the
 * colony's own tests at the commit the landing was applied on against the first green certification that includes it,
 * the tests lost on the way, whose tests they are, whether a test from before the landing reaches the files it wrote,
 * what landed it and what the model calls this platform made for it cost. Every number is FireTrident's own (trunk
 * certification, the landing log, the colony's spend counters); nothing in it is an agent's claim.
 */
export interface LandingTests {
  colonyId: Id;
  landingId: Id;
  trunkSha: Sha;
  /** The trunk commit the landing was applied on (its parent). */
  baseSha: Sha;
  /**
   * `certified`: a green certification at or after the landing includes it; `pending`: none does yet (`reason` says why);
   * `no-tests`: certification found no test this platform can run (none on trunk, none written for node:test, or none it
   * can load; `reason` says which).
   */
  status: "certified" | "pending" | "no-tests";
  /** Why it is pending or has no tests, as a clause ("trunk certification is off for this colony"). */
  reason?: string;
  /** The result at the base (`exact`), or at the nearest earlier commit that has one; absent when none is kept. */
  base?: TestsAt;
  /** The first green certification at or after the landing. */
  certified?: TestsAt;
  /** The first red result at or after the landing, before `certified` (or while there is none). */
  red?: TestsAt;
  /** Tests that passed at `base` and are missing or failing at `certified`; absent when there is no base to compare with. */
  lost?: number;
  /** The lost tests by name (at most 20). */
  lostTests?: Array<{ file: Path; name: string }>;
  /** Tests that pass at `certified` and did not pass at `base`. */
  added?: number;
  /** Test files whose per-test results at either commit are no longer kept: `lost` and `added` leave them out. */
  unknownFiles?: number;
  /** Whose tests ran at `certified`, by the landing log of each test file. */
  authors?: TestAuthors;
  /** The test files at `certified` whose import closure reaches a file the landing wrote. */
  reach?: TestReach;
  /** What landed each of its changes (the gate's rung, from its lineage note). */
  proof: ProofPath;
  /** What the model calls this platform made for its intents cost (FT_INTENT_SPEND); absent when none were counted. */
  spend?: { usd: number; calls: number; intents: number };
  /** What could not be read or was cut short, as sentences. */
  detail?: string;
  /** The row a landing card shows (core/testdelta.ts testsRow). */
  text: string;
}

/** One certification as a landing's test row reads it: its status and counts (pass of tests, failing ones). */
export interface TestsAt {
  sha: Sha;
  status: CertificationStatus;
  pass: number;
  tests: number;
  failing: number;
  /** Base only: the result is the base commit's own (false: a commit before it). */
  exact?: boolean;
}

/** Test files of one origin and the tests in them. */
export interface TestAuthorGroup {
  files: number;
  tests: number;
  /** Agents: the models that wrote or edited them; person: the people who approved the edits. */
  by?: string[];
}

/**
 * Whose tests ran at the certified commit, by the landing log of each test file (a test counts under its file):
 * `inherited` came with the repository and no landing changed them; `agents` were added or edited by a change no person
 * approved; `person` were added or edited only by changes a person approved (or by a person's revert); `unknown` files
 * whose log could not be read in full or that only FireTrident's own commits changed.
 */
export interface TestAuthors {
  inherited: TestAuthorGroup;
  agents: TestAuthorGroup;
  person: TestAuthorGroup;
  unknown?: TestAuthorGroup;
  /** Test files whose test count is no longer kept: their tests are in no group's `tests`. */
  uncounted?: number;
}

/**
 * The test files at the certified commit whose import closure (certification's own, certify/plan.ts closureOf) reaches a
 * file the landing wrote: `earlier` ones were on trunk before it, `own` ones it wrote itself, `later` ones came after it.
 * `none` says why nothing was checked: it wrote no file a test can load.
 */
export interface TestReach {
  earlier: number;
  own: number;
  later: number;
  /** Up to five of each, nearest first. */
  earlierFiles: Path[];
  ownFiles: Path[];
  /** Test files whose closures were checked. */
  checked: number;
  none?: "no-code";
  /** What the bounds cut short, as a sentence. */
  bounded?: string;
}

/** The rung that landed a change: a deterministic proof, a model's approval, earned autonomy, a person, no review, FireTrident's own commit, or unknown. */
export type ProofRung = "deterministic" | "model" | "autonomy" | "person" | "unreviewed" | "system" | "unknown";

/** What landed each change of a landing, grouped by rung (and by the model or person named), with the phrase a card shows. */
export interface ProofPath {
  rungs: Array<{ rung: ProofRung; count: number; by?: string }>;
  text: string;
}

// ---------------------------------------------------------------------------
// Trunk certification (the project's own tests, run after landings)
// ---------------------------------------------------------------------------

/**
 * `running`: started; `green`: every test passed; `red`: at least one failed; `error`: the run itself
 * failed (out of time or CPU, no runner), which says nothing about the code; `skipped`: nothing to run
 * (no test files, none written for node:test, or certification is off).
 */
export type CertificationStatus = "running" | "green" | "red" | "error" | "skipped";

/** One failing (or cancelled) test: its name with its suites, its file, and a short error. */
export interface FailingTest {
  name: string;
  file: Path;
  error?: string;
}

/**
 * A test that passed on the certified commit (or that a repair intent was declared for) and did not
 * run and pass on this one: it is todo or skipped now, no longer defined, or its file did not run
 * (deleted, or left out by the runner). A result that lost a test is red.
 */
export interface LostTest {
  file: Path;
  /** The test's name with its suites; absent when the whole file did not run. */
  name?: string;
  /** What happened to it, in words ("todo now", "deleted from trunk", "did not run: imports the package ..."). */
  why: string;
  /** The commit it last ran on: the certified commit, or the red commit its repair intent was declared on. */
  since: Sha;
  /** The repair intent it is owed to, when no green run included it. */
  repairIntentId?: Id;
}

/**
 * A change that may have broken failing tests (culprit finding): a landing since the last green commit
 * that changed a file a failing test file loads (the test file included) whose blob differs between the
 * two commits, or, for a test file new since then (or before the first green run), a landing that added
 * or last changed it or a file it loads. `ft revert <colony> <proposalId>` undoes it.
 */
export interface Suspect {
  landingId: Id;
  /** The trunk commit the landing made, when the colony still has it. */
  trunkSha?: Sha;
  /** The proposal that wrote the paths; absent when the colony knows no single proposal for them. */
  proposalId?: Id;
  intentId?: Id;
  /** The intent's title (one line). */
  title?: string;
  /** The files it changed among the ones the failing test files load. */
  paths: Path[];
  /** The failing test files it is a suspect for. */
  files: Path[];
  /** When it landed. */
  at: Millis;
  /**
   * Why it is listed, for at least one of its failing test files (see SuspectLabel). Absent on suspects recorded before
   * labels existed, which read as before.
   */
  labels?: SuspectLabel[];
}

/**
 * Why culprit finding lists a suspect. `first-since-green`: the oldest landing since the last green commit that changed
 * what a failing test file loads (every later suspect landed on a trunk that may already have been red); `latest`: one of
 * the newest landings that did; `first-red`: the landing of the first commit the failing tests fail on (FT_BISECT),
 * marked once that search ends. A landing can carry several.
 */
export type SuspectLabel = "first-since-green" | "latest" | "first-red";

/**
 * The first trunk commit at which a red result's failing tests fail (FT_BISECT), searched after the result is recorded:
 * only the failing test files and what they load run, alone, on commits between the last green certification and the
 * red one, halving the range each run. `inconclusive` says why no commit was named: the tests passed when run alone on
 * the red commit (flaky or order-dependent), there is no green commit to start from, a run failed or ran out of time,
 * or the range was too long for the runs allowed.
 */
export interface FirstRed {
  status: "found" | "inconclusive";
  /** Inconclusive only: why, in one sentence. */
  reason?: string;
  /** Found only: the commit, the landing that made it, and the intents landed in it. */
  trunkSha?: Sha;
  landingId?: Id;
  intents?: Array<{ id: Id; title?: string }>;
  /** Found only: its proposals whose writes touch what the failing tests load (the test files included), with those paths. */
  proposals?: Array<{ id: Id; intentId?: Id; title?: string; paths: Path[] }>;
  /** Found only: the failing test files that failed on that commit. */
  files?: Path[];
  /** Test runs used (one per commit tried, the red one first), and the search's wall time. */
  probes: number;
  ms: number;
  /** Landings between the last green commit and the red one. */
  landings?: number;
  /** The last green commit the search started from. */
  greenSha?: Sha;
  /** Copied from the search of this earlier red result: the same failing tests since the same green commit. */
  reusedFrom?: Sha;
}

/** Counts in the order `node --test` prints them. `tests` = pass + fail + cancelled + skipped + todo. */
export interface TestCounts {
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
  suites: number;
}

/** One trunk commit's certification: its own tests, run on that commit. */
export interface Certification {
  trunkSha: Sha;
  /** The landing that produced the commit (its lineage note carries the result too). */
  landingId?: Id;
  status: CertificationStatus;
  counts?: TestCounts;
  /** Failing and cancelled tests (at most 50), plus any test file that could not load. */
  failing?: FailingTest[];
  /** Tests this result lost (at most 50; `failing` lists them too, with the reason as the error). */
  lost?: LostTest[];
  /** Test files run, and test files left out with the reason (a package import, the size cap). */
  files?: number;
  unsupported?: Array<{ path: Path; reason: string }>;
  startedAt: Millis;
  finishedAt?: Millis;
  /** Wall time from start to result, and the part spent inside the test runner. */
  durationMs?: number;
  runMs?: number;
  /** Where the time went: reading the trunk index, reading and compiling files, the Dynamic Worker (load and run). */
  timing?: { indexMs: number; loadMs: number; workerMs: number };
  /** Modules loaded into the Dynamic Worker, and their size in characters. */
  modules?: { count: number; chars: number };
  /** The repair intent this red result declared. */
  repairIntentId?: Id;
  /** Red only, when culprit finding is on (FT_CULPRITS): the changes that may have broken the failing tests, newest first (at most 10). */
  suspects?: Suspect[];
  /** Red only, when the first red search is on (FT_BISECT): the first commit its failing tests fail on, added once the search ends. */
  firstRed?: FirstRed;
  /** Why it was skipped or could not run. */
  detail?: string;
  /** The tested files were identical to this earlier commit's run: its result was reused. */
  reusedFrom?: Sha;
  /** Test files whose results were reused because nothing they load changed (the rest ran). */
  cached?: number;
  /** The newest green commit when this result was recorded. */
  greenSha?: Sha;
}

/** A certification as the lineage note of the certified commit records it. */
export type NoteCertification = Pick<Certification, "status" | "counts" | "failing" | "durationMs" | "reusedFrom" | "finishedAt"> & { runner: string };

// ---------------------------------------------------------------------------
// Decide (reflex arc, immune review)
// ---------------------------------------------------------------------------

export type DecisionLayer = "reflex" | "llm" | "human";
export type DecisionKind = "collision" | "triage" | "antibody" | "conflict" | "overlap" | "admission";

/**
 * A stage of the reflex arc that settles proposals: the deterministic proof (no model), then the
 * decision layers. The funnel counts each proposal once, at the stage that settled it.
 */
export type FunnelStage = "proof" | DecisionLayer;

export interface Decision {
  id: Id;
  colonyId: Id;
  kind: DecisionKind;
  subject: Id;
  layer: DecisionLayer;
  answers: Record<string, unknown>;
  /** Calibrated probability of the chosen action. */
  p: number;
  action: string;
  at: Millis;
  escalatedFrom?: Id;
}

export type AntibodyOrigin = "human-reject" | "escaped-failure" | "reviewer" | "vaccine";

/** A check learned from a rejection or escape, stored in the repo under .firetrident/antibodies/. */
export interface Antibody {
  id: Id;
  colonyId: Id;
  origin: AntibodyOrigin;
  matcher: { paths: string[]; pattern?: string };
  question: string;
  threshold: number;
  createdAt: Millis;
  createdFrom?: Id;
  hits: number;
  falsePositives: number;
}

// ---------------------------------------------------------------------------
// Pause: a person stops every agent of one colony, or of the whole deployment
// ---------------------------------------------------------------------------

/** What a pause covers: one colony, or every colony on the deployment. */
export type PauseScope = "colony" | "deployment";

/** A pause in force: who paused (a person, or code acting for one, such as a spend cap), why, and when. */
export interface PauseState {
  scope: PauseScope;
  by: string;
  reason: string;
  at: Millis;
}

// ---------------------------------------------------------------------------
// Live events (UI stream and internal fan-out)
// ---------------------------------------------------------------------------

export type ColonyEvent =
  | { t: "agent"; at: Millis; agentId: Id; kind: AgentKind; state: AgentState; intentId?: Id; paths?: Path[] }
  | { t: "mark"; at: Millis; region: string; path: Path; kind: MarkKind; value: number }
  /**
   * An intent changed status. A close or reopen of an intent an agent held also carries the closure ledger's cause, the
   * agent, its kind and how long it had been silent (IntentClosure); events recorded before the ledger have none.
   */
  | { t: "intent"; at: Millis; intentId: Id; status: IntentStatus; title: string; footprint: Path[]; cause?: ClosureCause; agentId?: Id; agentKind?: AgentKind; gapMs?: number }
  | { t: "proposal"; at: Millis; proposalId: Id; intentId: Id; agentId: Id; status: ProposalStatus; reason?: string; movedBy?: MovedBy[] }
  | { t: "landing"; at: Millis; landingId: Id; trunkSha: Sha; proposalIds: Id[]; paths: Path[] }
  | { t: "decision"; at: Millis; decisionId: Id; kind: DecisionKind; layer: DecisionLayer; p: number; action: string; subject: Id }
  | { t: "sigma"; at: Millis; region: string; sigma: number }
  | { t: "violations"; at: Millis; total: number; byRule: Record<Id, number> }
  | { t: "metric"; at: Millis; name: string; value: number }
  // Changing direction: amendments, withdrawals, retracted rules, human directives, agents' status notes.
  | { t: "amended"; at: Millis; intentId: Id; revision: number; changed: IntentField[]; reason: string; by: string; title: string; returned: number }
  | { t: "withdrawn"; at: Millis; intentId: Id; reason: string; by: string; title: string; returned: number; ruleId?: Id }
  | { t: "retracted"; at: Millis; ruleId: Id; reason: string; by: string; withdrawn: number }
  /**
   * A person undid a landing (`ft revert`): `landingId` is the revert commit, `of` the landing undone; `redo` the intents declared again.
   * `proposal`: only that proposal of the landing was undone (its files, its intent); the others stayed.
   */
  | { t: "reverted"; at: Millis; landingId: Id; of: Id; trunkSha: Sha; paths: Path[]; reason: string; by: string; redo: Id[]; proposal?: Id }
  | { t: "directive"; at: Millis; directiveId: Id; agentId: Id; intentId?: Id; message: string; by: string; via?: "push" | "inbox"; kind?: DirectiveKind; landingId?: Id; paths?: Path[] }
  | { t: "escalation"; at: Millis; intentId: Id; agentId: Id; kind: EscalationKind; report: string; title: string; resolved?: IntentEscalation["resolved"] }
  /** The stuck-work detector found an item: published once per item key, and nothing when it clears. */
  | { t: "stuck"; at: Millis; item: StuckItem }
  | { t: "contest"; at: Millis; intentId: Id; title: string; winner: Id; losers: Id[]; reason: string }
  | { t: "revalidated"; at: Millis; proposalId: Id; intentId: Id; paths: Path[]; names: string[] }
  | { t: "status"; at: Millis; agentId: Id; intentId?: Id; note: string }
  // A person paused the agents of the colony (or of the deployment), or resumed them.
  | { t: "paused"; at: Millis; scope: PauseScope; by: string; reason: string }
  | { t: "resumed"; at: Millis; scope: PauseScope; by: string; reason?: string; pausedAt?: Millis }
  // Trunk certification: a run started, or its result (failing names capped at 10).
  | {
      t: "certify";
      at: Millis;
      trunkSha: Sha;
      status: CertificationStatus;
      landingId?: Id;
      counts?: TestCounts;
      failing?: FailingTest[];
      durationMs?: number;
      greenSha?: Sha;
      detail?: string;
      reusedFrom?: Sha;
      /** The result's suspects (culprit finding), at most 5. */
      suspects?: Suspect[];
    }
  // The first red search (FT_BISECT) ended for the red result of `trunkSha`: the result now carries `firstRed`.
  | { t: "bisect"; at: Millis; trunkSha: Sha; firstRed: FirstRed };

/** Per-minute history for sparklines and the violations burn-down. */
export interface ColonySeries {
  /** Bucket width (ms). */
  bucketMs: number;
  /** Start of the first bucket. Bucket i covers [start + i * bucketMs, start + (i + 1) * bucketMs); the last is the current minute. */
  start: Millis;
  /** Landings per bucket. */
  landings: number[];
  /** Open violations at the end of each bucket (the last bucket is the current total). */
  violations: number[];
  /** Proposals received per bucket. */
  proposals: number[];
  /** Proposals sent back to their agents (stale or conflicting) per bucket. */
  returned: number[];
  /** Intents landed per bucket. */
  landedIntents: number[];
}

/**
 * The violations counter since the latest rule change (a rule added or retracted): how many were
 * open right after it, how many are fixed, and when the colony reached zero.
 */
export interface Convergence {
  /** When the latest rule change happened; null while the colony has no rules. */
  since: Millis | null;
  /** Violations open right after that change. */
  initial: number;
  /** Violations resolved since then (landed fixes; a retraction is a change, not a fix). */
  fixed: number;
  /** When the open count reached zero after the change, or null while violations remain (or none were open). */
  convergedAt: Millis | null;
}

/**
 * What the stuck-work detector checks (it only reports):
 * - `claimed`: an intent claimed for too long with no change proposed
 * - `returns`: an intent whose changes came back three times or more
 * - `red`: trunk certification red for too long
 * - `report`: an agent's report that an intent cannot be done as written, waiting for a person
 * - `review`: a change waiting for a person's review
 * - `agent`: an agent alive but not progressing
 */
export type StuckKind = "claimed" | "returns" | "red" | "report" | "review" | "agent";

/** What a person can do about stuck work: look at the agent, amend or withdraw the intent, look at the failing tests, answer the report, review the change. */
export type StuckAction = "agent" | "intent" | "tests" | "answer" | "review";

/**
 * Where a red trunk's repair intent stands: no agent holds it (`open`), an agent works on it, its change
 * is being checked or waits for its lane (`proposed`), its change waits for a person's review, or an agent
 * reported that it cannot be done as written and a person must answer (`reported`).
 */
export type StuckRepairState = "open" | "working" | "proposed" | "review" | "reported";

/** Work that stopped moving, as the stuck-work detector found it. */
export interface StuckItem {
  /** The item and its episode (a new claim, red run or report is a new key); one `stuck` event is published per key. */
  key: string;
  kind: StuckKind;
  /** When the work stopped moving: the claim, the third return, the first red result, the report, the escalation, the agent's last step. */
  since: Millis;
  /** What is stuck, in one line. It quotes titles, notes and reasons (untrusted text): render it as text. */
  text: string;
  /** What a person can do about it. */
  action: StuckAction;
  /** The intent it is about (`red`: the repair intent, when one is open). */
  intentId?: Id;
  title?: string;
  /** The agent it is about (`red`: the agent working on the repair). */
  agentId?: Id;
  /** That agent's own last status note. */
  note?: string;
  /** The change it is about (`red`: the repair's change in flight). */
  proposalId?: Id;
  /** `returns`: how many times the intent's changes came back, and the latest reasons, newest first. */
  returns?: number;
  reasons?: string[];
  /** `red`: the first red commit since the last green one, and where its repair stands (absent when no repair is open). */
  trunkSha?: Sha;
  repair?: StuckRepairState;
}

/** The stuck-work detector's findings at one time: the kinds most in need of a person first, oldest first within a kind. */
export interface StuckReport {
  at: Millis;
  items: StuckItem[];
  /** Items found in all: more than `items` lists when the list was cut. */
  total: number;
}

/**
 * A file the megafile alarm held (FT_MEGAFILE): while held, no change but its split intent's may write it and no
 * other intent whose footprint covers it is offered. The hold lifts when the split lands, is withdrawn or reported
 * (escalated), when a person releases it, or at `until`. The numbers are the file's when it was held.
 */
export interface MegafileHold {
  path: Path;
  /** The split intent the hold waits for. */
  intentId: Id;
  /** "colony" when the alarm held it, else the person who did. */
  by: string;
  at: Millis;
  /** When the hold lifts by itself. */
  until: Millis;
  /** What made the file hot: its growth among many writers, changes colliding on it, or a person. */
  signal: "growth" | "returns" | "person";
  /** Lines when held, lines when the window opened, and the growth between them as a fraction (null when not known). */
  lines: number | null;
  baseline: number | null;
  growth: number | null;
  /** Distinct agents whose changes to the file landed in the window, and changes that went back naming it. */
  agents: number;
  returns: number;
  windowMs: number;
  /** Once lifted: when, and why ("landed", "withdrawn", "escalated", "expired", "released by <name>"). */
  liftedAt?: Millis;
  lifted?: string;
  /** The file's lines after its split landed, when known. */
  linesAfter?: number;
}

/** The megafile alarm's state for a colony: the files held now, and the holds lifted lately (newest first). */
export interface MegafileReport {
  at: Millis;
  held: MegafileHold[];
  lifted: MegafileHold[];
}

/**
 * Where a colony's model calls come from: its in-platform agents, review (the decide stage's reflex and second
 * opinion), contest judging, the conflict resolver, and the rest (antibody minting).
 */
export type SpendLayer = "agents" | "review" | "judge" | "resolver" | "other";

/** One model's tokens across a colony's layers, and their price (null: the model has no listed price). */
export interface ModelSpend {
  input: number;
  output: number;
  usd: number | null;
}

/**
 * What a colony's model calls cost: the tokens the colony counted, priced at Workers AI list prices on `priceDate`
 * (core/pricing.ts). A model with no listed price is never guessed: its tokens are in `unpriced` and in no dollar sum.
 */
export interface ColonySpend {
  /** USD of every priced call. */
  usd: number;
  byLayer: Record<SpendLayer, number>;
  /** `usd` over the intents landed; null when none landed. */
  perLandedIntent: number | null;
  landedIntents: number;
  /** Every token counted, priced or not. */
  tokens: { input: number; output: number };
  byModel: Record<string, ModelSpend>;
  /** Tokens of models with no listed price, by model. */
  unpriced: Record<string, { input: number; output: number }>;
  /** The day of the list prices (YYYY-MM-DD). */
  priceDate: string;
  /** In-platform agents whose journals the colony has not read yet: their calls are missing from `byLayer.agents`. */
  agentsUnread?: number;
  /** The colony's spend cap (colony/spendcap.ts), when a person set one; absent means no cap. */
  cap?: SpendCap;
}

/**
 * Where a colony stands against its spend cap: `open` (every model call goes on), `review-only` (the share for
 * everything but review is spent: agents are paused and only review may call, from its reserve) or `spent` (the reserve
 * too: review makes no model call and changes wait for a person).
 */
export type SpendCapState = "open" | "review-only" | "spent";

/**
 * A colony's spend cap (POST /api/colonies/:id/spend-cap, colony/spendcap.ts): a dollar limit on the model calls this
 * platform makes for the colony (never what external agents spend on their own models), with a reserve only review may
 * use. Each call is reserved before it starts and settled at its actual tokens' price after, so calls in flight together
 * cannot pass the cap.
 */
export interface SpendCap {
  /** The cap in USD. */
  usd: number;
  /** The part of the cap kept for review (the reflex and the second opinion); every other call stops at `usd - reviewReserveUsd`. */
  reviewReserveUsd: number;
  /** What the cap counts as spent so far (USD): the colony's spend, with the calls settled since that its journals have not shown yet. */
  spentUsd: number;
  /** Reserved for model calls in flight (USD). */
  inFlightUsd: number;
  state: SpendCapState;
  /** Who set the cap last, and when. */
  setBy: string;
  setAt: Millis;
}

/**
 * What one intent's model calls cost (GET /api/colonies/:id/intents/:intentId/spend, core/pricing.ts intentSpend): the
 * agents' calls on its takes and review's calls on its changes (the reflex, the second opinion, the contest judge),
 * counted per intent and model as they happen where FT_INTENT_SPEND covers the colony, and priced like ColonySpend.
 * Calls made before the colony counted per intent are not here: the colony's total has them, this does not.
 */
export interface IntentSpend {
  intentId: Id;
  /** USD of every priced call. */
  usd: number;
  byLayer: Record<SpendLayer, number>;
  /** Model calls counted, by layer (a call whose usage was not reported still counts here). */
  calls: Record<SpendLayer, number>;
  /** Every token counted, priced or not. */
  tokens: { input: number; output: number };
  byModel: Record<string, ModelSpend>;
  /** Tokens of models with no listed price, by model. */
  unpriced: Record<string, { input: number; output: number }>;
  /** The day of the list prices (YYYY-MM-DD). */
  priceDate: string;
}

/** An intent's spend beside a listing (ColonySnapshot.intentSpend): its total, each layer that called with its calls, and its tokens. */
export interface IntentSpendBrief {
  usd: number;
  byLayer: Partial<Record<SpendLayer, { usd: number; calls: number }>>;
  tokens: { input: number; output: number };
  /** True when some of its tokens had no list price (they count in no dollar sum). */
  unpriced?: boolean;
}

/** Snapshot the UI loads before applying live events. */
export interface ColonySnapshot {
  colony: Colony;
  files: Array<{ path: Path; size: number }>;
  intents: Intent[];
  rules: Rule[];
  agents: AgentInfo[];
  recentLandings: Landing[];
  violations: { total: number; byRule: Record<Id, number> };
  /**
   * Proposals settled per stage of the reflex arc, each counted once at the stage that settled it
   * (`proof`: the deterministic proof alone; an escalation counts at `human`). Older servers sent
   * decisions per layer and no `proof`.
   */
  funnel: Record<DecisionLayer, number> & { proof?: number };
  metrics: Record<string, number>;
  /** Per-minute series (served by the Worker; absent in mocks). */
  series?: ColonySeries;
  /** Violations fixed since the latest rule change, and when the colony converged (served by the Worker). */
  convergence?: Convergence;
  /** Work that stopped moving (the stuck-work detector, computed on demand; served by the Worker). */
  stuck?: StuckReport;
  /** Files held for their split (the megafile alarm; served when FT_MEGAFILE covers the colony). */
  megafiles?: MegafileReport;
  /** What the colony's model calls cost so far (served by GET /api/colonies/:id and /metrics; absent in mocks). */
  spend?: ColonySpend;
  /**
   * What each intent's model calls cost, by intent id, for the intents the colony counted per intent (FT_INTENT_SPEND;
   * served by GET /api/colonies/:id and /metrics, the 2,000 most recently active at most; absent when none was counted).
   */
  intentSpend?: Record<Id, IntentSpendBrief>;
  /**
   * The pauses in force (colony/pause.ts): the colony's own first, then the deployment's. Absent while agents may work,
   * and from servers that predate the pause.
   */
  pauses?: PauseState[];
}

// ---------------------------------------------------------------------------
// Replay (the persisted event record)
// ---------------------------------------------------------------------------

/** One event of a colony's record, with its sequence number. */
export type RecordedEvent = ColonyEvent & { seq: number };

/**
 * A page of GET /api/colonies/:id/events. `recorded` events were persisted as they happened;
 * `reconstructed` ones were rebuilt from what the colony stores (runs from before recording).
 */
export interface EventsPage {
  colonyId: Id;
  source: "recorded" | "reconstructed";
  events: RecordedEvent[];
  /** Pass as `after` for the next page; null once this page reached the end. */
  next: number | null;
  /** The whole record: how many events, and the time of the first and the last. */
  total: number;
  first: Millis | null;
  last: Millis | null;
}
