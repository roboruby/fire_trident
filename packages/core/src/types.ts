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
  source?: { url: string; branch: string };
  createdAt: Millis;
  /** Directory depth that defines a region (1 = top-level directories). */
  regionDepth: number;
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
  /** Agents currently holding claims in the region. */
  agents: Array<{ agentId: Id; intentId?: Id; paths: Path[] }>;
  /** Causal branching ratio of recent events (criticality governor). */
  sigma: number;
  /** Harvester-ant admission control: may new agents enter this region now? */
  admission: { open: boolean; landingsPerMin: number; activeAgents: number };
}

// ---------------------------------------------------------------------------
// Intents, rules, morphology
// ---------------------------------------------------------------------------

/** `certify`: declared by trunk certification to repair failing tests (see Certification). */
export type IntentSource = "human" | "rule" | "agent" | "certify";
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
}

/** What an agent can report instead of working around it. */
export type EscalationKind = "broken-test" | "contradictory-spec" | "impossible" | "other";

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
 */
export type DirectiveKind = "guidance" | "revision" | "withdrawal" | "landing";

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
}

export interface Evidence {
  checks: CheckResult[];
  /** Paths changed that the declared footprint did not predict (residual review). */
  residual?: Path[];
  /** Mandatory honest gap statement. */
  notVerified?: string;
  previewUrl?: string;
  /** The intent revision and directives the change was built under (set by the colony at propose time). */
  direction?: Direction;
}

/** The names a change imports from one trunk file (see Proposal.nameAssumptions). */
export interface NameAssumption {
  path: Path;
  names: string[];
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
   * The intent revision the change was built on. An agent passes the revision it worked from; the
   * colony refuses a proposal built on an older substantive revision, and the lane returns one before
   * landing if the intent was revised meanwhile.
   */
  intentRevision?: number;
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
}

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
    intent: { id: Id; title: string; why: string; ruleId?: Id; parentId?: Id };
    writeSet: FileVersion[];
    readSet: FileVersion[];
    decisions: NoteDecision[];
    /** Includes `direction` (intent revision, directives, status note) for changes built under one. */
    evidence: Evidence;
    /** Contest mode: the other attempts at the same intent, and why each lost. */
    alternatives?: Array<{ proposalId: Id; agentId: Id; model?: string; reason: string }>;
    /** Assumption revalidation: files that changed after this change read them, and the names it relies on that still held. */
    revalidated?: Array<{ path: Path; read: Sha | null; landedOn: Sha | null; names: string[] }>;
  }>;
  /** The project's own tests on this commit, when trunk certification ran on it (added after landing). */
  certification?: NoteCertification;
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
// Live events (UI stream and internal fan-out)
// ---------------------------------------------------------------------------

export type ColonyEvent =
  | { t: "agent"; at: Millis; agentId: Id; kind: AgentKind; state: AgentState; intentId?: Id; paths?: Path[] }
  | { t: "mark"; at: Millis; region: string; path: Path; kind: MarkKind; value: number }
  | { t: "intent"; at: Millis; intentId: Id; status: IntentStatus; title: string; footprint: Path[] }
  | { t: "proposal"; at: Millis; proposalId: Id; intentId: Id; agentId: Id; status: ProposalStatus; reason?: string }
  | { t: "landing"; at: Millis; landingId: Id; trunkSha: Sha; proposalIds: Id[]; paths: Path[] }
  | { t: "decision"; at: Millis; decisionId: Id; kind: DecisionKind; layer: DecisionLayer; p: number; action: string; subject: Id }
  | { t: "sigma"; at: Millis; region: string; sigma: number }
  | { t: "violations"; at: Millis; total: number; byRule: Record<Id, number> }
  | { t: "metric"; at: Millis; name: string; value: number }
  // Changing direction: amendments, withdrawals, retracted rules, human directives, agents' status notes.
  | { t: "amended"; at: Millis; intentId: Id; revision: number; changed: IntentField[]; reason: string; by: string; title: string; returned: number }
  | { t: "withdrawn"; at: Millis; intentId: Id; reason: string; by: string; title: string; returned: number; ruleId?: Id }
  | { t: "retracted"; at: Millis; ruleId: Id; reason: string; by: string; withdrawn: number }
  /** A person undid a landing (`ft revert`): `landingId` is the revert commit, `of` the landing undone; `redo` the intents declared again. */
  | { t: "reverted"; at: Millis; landingId: Id; of: Id; trunkSha: Sha; paths: Path[]; reason: string; by: string; redo: Id[] }
  | { t: "directive"; at: Millis; directiveId: Id; agentId: Id; intentId?: Id; message: string; by: string; via?: "push" | "inbox"; kind?: DirectiveKind; landingId?: Id; paths?: Path[] }
  | { t: "escalation"; at: Millis; intentId: Id; agentId: Id; kind: EscalationKind; report: string; title: string; resolved?: IntentEscalation["resolved"] }
  | { t: "contest"; at: Millis; intentId: Id; title: string; winner: Id; losers: Id[]; reason: string }
  | { t: "revalidated"; at: Millis; proposalId: Id; intentId: Id; paths: Path[]; names: string[] }
  | { t: "status"; at: Millis; agentId: Id; intentId?: Id; note: string }
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
    };

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
