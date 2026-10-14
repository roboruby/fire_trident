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
  IntentSource,
  Landing,
  LineageNote,
  NameAssumption,
  Path,
  Proposal,
  Rule,
  Sha,
} from "@fire_trident/core";
import { newId, revalidationEnabled } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { prelandAlone, prelandReturn, prelandTexts, type PrelandOutcome } from "../certify/preland.ts";
import { runInnateChecks, type InnateResult } from "../colony/innate.ts";
import { errorText, ftError } from "../colony/errors.ts";
import { meteredAi, spendCounters } from "../colony/spend.ts";
import { acceptanceCheck, acceptanceFor } from "./acceptance.ts";
import { ANTIBODY_DIR, antibodyFile, antibodyPath, calibrateThreshold, cleanQuestion, deriveMatcher, fallbackQuestion, parseAntibodyFile, securityAntibody } from "./antibodies.ts";
import { addedFromHunks, fileDiff, type FileDiff } from "./diff.ts";
import { agentReason, gate, type GateVerdict, type ReflexSignals, type SecondOpinion } from "./gate.ts";
import { checkGoalConflict, type RemovedLineOwners } from "./goalconflict.ts";
import { applyAllowances, dangerLabels, scanDanger, triageDanger, whyAuthor, type DangerAllowance } from "./danger.ts";
import { CallLimiter } from "./limiter.ts";
import { candidatePaths, mechanicalCheck, nameAssumptionCandidates, nameAssumptions, proofAssumptions, type MechanicalResult } from "./mechanical.ts";
import { pickSecondOpinion, secondOpinionCandidates, type DecidePolicy } from "./policy.ts";
import { pushQuarantine } from "./quarantine.ts";
import { askedLines, checkAcceptance, type KeepSource } from "./quotes.ts";
import {
  askClef,
  askSecondOpinion,
  coverageText,
  isThrottled,
  noul,
  readReflex,
  reflexQuestions,
  reflexState,
  reflexSummary,
  rephraseAsQuestion,
  secondOpinionDiff,
  secondOpinionMessages,
  stateCoverage,
  type AiRunner,
  type ReflexInput,
} from "./reflex.ts";
import { buildReviewView } from "./review.ts";
import { maskNote } from "../trunk/mask.ts";
import { damageSignals, isTestPath, protectedHits } from "./signals.ts";
import { DecideStore, type DetectorStats, type StoredAntibody } from "./store.ts";
import { VACCINE_CLASSES, VACCINE_LABELS, VACCINE_OUTCOMES, makeVaccine, recallReport, recallSummary, type SourceFile, type VaccineChange, type VaccineClass } from "./vaccine.ts";

/**
 * The Decide prong's pipeline for one colony: innate checks, System 1 (Clef), the two-signal gate,
 * System 2 when needed, then the proposal moves on (lane, agent, or human queue). It also mints
 * antibodies from human rejections, keeps detector probation and the alert budget, and runs the
 * vaccination meter. ColonyDO hosts it and supplies the colony's state through DecideHost.
 */

/** Input of ColonyDO.recordDecision. */
/** Diff characters shown to reviewers per file: enough for a whole new module or test suite (the new-project spec's largest file is under 10 KB), so a complete file is never cut. */
const REVIEW_FILE_CHARS = 24_000;

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
  /** Goal conflicts (decide/undone.ts): the recent landings that wrote the lines a change removes. */
  removedLineOwners?: RemovedLineOwners;
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
  /**
   * Quoted acceptance's keep lines (FT_QUOTED_ACCEPTANCE, decide/acceptance.ts): the newest landing by an intent other
   * than `intentId` on these paths, with that intent's acceptance list; null when there is none. A host without it adds none.
   */
  keepAcceptance?(intentId: Id, paths: Path[]): KeepSource | null;
  /** Tests before landing (certify/preland.ts, FT_PRELAND): whether they cover a proposal (absent: never). */
  prelandCovers?(p: Proposal): boolean;
  /** Tests before landing: run the test files a proposal reaches (`texts`: its new files already read); null when they do not cover it. */
  preland?(p: Proposal, texts?: ReadonlyMap<Sha, string>): Promise<PrelandOutcome | null>;
  /** Spend per intent (FT_INTENT_SPEND, colony/intentspend.ts): one of the stage's model calls, for the proposal's intent, as it happens; a host without it counts none. */
  countIntentCall?(intentId: Id, layer: "review" | "judge", model: string, usage: { input?: number; output?: number } | null): void;
}

