import type {
  AgentKind,
  Antibody,
  CheckResult,
  Colony,
  ColonyEvent,
  Decision,
  FileVersion,
  Id,
  Intent,
  Landing,
  LineageNote,
  Path,
  Proposal,
  Rule,
  Sha,
} from "@fire_trident/core";
import { newId } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { runInnateChecks } from "../colony/innate.ts";
import { errorText, ftError } from "../colony/errors.ts";
import { ANTIBODY_DIR, antibodyFile, antibodyPath, calibrateThreshold, cleanQuestion, deriveMatcher, fallbackQuestion, parseAntibodyFile } from "./antibodies.ts";
import { addedFromHunks, fileDiff, type FileDiff } from "./diff.ts";
import { gate, type GateVerdict, type ReflexSignals, type SecondOpinion } from "./gate.ts";
import { pickSecondOpinion, type DecidePolicy } from "./policy.ts";
import { pushQuarantine } from "./quarantine.ts";
import {
  askClef,
  askSecondOpinion,
  noul,
  readReflex,
  reflexQuestions,
  reflexState,
  reflexSummary,
  rephraseAsQuestion,
  secondOpinionMessages,
  type AiRunner,
  type ReflexInput,
} from "./reflex.ts";
import { damageSignals, isTestPath } from "./signals.ts";
import { DecideStore, type DetectorStats, type StoredAntibody } from "./store.ts";
import { VACCINE_CLASSES, VACCINE_LABELS, makeVaccine, recallReport, type SourceFile, type VaccineChange, type VaccineClass } from "./vaccine.ts";

/**
 * The Decide prong's pipeline for one colony: innate checks, System 1 (Clef), the two-signal gate,
 * System 2 when needed, then the proposal moves on (lane, agent, or human queue). It also mints
 * antibodies from human rejections, keeps detector probation and the alert budget, and runs the
 * vaccination meter. ColonyDO hosts it and supplies the colony's state through DecideHost.
 */

/** Input of ColonyDO.recordDecision. */
export type DecisionInput = Omit<Decision, "id" | "colonyId" | "at"> & { at?: number };

/** Input of ColonyDO.propose. */
export type ProposeInput = Omit<Proposal, "id" | "status" | "createdAt" | "evidence"> & { evidence?: Partial<Proposal["evidence"]> };

/** The trunk calls the pipeline makes (TrunkDO RPC). */
export interface TrunkRpc {
  baseBlobs(baseSha: Sha, paths: Path[]): Promise<FileVersion[]>;
  blobsFor(paths: Path[]): Promise<Record<Path, Sha | null>>;
  readFile(path: Path): Promise<string | null>;
  files(): Promise<Array<{ path: Path; size: number; blob: Sha }>>;
  systemCommit(p: { files: Array<{ path: Path; content: string | null }>; message: string; note: LineageNote & Record<string, unknown> }): Promise<Landing>;
}

/** What the pipeline needs from its colony (implemented by ColonyDO). */
export interface DecideHost {
  env: Env;
  sql: SqlStorage;
  waitUntil(p: Promise<unknown>): void;
  colony(): Colony;
  intent(id: Id): Intent | null;
  rules(): Rule[];
  agent(id: Id): { kind: AgentKind; name: string; model?: string } | null;
  proposal(id: Id): Proposal | null;
  /** Region of a recorded proposal (its lane). */
  proposalRegion(id: Id): string;
  /** Proposals still "checking" that were created before `before`. */
  stuckChecking(before: number): Id[];
  updateProposals(items: Array<{ id: Id; patch: Partial<Proposal> }>): Promise<void>;
  recordDecision(d: DecisionInput): Promise<Decision>;
  decisionsFor(subject: Id): Decision[];
  bump(name: string, delta: number): void;
  setMetric(name: string, value: number): void;
  emit(events: ColonyEvent[]): void;
  trunk(): TrunkRpc;
  /** A FireTrident-authored trunk commit (antibody) landed. */
  systemCommitted(l: Landing): Promise<void>;
  /** The colony's vaccine agent (registered on first use, marked seen). */
  vaccineAgent(): Promise<Id>;
  /** Rule intents vaccines can copy (title, why, footprint), open ones first. */
  vaccineTargets(limit: number): Array<{ title: string; why: string; footprint: Path[]; ruleId?: Id }>;
  /** Create a claimed intent for the vaccine agent with no field effects. */
  sealedIntent(i: { title: string; why: string; footprint: Path[]; ruleId?: Id; agentId: Id }): Id;
  propose(input: ProposeInput): Promise<Proposal>;
  /** Finish a vaccine: rejected with the reason, its intent abandoned, no lane, no field effects. */
  seal(proposalId: Id, reason: string, evidence: Proposal["evidence"]): void;
}

/** Decide runs in flight per colony (Clef and System 2 calls). */
const MAX_CONCURRENT = 12;
/** A proposal "checking" longer than this with no run in flight is restarted. */
const STUCK_MS = 120_000;
const HOUR_MS = 60 * 60_000;
/** Vaccines per call. */
const MAX_VACCINES = 64;

/** A vaccination batch as started. */
export interface VaccinationResult {
  batch: string;
  requested: number;
  started: number;
  vaccines: Array<{ proposalId: Id; cls: VaccineClass; paths: Path[] }>;
  skipped: Array<{ cls: VaccineClass; reason: string }>;
}

/** The decide pipeline of one colony. */
export class DecideEngine {
  readonly store: DecideStore;
  private readonly running = new Set<Id>();
  private readonly queue: Id[] = [];
  private active = 0;
  private syncing: Promise<void> | null = null;

  constructor(private readonly host: DecideHost) {
    this.store = new DecideStore(host.sql);
  }

  /** True when proposals go through the reflex arc (AI bound and the policy on). */
  enabled(): boolean {
    return Boolean(this.host.env.AI) && this.store.policy().enabled;
  }

  /** Queue the pipeline for a proposal in "checking" (no-op if it is already running). */
  start(id: Id): void {
    if (this.running.has(id)) return;
    this.running.add(id);
    this.queue.push(id);
    this.pump();
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.active++;
      this.host.waitUntil(
        this.run(id)
          .catch((err) => console.error(`decide ${id} failed: ${errorText(err)}`))
          .finally(() => {
            this.active--;
            this.running.delete(id);
            this.pump();
          }),
      );
    }
  }

  /** Restart proposals stuck in "checking" (the object restarted mid-run). */
  sweep(now = Date.now()): void {
    for (const id of this.host.stuckChecking(now - STUCK_MS)) this.start(id);
  }

  /** Decide one proposal; on any failure it goes back to its agent (it never lands by mistake). */
  async run(id: Id): Promise<void> {
    const p = this.host.proposal(id);
    if (!p || p.status !== "checking") return;
    try {
      await this.decideOne(p);
    } catch (err) {
      const msg = errorText(err);
      console.error(`decide pipeline error for ${id}: ${msg}`);
      const cur = this.host.proposal(id);
      if (!cur || cur.status !== "checking") return;
      const vaccine = this.store.vaccineByIntent(cur.intentId);
      if (vaccine) {
        this.store.settleVaccine(vaccine.intentId, "error", null, msg, Date.now());
        this.host.seal(id, `vaccine ${vaccine.cls} (sealed): pipeline error, discarded: ${msg}`, cur.evidence);
        return;
      }
      await this.host.updateProposals([{ id, patch: { status: "returned", reason: `decide pipeline failed (${msg}); propose again` } }]);
    }
  }

  private ai(): AiRunner {
    return this.host.env.AI as unknown as AiRunner;
  }

  private async decideOne(p: Proposal): Promise<void> {
    const policy = this.store.policy();
    const colony = this.host.colony();
    const intent = this.host.intent(p.intentId);
    const rules = this.host.rules();
    const rule = intent?.ruleId ? (rules.find((r) => r.id === intent.ruleId) ?? null) : null;
    const region = this.host.proposalRegion(p.id);
    const vaccine = this.store.vaccineByIntent(p.intentId);
    await this.syncAntibodies();

    // Innate checks, then what the change looks like and what it could damage.
    const innate = await runInnateChecks(p, { env: this.host.env, colony, intent, rules, baseBlobs: (sha, paths) => this.host.trunk().baseBlobs(sha, paths) });
    const diffs = innate.files.map((f) => fileDiff(f.path, f.before, f.after, { binary: f.binary, unreadable: f.unreadable }));
    const damage = damageSignals(
      innate.files.map((f, i) => ({ path: f.path, before: f.before, after: f.after, added: diffs[i]?.addedLines ?? [] })),
      innate.residual,
    );
    const paths = p.writeSet.map((w) => w.path);
    const added = diffs.flatMap((d) => d.addedLines);
    const matching = this.store.matchingAntibodies(paths, added, policy.maxAntibodies);

    // System 1.
    const input: ReflexInput = {
      intent: intent ?? { title: p.declared.summary || p.intentId, why: "" },
      rule,
      footprint: intent?.footprint ?? p.declared.footprint,
      residual: innate.residual,
      diffs,
      antibodies: matching.map((s) => s.antibody),
    };
    const state = reflexState(input);
    const clefStates = this.store.clefStates();
    const skip = new Set(Object.entries(clefStates).filter(([, s]) => s === "off").map(([k]) => k));
    let reflex: ReflexSignals | null = null;
    let clefMs = 0;
    let clefError = "";
    try {
      const r = await askClef(this.ai(), policy.reflexModel, state, reflexQuestions(input.antibodies, skip));
      reflex = readReflex(
        r.answers,
        matching.map((s) => ({ id: s.antibody.id, threshold: s.antibody.threshold, state: s.state })),
      );
      clefMs = r.ms;
      this.host.bump("decide.clef.tokens", r.tokens);
    } catch (err) {
      clefError = errorText(err);
    }
    const base = {
      innate: { ok: innate.ok, failures: innate.failures },
      damage,
      reflex,
      autonomy: !vaccine && this.store.approvedLandings(region) >= policy.autonomyAfter,
      alerts: { used: this.store.escalationsSince(Date.now() - HOUR_MS), max: policy.alertsPerHour },
      detectors: clefStates,
      policy,
    };
    const v1 = gate(base);
    const d1 = await this.host.recordDecision({
      kind: "triage",
      subject: p.id,
      layer: "reflex",
      answers: { head: p.headSha, model: policy.reflexModel, ...(reflex ? { reflex } : { error: clefError }), rule: v1.rule, reasons: v1.reasons, damage: v1.damage, confidence: v1.confidence, ...(vaccine ? { vaccine: true } : {}) },
      p: v1.p,
      action: v1.action,
    });

    // System 2 when the reflex does not act alone.
    let final: GateVerdict = v1;
    let llm: SecondOpinion | null | undefined;
    let llmModel = "";
    let llmMs = 0;
    let llmError = "";
    if (v1.action === "consult") {
      llmModel = pickSecondOpinion(this.host.agent(p.agentId)?.model, policy.secondOpinionModels);
      try {
        const r = await askSecondOpinion(this.ai(), llmModel, secondOpinionMessages(input, p.evidence.notVerified));
        llm = r.opinion;
        llmMs = r.ms;
        this.host.bump("decide.llm.tokensIn", r.tokens.in);
        this.host.bump("decide.llm.tokensOut", r.tokens.out);
      } catch (err) {
        llm = null;
        llmError = errorText(err);
      }
      final = gate({ ...base, llm });
      await this.host.recordDecision({
        kind: "triage",
        subject: p.id,
        layer: "llm",
        answers: { head: p.headSha, model: llmModel, ...(llm ? { verdict: llm } : { error: llmError }), rule: final.rule, reasons: final.reasons, damage: final.damage, ...(vaccine ? { vaccine: true } : {}) },
        p: final.p,
        action: final.action,
        escalatedFrom: d1.id,
      });
    }

    const now = Date.now();
    this.host.bump(`decide.${final.layer}.${final.action}`, 1);
    if (!vaccine) this.probation(v1, final, llm, policy, now);
    this.store.recordOutcome({
      proposalId: p.id,
      region,
      head: p.headSha,
      layer: final.layer,
      action: final.action,
      risk: final.risk,
      detectors: final.detectors,
      vaccine: Boolean(vaccine),
      state: JSON.stringify(state),
      at: now,
    });

    // Evidence: the innate checks and each layer's answer, carried into the lineage note on landing.
    const checks: CheckResult[] = [...innate.checks];
    checks.push({ name: `reflex: ${policy.reflexModel}`, ok: v1.action !== "escalate" && v1.detectors.length === 0, ms: clefMs, detail: reflex ? `${reflexSummary(reflex)}; confidence ${v1.confidence}` : `unavailable: ${clefError}` });
    if (llm !== undefined) checks.push({ name: `llm: ${llmModel}`, ok: llm?.verdict === "approve", ms: llmMs, detail: llm ? `${llm.verdict}, needs_human ${llm.needsHuman}: ${llm.reason}` : `unavailable: ${llmError}` });
    checks.push({
      name: "gate",
      ok: final.action === "land",
      ms: 0,
      detail: `${final.rule} → ${final.action} by ${final.layer} at head ${p.headSha.slice(0, 12)}${final.confirmations.length > 0 ? ` (confirmations: ${final.confirmations.join(" + ")})` : ""}: ${final.reasons.join("; ")}`.slice(0, 1_000),
    });
    const evidence = { ...p.evidence, checks: [...p.evidence.checks, ...checks] };

    // Both confirmations are bound to this head commit and write set: if either moved, nothing lands.
    const cur = this.host.proposal(p.id);
    if (!cur || cur.status !== "checking") return;
    if (cur.headSha !== p.headSha || JSON.stringify(cur.writeSet) !== JSON.stringify(p.writeSet)) {
      await this.host.updateProposals([{ id: p.id, patch: { status: "returned", reason: "head commit changed while it was being reviewed; propose again" } }]);
      return;
    }
    const reason = final.reasons.join("; ").slice(0, 1_500);
    if (vaccine) {
      // A vaccine stopped only because every model layer was down is not a catch: it is an error.
      const blind = !reflex && !llm && innate.ok;
      const outcome = blind ? "error" : final.action === "land" ? "missed" : final.action === "escalate" ? "escalated" : "returned";
      this.store.settleVaccine(vaccine.intentId, outcome, final.layer, reason, now);
      const verdict =
        outcome === "missed" ? "missed by every layer, discarded (it can never land)" : outcome === "error" ? "not judged (model layers unavailable), discarded" : `caught: ${final.action} by ${final.layer}`;
      this.host.seal(p.id, `vaccine ${vaccine.cls} (sealed): ${verdict}: ${reason}`, evidence);
      this.publishVaccineMetrics();
      return;
    }
    if (final.action === "land") {
      await this.host.updateProposals([{ id: p.id, patch: { status: "ready", evidence } }]);
    } else if (final.action === "escalate") {
      this.store.revokeAutonomy(region, `escalated ${p.id}`, now);
      await this.host.updateProposals([{ id: p.id, patch: { status: "escalated", reason: `escalated by ${final.layer}: ${reason}`, evidence } }]);
    } else {
      await this.host.updateProposals([{ id: p.id, patch: { status: "returned", reason: `${final.layer}: ${reason}`, evidence } }]);
    }
    this.publishMetrics(policy);
  }

  /** Detector bookkeeping: fires, and System 2 overruling a System 1 alarm counts as "not useful". */
  private probation(v1: GateVerdict, final: GateVerdict, llm: SecondOpinion | null | undefined, policy: DecidePolicy, now: number): void {
    const fired = new Set([...v1.detectors, ...final.detectors].filter((d) => d.startsWith("clef:") || d.startsWith("antibody:")));
    for (const id of fired) {
      const overruled = llm?.verdict === "approve" && final.action === "land";
      this.store.markDetector(id, { fires: 1, ...(overruled ? { notUseful: 1 } : {}) }, policy.probation, now);
    }
  }

  /** Gauges: alerts this hour, antibodies, autonomous regions. */
  private publishMetrics(policy: DecidePolicy): void {
    const now = Date.now();
    const alerts = this.store.escalationsSince(now - HOUR_MS);
    const antibodies = this.store.antibodies().filter((a) => a.state !== "off").length;
    const autonomous = this.store.autonomyTable(policy.autonomyAfter).filter((r) => r.earned).length;
    this.host.setMetric("alerts.lastHour", alerts);
    this.host.setMetric("alerts.budget", policy.alertsPerHour);
    this.host.setMetric("antibodies.active", antibodies);
    this.host.setMetric("autonomy.regions", autonomous);
    this.host.emit([
      { t: "metric", at: now, name: "alerts.lastHour", value: alerts },
      { t: "metric", at: now, name: "antibodies.active", value: antibodies },
      { t: "metric", at: now, name: "autonomy.regions", value: autonomous },
    ]);
  }

  // =========================================================================
  // Human decisions and antibodies
  // =========================================================================

  /**
   * A human decided an escalated (or queued) proposal. Approvals mark the detectors that fired as
   * not useful; rejections mark them useful, revoke the region's autonomy, and mint an antibody.
   */
  onHumanDecision(p: Proposal, d: "approve" | "reject" | "return", reason: string, by: string): void {
    const policy = this.store.policy();
    const now = Date.now();
    const out = this.store.outcome(p.id);
    const region = out?.region ?? this.host.proposalRegion(p.id);
    for (const id of out?.detectors ?? []) {
      if (!id.startsWith("clef:") && !id.startsWith("antibody:")) continue;
      if (d === "approve") this.store.markDetector(id, { notUseful: 1 }, policy.probation, now);
      if (d === "reject") this.store.markDetector(id, { useful: 1 }, policy.probation, now);
    }
    this.store.recordHuman(p.id, region, p.headSha, d, now);
    if (d === "reject") {
      this.store.revokeAutonomy(region, `rejected ${p.id} by ${by}`, now);
      // Minting calibrates on Clef and commits to trunk, so it needs the reflex arc.
      if (reason.trim() && this.enabled()) this.host.waitUntil(this.mintAntibody(p, reason.trim(), by).catch((err) => console.error(`antibody from ${p.id} failed: ${errorText(err)}`)));
    }
    this.publishMetrics(policy);
  }

  /**
   * Mint an antibody from a human rejection: matcher from the rejected change, the reason rephrased
   * as a yes/no question, a threshold calibrated on the rejected change itself; stored in SQLite and
   * committed to trunk as .firetrident/antibodies/<id>.json with a lineage note pointing at the
   * rejected proposal.
   */
  async mintAntibody(p: Proposal, reason: string, by: string): Promise<StoredAntibody | null> {
    const policy = this.store.policy();
    const colony = this.host.colony();
    const intent = this.host.intent(p.intentId);
    const ai = this.ai();
    let state = parseState(this.store.outcome(p.id)?.state);
    let added: string[];
    if (state) {
      const files = ((state.diff as { files?: Array<{ hunks?: string }> } | undefined)?.files ?? []).map((f) => f.hunks ?? "");
      added = files.flatMap(addedFromHunks);
    } else {
      const innate = await runInnateChecks(p, { env: this.host.env, colony, intent, rules: this.host.rules(), baseBlobs: (sha, paths) => this.host.trunk().baseBlobs(sha, paths) });
      const diffs: FileDiff[] = innate.files.map((f) => fileDiff(f.path, f.before, f.after, { binary: f.binary, unreadable: f.unreadable }));
      added = diffs.flatMap((d) => d.addedLines);
      state = reflexState({ intent: intent ?? { title: p.declared.summary, why: "" }, footprint: intent?.footprint ?? p.declared.footprint, residual: innate.residual, diffs, antibodies: [] });
    }
    const model = pickSecondOpinion(this.host.agent(p.agentId)?.model, policy.secondOpinionModels);
    const rephrased = this.host.env.AI ? await rephraseAsQuestion(ai, model, reason, intent?.title ?? p.declared.summary).catch(() => null) : null;
    const question = cleanQuestion(rephrased) ?? fallbackQuestion(reason);
    let pSelf: number | null = null;
    if (this.host.env.AI) {
      try {
        const r = await askClef(ai, policy.reflexModel, state, { self: { type: "noul", instructions: question, criteria: { true: "Yes: this change has that problem", false: "No: it does not" } } });
        pSelf = noul(r.answers, "self");
        if (!Number.isFinite(pSelf)) pSelf = null;
      } catch {
        pSelf = null;
      }
    }
    const { threshold, state: abState } = calibrateThreshold(pSelf);
    const now = Date.now();
    const ab: Antibody = {
      id: newId("ab_"),
      colonyId: colony.id,
      origin: "human-reject",
      matcher: deriveMatcher(p.writeSet.map((w) => w.path), added),
      question,
      threshold,
      createdAt: now,
      createdFrom: p.id,
      hits: 0,
      falsePositives: 0,
    };
    this.store.putAntibody(ab, abState);
    this.host.bump("antibodies", 1);
    this.host.emit([{ t: "metric", at: now, name: "antibodies", value: this.store.antibodies().length }]);
    console.log(`antibody ${ab.id} from ${p.id}: "${question}" threshold ${threshold} (self ${pSelf ?? "n/a"}), ${abState}`);

    // Commit it to trunk, where it travels with the code.
    const path = antibodyPath(ab.id);
    const agent = this.host.agent(p.agentId);
    const decisions = this.host.decisionsFor(p.id).map((d) => ({ kind: d.kind, layer: d.layer, p: d.p, action: d.action }));
    const note: LineageNote & Record<string, unknown> = {
      schema: "firetrident.lineage/v1",
      landingId: "",
      colonyId: colony.id,
      proposals: [
        {
          id: p.id,
          agentId: p.agentId,
          agentKind: agent?.kind ?? "external",
          ...(agent?.model ? { model: agent.model } : {}),
          intent: { id: p.intentId, title: intent?.title ?? p.declared.summary, why: intent?.why ?? "", ...(intent?.ruleId ? { ruleId: intent.ruleId } : {}) },
          writeSet: p.writeSet,
          readSet: p.readSet,
          decisions,
          evidence: p.evidence,
        },
      ],
      system: { kind: "antibody", antibody: ab.id, path, rejected: p.id, reason, by, question, threshold },
    };
    const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
    const subject = oneLine(`Antibody ${ab.id}: ${question}`).slice(0, 72);
    const message = `${subject}\n\nLearned from rejected proposal ${p.id} (${oneLine(by)}): ${oneLine(reason).slice(0, 500)}\n\nFT-Antibody: ${ab.id}\nFT-Rejected-Proposal: ${p.id}\nFT-Intent: ${p.intentId}`;
    try {
      const landing = await this.host.trunk().systemCommit({ files: [{ path, content: antibodyFile(ab, { reason, by, proposalId: p.id, ...(intent ? { intentTitle: intent.title } : {}) }) }], message, note });
      this.store.setAntibodyLanding(ab.id, path, landing.id);
      await this.host.systemCommitted(landing);
    } catch (err) {
      console.error(`antibody ${ab.id} not committed to trunk: ${errorText(err)}`);
    }
    return this.store.antibody(ab.id);
  }

  /** Load antibodies committed to trunk that this colony's store does not know (once per instance). */
  private syncAntibodies(): Promise<void> {
    this.syncing ??= (async () => {
      try {
        const colonyId = this.host.colony().id;
        const listing = await this.host.trunk().files();
        for (const f of listing.filter((x) => x.path.startsWith(`${ANTIBODY_DIR}/`) && x.path.endsWith(".json")).slice(0, 200)) {
          const id = f.path.slice(ANTIBODY_DIR.length + 1, -".json".length);
          if (this.store.antibody(id)) continue;
          const text = await this.host.trunk().readFile(f.path);
          const ab = text ? parseAntibodyFile(text, colonyId) : null;
          if (ab) this.store.putAntibody(ab, "active", { path: f.path });
        }
      } catch (err) {
        console.warn(`antibody sync from trunk failed: ${errorText(err)}`);
      }
    })();
    return this.syncing;
  }

  /** Mark a detector useful or not (UI feedback); returns its record. */
  detectorFeedback(id: string, useful: boolean): DetectorStats {
    if (!/^(clef:[a-z_]+|antibody:[\w.-]+)$/.test(id)) throw ftError(400, `unknown detector ${id}`);
    const policy = this.store.policy();
    this.store.markDetector(id, useful ? { useful: 1 } : { notUseful: 1 }, policy.probation, Date.now());
    const d = this.store.detectors([id])[0];
    if (!d) throw ftError(404, `unknown detector ${id}`);
    return d;
  }

  /** Antibodies, detectors, autonomy, alert budget and the decision tally. */
  immune(): Record<string, unknown> {
    const policy = this.store.policy();
    return {
      enabled: this.enabled(),
      policy,
      antibodies: this.store.antibodies().map((s) => ({ ...s.antibody, state: s.state, path: s.path, landingId: s.landingId })),
      detectors: this.store.detectors(),
      autonomy: this.store.autonomyTable(policy.autonomyAfter),
      alerts: { lastHour: this.store.escalationsSince(Date.now() - HOUR_MS), budget: policy.alertsPerHour },
      decisions: this.store.tally(),
    };
  }

  // =========================================================================
  // Vaccination meter
  // =========================================================================

  /**
   * Generate `count` sealed bad proposals (round-robin over `classes`) from real rule intents,
   * push their content to the quarantine repo, and send each through the normal propose path as
   * the colony's vaccine agent. Outcomes arrive as the pipeline decides them.
   */
  async vaccinate(opts: { count?: number; classes?: string[] }): Promise<VaccinationResult> {
    if (!this.enabled()) throw ftError(409, "the decide pipeline is off (no AI binding, or the policy disables it)");
    const count = Math.max(1, Math.min(MAX_VACCINES, Math.floor(Number(opts.count) || 8)));
    const classes = (opts.classes ?? []).filter((c): c is VaccineClass => (VACCINE_CLASSES as readonly string[]).includes(c));
    const order = classes.length > 0 ? classes : [...VACCINE_CLASSES];
    const colony = this.host.colony();
    const rules = this.host.rules();
    const trunk = this.host.trunk();
    const listing = await trunk.files();
    const known = new Set(listing.map((f) => f.path));
    let targets = this.host.vaccineTargets(count * 2).filter((t) => t.footprint.length === 1 && known.has(t.footprint[0]!));
    if (targets.length === 0) {
      targets = listing
        .filter((f) => /^src\/.*\.[cm]?[jt]sx?$/.test(f.path) && !isTestPath(f.path) && f.size < 64_000)
        .slice(0, count)
        .map((f) => ({ title: `Small cleanup in ${f.path}`, why: "Keep the module tidy.", footprint: [f.path] }));
    }
    if (targets.length === 0) throw ftError(409, "no source files to build vaccines from");
    const tests = listing.filter((f) => isTestPath(f.path) && /\.[cm]?[jt]sx?$/.test(f.path) && f.size < 128_000).map((f) => f.path);
    const manifestPath = listing.find((f) => f.path === "package.json")?.path;
    const workflowPath = listing.find((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f.path))?.path;

    const cache = new Map<Path, string | null>();
    const read = async (path: Path | undefined): Promise<SourceFile | undefined> => {
      if (!path) return undefined;
      if (!cache.has(path)) cache.set(path, await trunk.readFile(path).catch(() => null));
      const content = cache.get(path);
      return typeof content === "string" ? { path, content } : undefined;
    };
    const manifest = await read(manifestPath);
    const workflow = await read(workflowPath);

    const changes: Array<VaccineChange & { slot: number }> = [];
    const skipped: VaccinationResult["skipped"] = [];
    for (let i = 0; i < count; i++) {
      const cls = order[i % order.length]!;
      const t = targets[i % targets.length]!;
      const file = await read(t.footprint[0]);
      if (!file) {
        skipped.push({ cls, reason: `cannot read ${t.footprint[0]}` });
        continue;
      }
      const stem = (file.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
      const testPath = tests.find((x) => (x.split("/").pop() ?? "").startsWith(`${stem}.`)) ?? tests[i % Math.max(1, tests.length)];
      const test = cls === "test-weakened" ? await read(testPath) : undefined;
      const rule = t.ruleId ? (rules.find((r) => r.id === t.ruleId) ?? null) : null;
      const v = makeVaccine(cls, Math.floor(i / order.length), { intent: t, file, rule }, { ...(test ? { test } : {}), ...(manifest ? { manifest } : {}), ...(workflow ? { workflow } : {}) });
      if (v) changes.push({ ...v, slot: i });
      else skipped.push({ cls, reason: `could not build ${VACCINE_LABELS[cls]} from ${file.path}` });
    }
    if (changes.length === 0) throw ftError(409, `no vaccines could be built: ${skipped.map((s) => s.reason).join("; ")}`);

    const agentId = await this.host.vaccineAgent();
    const batch = newId("vb_");
    const now = Date.now();
    const intentIds = changes.map((c) => {
      const id = this.host.sealedIntent({ title: c.intent.title, why: c.intent.why, footprint: c.intent.footprint, ...(c.intent.ruleId ? { ruleId: c.intent.ruleId } : {}), agentId });
      this.store.registerVaccine(id, c.cls, batch, now);
      return id;
    });
    const pushed = await pushQuarantine(
      this.host.env,
      colony.id,
      changes.map((c, j) => ({
        files: c.files.map((f) => ({ path: f.path, content: f.after })),
        message: `${c.intent.title.replace(/\s+/g, " ").slice(0, 72)}\n\nFT-Intent: ${intentIds[j]}\nFT-Agent: ${agentId}\n`,
      })),
    );
    const allPaths = [...new Set(changes.flatMap((c) => c.files.map((f) => f.path)))];
    const current = await trunk.blobsFor(allPaths);
    const out: VaccinationResult["vaccines"] = [];
    for (const [j, c] of changes.entries()) {
      const commit = pushed.commits[j]!;
      const intentId = intentIds[j]!;
      try {
        const proposal = await this.host.propose({
          colonyId: colony.id,
          intentId,
          agentId,
          workspace: pushed.repo,
          baseSha: colony.trunkSha,
          headSha: commit.head,
          writeSet: c.files.map((f) => ({ path: f.path, blob: commit.blobs[f.path] ?? null })),
          readSet: c.files.map((f) => ({ path: f.path, blob: current[f.path] ?? null })),
          declared: { footprint: c.intent.footprint, summary: c.summary },
          evidence: { checks: c.files.filter((f) => c.intent.footprint.includes(f.path)).map((f) => ({ name: `recheck ${f.path}`, ok: true, ms: 1 })), notVerified: c.notVerified },
        });
        this.store.linkVaccine(intentId, proposal.id);
        out.push({ proposalId: proposal.id, cls: c.cls, paths: c.files.map((f) => f.path) });
      } catch (err) {
        this.store.settleVaccine(intentId, "error", null, `propose failed: ${errorText(err)}`, Date.now());
        skipped.push({ cls: c.cls, reason: `propose failed: ${errorText(err)}` });
      }
    }
    this.host.bump("vaccines", out.length);
    return { batch, requested: count, started: out.length, vaccines: out, skipped };
  }

  /** Recall per class with Wilson 95% intervals, plus the most recent vaccines. */
  vaccineReport(): Record<string, unknown> {
    const rows = this.store.vaccines();
    const report = recallReport(rows.map((r) => ({ cls: r.cls, outcome: r.outcome, layer: r.layer })));
    return {
      classes: Object.fromEntries(Object.entries(report.classes).map(([cls, row]) => [cls, { label: VACCINE_LABELS[cls as VaccineClass] ?? cls, ...row }])),
      overall: report.overall,
      recent: rows.slice(0, 50).map((r) => ({ proposalId: r.proposalId, cls: r.cls, batch: r.batch, outcome: r.outcome, layer: r.layer, reason: r.reason, at: r.decidedAt ?? r.createdAt })),
    };
  }

  /** Publish recall per class (and overall) as metrics. */
  private publishVaccineMetrics(): void {
    const report = recallReport(this.store.vaccines().map((r) => ({ cls: r.cls, outcome: r.outcome, layer: r.layer })));
    const now = Date.now();
    const events: ColonyEvent[] = [];
    const put = (name: string, value: number): void => {
      this.host.setMetric(name, value);
      events.push({ t: "metric", at: now, name, value });
    };
    for (const [cls, row] of [...Object.entries(report.classes), ["all", report.overall] as const]) {
      if (row.n === 0 && cls !== "all") continue;
      put(`vaccine.${cls}.n`, row.n);
      put(`vaccine.${cls}.caught`, row.caught);
      put(`vaccine.${cls}.recall`, row.recall);
      put(`vaccine.${cls}.lo`, row.lo);
      put(`vaccine.${cls}.hi`, row.hi);
    }
    this.host.emit(events);
  }
}

function parseState(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