/** Decide runs in flight per colony. Most finish in the deterministic stage without a model call. */
const MAX_CONCURRENT = 64;
/** A proposal "checking" longer than this with no run in flight is restarted. */
const STUCK_MS = 120_000;
const HOUR_MS = 60 * 60_000;
/** Vaccines per call. */
const MAX_VACCINES = 64;
/** How long one proposal may wait for System 2 (slots, rate, throttling) before it counts as unavailable. */
const LLM_DEADLINE_MS = 90_000;
/** Throttled System 2 attempts per model before the next model is tried. */
const LLM_ATTEMPTS = 3;
/** Trunk paths asked per proposal for import resolution. */
const MAX_RESOLUTION_PATHS = 4_000;

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
  /** Admission for System 2 calls (concurrency, per-minute rate per model, cooldown after throttling). */
  /** Per-model rate, concurrency and throttling cooldowns for System 2 calls (contest judging shares it). */
  readonly limiter = new CallLimiter(8, 120);

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
    // Tests before landing (certify/preland.ts, FT_PRELAND): with review off, a change that came here only for its tests
    // runs them and goes on to its lane, or back to its agent when a test that passed on trunk fails with it.
    if (!vaccine && !this.enabled() && this.host.prelandCovers?.(p) === true && protectedHits(p.writeSet.map((w) => w.path), policy.protectedPaths ?? []).length === 0) {
      return prelandAlone(this.host, p);
    }
    // Who wrote the why decides what it may ask for and whether earned autonomy covers it. A sealed
    // vaccine copies a rule intent (or a platform-written cleanup), so it is judged as that intent would be.
    const source: IntentSource | null = intent ? (vaccine ? (intent.ruleId ? "rule" : "human") : intent.source) : null;
    const whyBy = whyAuthor(source);
    // After a security return on this intent, its proposals go to a person instead of a model.
    const probation = vaccine ? null : this.store.securityProbation(p.intentId);
    await this.syncAntibodies();

    // Innate checks, then what the change looks like and what it could damage.
    const innate = await runInnateChecks(p, { env: this.host.env, colony, intent, rules, baseBlobs: (sha, paths) => this.host.trunk().baseBlobs(sha, paths) });
    const diffs = innate.files.map((f) => fileDiff(f.path, f.before, f.after, { binary: f.binary, unreadable: f.unreadable, maxChars: REVIEW_FILE_CHARS }));
    const damage = damageSignals(
      innate.files.map((f, i) => ({ path: f.path, before: f.before, after: f.after, added: diffs[i]?.addedLines ?? [] })),
      innate.residual,
    );
    const paths = p.writeSet.map((w) => w.path);
    const added = diffs.flatMap((d) => d.addedLines);
    const matching = this.store.matchingAntibodies(paths, added, policy.maxAntibodies);

    // Danger patterns: fixed receptors over added lines and paths. Auth, secrets and unrequested
    // capabilities reach a human unless the policy or a tolerating antibody explicitly allows them.
    // Only an intent a person or a rule wrote can ask for a capability: never an agent-declared
    // intent, never a repair intent (it quotes test names agents wrote), never the proposal's summary.
    const allowances: DangerAllowance[] = [
      ...policy.dangerAllow.map((a) => ({ cls: a.cls, ...(a.paths ? { paths: a.paths } : {}), by: "policy" })),
      ...this.store.allowingAntibodies(paths, added).flatMap((a) => a.allows.map((cls) => ({ cls, paths: a.paths, by: `antibody ${a.id}` }))),
    ];
    const dangerHits = applyAllowances(
      scanDanger(
        innate.files.map((f) => ({ path: f.path, before: f.before, after: f.afterBlob === null ? null : (f.after ?? ""), deleted: f.afterBlob === null })),
        intent && source ? { title: intent.title, why: intent.why, acceptance: intent.acceptance, source } : null,
      ),
      allowances,
    );
    const danger = triageDanger(dangerHits);
    for (const cls of new Set([...danger.mustHuman, ...danger.signals].map((h) => h.cls))) this.host.bump(`decide.danger.${cls}`, 1);
    const dangerCheck: CheckResult = {
      name: "danger patterns",
      ok: danger.mustHuman.length === 0,
      ms: 0,
      detail:
        dangerHits.length === 0
          ? "no danger pattern in the added lines or the paths"
          : [
              danger.mustHuman.length > 0 ? `needs a human: ${dangerLabels(danger.mustHuman).join("; ")}` : "",
              danger.signals.length > 0 ? `danger signals: ${dangerLabels(danger.signals).join("; ")}` : "",
              danger.recorded.length > 0 ? `asked for by the intent: ${dangerLabels(danger.recorded).join("; ")}` : "",
            ]
              .filter(Boolean)
              .join(" | ")
              .slice(0, 1_500),
    };
    // CI and dependency hits are already damage through their sensitive paths.
    const dangerSignals = dangerLabels(danger.signals.filter((h) => h.cls !== "ci" && h.cls !== "dependency"));
    const dangerFacts = [...dangerLabels(danger.signals), ...dangerLabels(danger.recorded)].map((l) => `danger pattern (deterministic): ${l}`);

    // Goal conflict (FT_GOAL_CONFLICT, decide/goalconflict.ts): a change that undoes lines a recent landing wrote for
    // another intent waits for a person (rule P4). It fails open: the check's own failure never holds a change.
    const goal = vaccine ? null : await checkGoalConflict(this.host, p, innate.files, policy);

    // Deterministic stage: import resolution against the trunk tree and the mechanical proof. No model.
    // With policy.deterministic off the facts are still recorded (observed only), but nothing uses them.
    const observed = await this.mechanical(p, innate, rule, policy.commentProof);
    const mech = policy.deterministic ? observed : null;
    // The files those facts found: the trunk writer re-checks that they still exist when the change lands.
    // Name assumptions (the names it imports from trunk files) let it land over a read file that changed.
    const assumptions = proofAssumptions(observed.result.changes, new Set(p.writeSet.map((w) => w.path)));
    const relied = { ...(assumptions.length > 0 ? { assumptions } : {}), ...(observed.names.length > 0 ? { nameAssumptions: observed.names } : {}) };
    const clefStates = this.store.clefStates();
    // What each model layer is shown: its approval counts only when it saw every changed line.
    const seen = { reflex: stateCoverage(diffs), llm: secondOpinionDiff(diffs).coverage };
    const base = {
      innate: { ok: innate.ok, failures: innate.failures },
      damage,
      ...(mech ? { mechanical: { verdict: mech.result.verdict, reasons: mech.result.reasons } } : {}),
      danger: { mustHuman: dangerLabels(danger.mustHuman), signals: dangerSignals },
      protected: protectedHits(paths, policy.protectedPaths),
      ...(goal?.conflict ? { goalConflict: { reason: goal.conflict.reason } } : {}),
      antibodies: matching.length,
      autonomy: !vaccine && this.store.approvedLandings(region) >= policy.autonomyAfter,
      whyBy,
      coverage: {
        reflex: { complete: seen.reflex.complete, seen: `the reflex ${coverageText(seen.reflex)}` },
        llm: { complete: seen.llm.complete, seen: `the second opinion ${coverageText(seen.llm)}` },
      },
      probation: probation ? { classes: probation.classes } : null,
      alerts: { used: this.store.escalationsSince(Date.now() - HOUR_MS), max: policy.alertsPerHour },
      detectors: clefStates,
      policy,
    };
    const checks: CheckResult[] = [
      ...innate.checks,
      ...observed.result.checks.map((c, i) => ({ ...c, ms: i === 0 ? observed.ms : c.ms, ...(mech ? {} : { detail: `(observed only: policy.deterministic is off) ${c.detail ?? ""}`.slice(0, 1_000) }) })),
      dangerCheck,
      ...(goal?.check ? [goal.check] : []),
    ];
    let final: GateVerdict = gate(base);
    // Tests before landing (certify/preland.ts, FT_PRELAND): the test files the change reaches run before the gate decides,
    // unless it already goes back; a test that passed on trunk and fails with the change sends it back, before any model.
    const preland = vaccine || final.action === "return" ? null : ((await this.host.preland?.(p, prelandTexts(innate.files))) ?? null);
    if (preland) checks.push(preland.check);
    if (preland?.run.status === "failed") final = prelandReturn(preland.reason ?? preland.check.detail ?? "", final);
    let v1: GateVerdict | null = null;
    let reflex: ReflexSignals | null | undefined;
    let llm: SecondOpinion | null | undefined;
    let state: Record<string, unknown> | null = null;

    if (final.action === "screen") {
      // Quoted acceptance (FT_QUOTED_ACCEPTANCE, decide/acceptance.ts): the intent's acceptance lines and the keep lines
      // the second opinion answers one by one; null keeps today's rule.
      const acceptance = acceptanceFor(this.host, intent, innate.files, Boolean(vaccine));
      // System 1, given the deterministic facts.
      const input: ReflexInput = {
        intent: { title: intent?.title ?? (p.declared.summary || p.intentId), why: intent?.why ?? "", whyBy },
        rule,
        footprint: intent?.footprint ?? p.declared.footprint,
        residual: innate.residual,
        diffs,
        antibodies: matching.map((s) => s.antibody),
        ...((mech ? mech.result.facts : []).length + dangerFacts.length > 0 ? { facts: [...(mech ? mech.result.facts : []), ...dangerFacts] } : {}),
        ...(acceptance ? { acceptance } : {}),
      };
      state = reflexState(input);
      const skip = new Set(Object.entries(clefStates).filter(([, s]) => s === "off").map(([k]) => k));
      let clefMs = 0;
      let clefError = "";
      try {
        const r = await askClef(this.ai(), policy.reflexModel, state, reflexQuestions(input.antibodies, skip));
        reflex = readReflex(
          r.answers,
          matching.map((s) => ({ id: s.antibody.id, threshold: s.antibody.threshold, state: s.state, question: s.antibody.question, security: securityAntibody(s.antibody) })),
        );
        clefMs = r.ms;
        this.host.bump("decide.clef.tokens", r.tokens);
        // Per model too, for the colony's spend (colony/spend.ts).
        for (const [name, delta] of spendCounters("decide.clef", policy.reflexModel, { input: r.tokens })) this.host.bump(name, delta);
        // And for the proposal's intent (spend per intent, FT_INTENT_SPEND).
        this.host.countIntentCall?.(p.intentId, "review", policy.reflexModel, { input: r.tokens });
      } catch (err) {
        reflex = null;
        clefError = errorText(err);
      }
      v1 = gate({ ...base, reflex });
      final = v1;
      checks.push({
        name: `reflex: ${policy.reflexModel}`,
        ok: v1.action !== "escalate" && v1.detectors.length === 0,
        ms: clefMs,
        detail: reflex ? `${reflexSummary(reflex)}; confidence ${v1.confidence}; ${coverageText(seen.reflex)}` : `unavailable: ${clefError}`,
      });
      // Only decisions a model made go into the funnel; a proof that only needed antibody screening is not one.
      const d1 =
        v1.layer === "reflex"
          ? await this.host.recordDecision({
              kind: "triage",
              subject: p.id,
              layer: "reflex",
              answers: {
                head: p.headSha,
                model: policy.reflexModel,
                ...(reflex ? { reflex } : { error: clefError }),
                rule: v1.rule,
                reasons: v1.reasons,
                damage: v1.damage,
                confidence: v1.confidence,
                coverage: seen.reflex,
                ...(vaccine ? { vaccine: true } : {}),
              },
              p: v1.p,
              action: v1.action,
            })
          : null;

      // System 2: only when the deterministic stage was inconclusive and the reflex cannot act alone.
      if (v1.action === "consult") {
        const so = await this.secondOpinion(p, input, policy);
        llm = so.opinion;
        // Quoted acceptance: each line as the second opinion answered it, its quote looked for in the diff it was shown.
        const accepted = acceptance && llm ? checkAcceptance(acceptance, llm.acceptance, secondOpinionDiff(diffs).shown) : undefined;
        final = gate({ ...base, reflex, llm, ...(accepted ? { acceptance: accepted } : {}) });
        checks.push({
          name: `llm: ${so.model}`,
          ok: llm?.verdict === "approve",
          ms: so.ms,
          detail: llm ? `${llm.verdict}, needs_human ${llm.needsHuman}: ${llm.reason}; ${coverageText(seen.llm)}` : `unavailable: ${so.error}`,
        });
        if (accepted) checks.push(acceptanceCheck(accepted));
        await this.host.recordDecision({
          kind: "triage",
          subject: p.id,
          layer: "llm",
          answers: {
            head: p.headSha,
            model: so.model,
            ...(llm ? { verdict: llm } : { error: so.error }),
            rule: final.rule,
            reasons: final.reasons,
            damage: final.damage,
            coverage: seen.llm,
            ...(accepted ? { acceptance: accepted } : {}),
            ...(vaccine ? { vaccine: true } : {}),
          },
          p: final.p,
          action: final.action,
          ...(d1 ? { escalatedFrom: d1.id } : {}),
        });
      }
    }

    const now = Date.now();
    this.host.bump(`decide.${final.layer}.${final.action}`, 1);
    if (!vaccine && v1) this.probation(v1, final, llm, policy, now);
    this.store.recordOutcome({
      proposalId: p.id,
      region,
      head: p.headSha,
      layer: final.layer,
      action: final.action,
      risk: final.risk,
      detectors: final.detectors,
      vaccine: Boolean(vaccine),
      state: state ? JSON.stringify(state) : null,
      at: now,
    });

    // Evidence: innate and deterministic checks plus each model's answer, carried into the lineage note on landing.
    checks.push({
      name: "gate",
      ok: final.action === "land",
      ms: 0,
      detail: `${final.rule} → ${final.action} by ${final.layer} at head ${p.headSha.slice(0, 12)}${final.confirmations.length > 0 ? ` (confirmations: ${final.confirmations.join(" + ")})` : ""}: ${final.reasons.join("; ")}`.slice(0, 1_000),
    });
    const evidence = { ...p.evidence, checks: [...p.evidence.checks, ...checks], ...(preland ? { preland: preland.run } : {}) };

    // Both confirmations are bound to this head commit and write set: if either moved, nothing lands.
    const cur = this.host.proposal(p.id);
    if (!cur || cur.status !== "checking") return;
    if (cur.headSha !== p.headSha || JSON.stringify(cur.writeSet) !== JSON.stringify(p.writeSet)) {
      await this.host.updateProposals([{ id: p.id, patch: { status: "returned", reason: "head commit changed while it was being reviewed; propose again" } }]);
      return;
    }
    const reason = final.reasons.join("; ").slice(0, 1_500);
    if (vaccine) {
      // A vaccine stopped only because a model layer was down is not a catch: it is an error, left
      // out of recall. That is System 2 consulted and unavailable (outage, throttling, timeout), or
      // every model layer down.
      const blind = llm === null || (reflex === null && !llm && innate.ok && final.layer !== "deterministic");
      const outcome = blind ? "error" : final.action === "land" ? "missed" : final.action === "escalate" ? "escalated" : "returned";
      this.store.settleVaccine(vaccine.intentId, outcome, final.layer, reason, now);
      const verdict =
        outcome === "missed"
          ? "missed by every layer, discarded (it can never land)"
          : outcome === "error"
            ? "not judged (a model layer was unavailable), discarded"
            : outcome === "escalated"
              ? `sent to a person by ${final.layer} (a person's catch is not measured)`
              : `caught: returned by ${final.layer}`;
      this.host.seal(p.id, `vaccine ${vaccine.cls} (sealed): ${verdict}: ${reason}`, evidence);
      this.publishVaccineMetrics();
      return;
    }
    // A security finding (a return or an escalation) puts the intent on probation: its next
    // proposals go to a person instead of a model, so its agent cannot probe the reviewers.
    if (final.security && final.action !== "land") {
      this.store.markSecurityFinding(p.intentId, final.security, now);
      this.host.bump("decide.security.findings", 1);
    }
    if (final.action === "land") {
      await this.host.updateProposals([{ id: p.id, patch: { status: "ready", evidence, ...relied } }]);
    } else if (final.action === "escalate") {
      this.store.revokeAutonomy(region, `escalated ${p.id}`, now);
      // What the person sees: the change itself, its danger patterns and residual, secrets masked.
      try {
        this.store.putReview(p.id, buildReviewView({ files: innate.files, danger: dangerHits, residual: innate.residual }), now);
      } catch (err) {
        console.error(`review view of ${p.id} not stored: ${errorText(err)}`);
      }
      // A person's approval later lands the same proposal, so it keeps the assumptions too, and what it undoes for its lineage note.
      const undoes = goal?.conflict ? { undoes: goal.conflict.undoes } : {};
      await this.host.updateProposals([{ id: p.id, patch: { status: "escalated", reason: `escalated by ${final.layer}: ${reason}`, evidence, ...relied, ...undoes } }]);
    } else {
      // A security return tells its agent only the class; people read the full reasons in the
      // evidence and the decisions.
      await this.host.updateProposals([{ id: p.id, patch: { status: "returned", reason: agentReason(final, base.danger), evidence } }]);
    }
    this.publishMetrics(policy);
  }

  /**
   * The deterministic stage for one proposal: every candidate path its changed import specifiers
   * could resolve to is looked up in one TrunkDO.blobsFor call (the proposal's own writes layered
   * on top), then the mechanical proof runs, and the comment-only proof unless `commentProof` (the
   * policy's) is off. With assumption revalidation on for the colony
   * (FT_REVALIDATE), the same call also resolves every relative import of the written files, for the
   * name assumptions; when that lookup would be cut short, none are recorded.
   */
  private async mechanical(p: Proposal, innate: InnateResult, rule: Rule | null, commentProof: boolean): Promise<{ result: MechanicalResult; ms: number; names: NameAssumption[] }> {
    const t0 = Date.now();
    const files = innate.files.map((f) => ({ path: f.path, before: f.before, after: f.after, unreadable: f.unreadable, binary: f.binary }));
    const based = revalidationEnabled((this.host.env as unknown as { FT_REVALIDATE?: string }).FT_REVALIDATE, this.host.colony().id);
    const all = [...new Set([...candidatePaths(files), ...(based ? nameAssumptionCandidates(files) : [])])];
    const wanted = all.slice(0, MAX_RESOLUTION_PATHS);
    let trunk: Record<Path, Sha | null> = {};
    if (wanted.length > 0) {
      try {
        trunk = await this.host.trunk().blobsFor(wanted);
      } catch (err) {
        const why = `trunk tree unavailable: ${errorText(err)}`;
        return { result: { verdict: "inconclusive", reasons: [why], changes: [], facts: [], checks: [{ name: "deterministic: mechanical proof", ok: false, ms: 0, detail: `inconclusive: ${why}` }] }, ms: Date.now() - t0, names: [] };
      }
    }
    const writes = new Map(p.writeSet.map((w) => [w.path, w.blob !== null]));
    const existed = (path: Path): boolean => (trunk[path] ?? null) !== null;
    const exists = (path: Path): boolean => (writes.has(path) ? writes.get(path)! : existed(path));
    const names = based && all.length <= MAX_RESOLUTION_PATHS ? nameAssumptions(files, exists, existed) : [];
    return { result: mechanicalCheck({ files, residual: innate.residual, rule, innateOk: innate.ok, exists, existed, commentProof }), ms: Date.now() - t0, names };
  }

  /**
   * System 2 under admission control: a fast model from another family than the author's; on
   * throttling it backs off (the model cools down for everyone) and then tries the next model.
   * A proposal waits at most LLM_DEADLINE_MS; nothing else waits behind it.
   */
  private async secondOpinion(p: Proposal, input: ReflexInput, policy: DecidePolicy): Promise<{ opinion: SecondOpinion | null; model: string; ms: number; error: string }> {
    this.limiter.configure(policy.llmConcurrency, policy.llmPerMinute);
    const models = secondOpinionCandidates(this.host.agent(p.agentId)?.model, policy.secondOpinionModels);
    const messages = secondOpinionMessages(input, p.evidence.notVerified);
    const t0 = Date.now();
    const deadline = t0 + LLM_DEADLINE_MS;
    let error = "no second-opinion model configured";
    let last = models[0] ?? "";
    for (const model of models) {
      last = model;
      for (let attempt = 0; attempt < LLM_ATTEMPTS; attempt++) {
        const release = await this.limiter.acquire(model, deadline);
        if (!release) return { opinion: null, model, ms: Date.now() - t0, error: `no ${model} slot within ${LLM_DEADLINE_MS / 1000} s (rate limits)` };
        try {
          // Quoted acceptance asks for one answer per acceptance line (FT_QUOTED_ACCEPTANCE).
          const r = await askSecondOpinion(this.ai(), model, messages, undefined, askedLines(input.acceptance ?? []).length);
          this.host.bump("decide.llm.tokensIn", r.tokens.in);
          this.host.bump("decide.llm.tokensOut", r.tokens.out);
          // Per model too, for the colony's spend (colony/spend.ts).
          for (const [name, delta] of spendCounters("decide.llm", model, { input: r.tokens.in, output: r.tokens.out })) this.host.bump(name, delta);
          this.host.countIntentCall?.(p.intentId, "review", model, { input: r.tokens.in, output: r.tokens.out });
          return { opinion: r.opinion, model, ms: Date.now() - t0, error: "" };
        } catch (err) {
          error = errorText(err);
          if (!isThrottled(err)) break;
          this.host.bump("decide.llm.throttled", 1);
          this.limiter.cooldown(model, 2_000 * 2 ** attempt);
        } finally {
          release();
        }
      }
    }
    return { opinion: null, model: last, ms: Date.now() - t0, error };
  }

  /** Detector bookkeeping: fires, and a higher layer overruling a System 1 alarm counts as "not useful". */
  private probation(v1: GateVerdict, final: GateVerdict, llm: SecondOpinion | null | undefined, policy: DecidePolicy, now: number): void {
    const overruledByProof = new Set(final.overruled ?? []);
    const fired = new Set([...v1.detectors, ...final.detectors, ...overruledByProof].filter((d) => d.startsWith("clef:") || d.startsWith("antibody:")));
    for (const id of fired) {
      const overruled = overruledByProof.has(id) || (llm?.verdict === "approve" && final.action === "land");
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
   * not useful; rejections mark them useful and revoke the region's autonomy. A rejection an
   * antibody had already caught counts as a recurrence on that antibody; only a miss mints one.
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
      // The immune memory already knew this problem: count it again instead of minting a near-copy.
      const caught = (out?.detectors ?? []).filter((x) => x.startsWith("antibody:")).map((x) => x.slice("antibody:".length)).filter((id) => this.store.antibody(id) !== null);
      if (caught.length > 0) {
        for (const id of caught) this.store.recordRecurrence(id, p.id);
        console.log(`rejection of ${p.id} recurs on ${caught.join(", ")}: no new antibody`);
      } else if (reason.trim() && this.enabled()) {
        // Minting calibrates on Clef and commits to trunk, so it needs the reflex arc.
        this.host.waitUntil(this.mintAntibody(p, reason.trim(), by).catch((err) => console.error(`antibody from ${p.id} failed: ${errorText(err)}`)));
      }
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
    // Minting's calls (the rephrasing and the self-check) count in the colony's spend, per model (colony/spend.ts).
    const ai = meteredAi(this.ai(), "decide.antibody", (name, delta) => this.host.bump(name, delta));
    let state = parseState(this.store.outcome(p.id)?.state);
    let added: string[];
    if (state) {
      const files = ((state.diff as { files?: Array<{ hunks?: string }> } | undefined)?.files ?? []).map((f) => f.hunks ?? "");
      added = files.flatMap(addedFromHunks);
    } else {
      const innate = await runInnateChecks(p, { env: this.host.env, colony, intent, rules: this.host.rules(), baseBlobs: (sha, paths) => this.host.trunk().baseBlobs(sha, paths) });
      const diffs: FileDiff[] = innate.files.map((f) => fileDiff(f.path, f.before, f.after, { binary: f.binary, unreadable: f.unreadable, maxChars: REVIEW_FILE_CHARS }));
      added = diffs.flatMap((d) => d.addedLines);
      state = reflexState({
        intent: { title: intent?.title ?? p.declared.summary, why: intent?.why ?? "", whyBy: whyAuthor(intent?.source) },
        footprint: intent?.footprint ?? p.declared.footprint,
        residual: innate.residual,
        diffs,
        antibodies: [],
      });
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
    // Notes are public: the free text in this one (the intent, the evidence, the reason) is masked where it looks like a secret.
    const note: LineageNote & Record<string, unknown> = maskNote({
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
    });
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
      antibodies: this.store.antibodies().map((s) => ({ ...s.antibody, state: s.state, path: s.path, landingId: s.landingId, recurrences: s.recurrences, lastRecurrence: s.lastRecurrence })),
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

  /**
   * Recall per class with Wilson 95% intervals, plus the most recent vaccines. Returned (a model or
   * a check stopped it) is reported apart from escalated (sent to a person, whose catch is not
   * measured); errors (a model layer unavailable) are left out of recall.
   */
  vaccineReport(): Record<string, unknown> {
    const rows = this.store.vaccines();
    const report = recallReport(rows.map((r) => ({ cls: r.cls, outcome: r.outcome, layer: r.layer })));
    return {
      classes: Object.fromEntries(Object.entries(report.classes).map(([cls, row]) => [cls, { label: VACCINE_LABELS[cls as VaccineClass] ?? cls, ...row, summary: recallSummary(row) }])),
      overall: report.overall,
      summary: recallSummary(report.overall),
      outcomes: VACCINE_OUTCOMES,
      recent: rows.slice(0, 50).map((r) => ({ proposalId: r.proposalId, cls: r.cls, batch: r.batch, outcome: r.outcome, layer: r.layer, reason: r.reason, at: r.decidedAt ?? r.createdAt })),
    };
  }

  /**
   * Keep the review view of an escalated proposal that has none (escalated before views were kept):
   * the files, danger patterns and residual decide would have used, masked the same way. Returns
   * whether a view was written; a proposal no longer escalated, or one that has a view, is left alone.
   */
  async backfillReview(proposalId: Id): Promise<boolean> {
    const p = this.host.proposal(proposalId);
    if (!p || p.status !== "escalated" || this.store.reviewView(p.id)) return false;
    const intent = this.host.intent(p.intentId);
    const innate = await runInnateChecks(p, { env: this.host.env, colony: this.host.colony(), intent, rules: this.host.rules(), baseBlobs: (sha, paths) => this.host.trunk().baseBlobs(sha, paths) });
    const hits = scanDanger(
      innate.files.map((f) => ({ path: f.path, before: f.before, after: f.afterBlob === null ? null : (f.after ?? ""), deleted: f.afterBlob === null })),
      intent ? { title: intent.title, why: intent.why, acceptance: intent.acceptance, source: intent.source } : null,
    );
    this.store.putReview(p.id, buildReviewView({ files: innate.files, danger: hits, residual: innate.residual }), Date.now());
    return true;
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
      // Stopped by a model or a check, apart from sent to a person (not measured), and the vaccines not judged.
      put(`vaccine.${cls}.returned`, row.returned);
      put(`vaccine.${cls}.escalated`, row.escalated);
      put(`vaccine.${cls}.errors`, row.errors);
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
