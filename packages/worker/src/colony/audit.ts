import type { Colony, ColonyEvent, Evidence, FileVersion, Id, Intent, Landing, Path, Proposal, RepoRef, Rule, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import {
  AUDIT_EVERY,
  AUDIT_LAYER_LABEL,
  AUDIT_VERDICTS,
  AUDIT_WHEN_EMPTY,
  DRIFT_WEEKS,
  auditKey,
  auditLine,
  auditMeasures,
  auditPick,
  confirmingLayer,
  interleave,
  landedByText,
  reviewerDrift,
  type AuditLayer,
  type AuditMeasure,
  type AuditMeasures,
  type AuditVerdict,
  type OutcomeOf,
  type ReviewerDrift,
} from "../decide/audit.ts";
import { AuditStore, type AuditRow } from "../decide/auditstore.ts";
import {
  CANARIES_PER_DAY,
  CANARY_BATCH,
  CANARY_TARGETS,
  MAX_OPEN_CANARIES,
  canaryDraw,
  canaryMeasures,
  canaryReveal,
  canarySeed,
  pickCanary,
  type CanaryMeasures,
  type CanaryOutcome,
  type CanaryTarget,
} from "../decide/canary.ts";
import { scanDanger, type DangerAllowance } from "../decide/danger.ts";
import type { ProposeInput } from "../decide/engine.ts";
import { pushQuarantine, type QuarantineCommit } from "../decide/quarantine.ts";
import { buildReviewView } from "../decide/review.ts";
import type { DecideStore } from "../decide/store.ts";
import { isTestPath } from "../decide/signals.ts";
import { VACCINE_LABELS, type VaccineClass } from "../decide/vaccine.ts";
import { errorText, ftError } from "./errors.ts";
import { bindingReader, runInnateChecks, type BlobReader } from "./innate.ts";

/**
 * The audit sample, the baseline stream and the blind canaries for one colony (decide/audit.ts, decide/canary.ts):
 * ColonyDO calls in at a landing (sample it), at the review queue (show audit items among the escalations), at an
 * escalation (maybe draw a canary), and at a person's decision (a canary is revealed and scored instead of decided).
 * Nothing here holds a landing: sampling happens after the landing is recorded, and every failure is logged and left.
 */

/** What the audit needs from its colony (implemented by ColonyDO). */
export interface AuditHost {
  env: Env;
  sql: SqlStorage;
  /** The decide engine's store: its policy, outcomes, vaccine registry and earned autonomy. */
  decide(): DecideStore;
  colony(): Colony;
  proposal(id: Id): Proposal | null;
  intent(id: Id): Intent | null;
  rules(): Rule[];
  /** A landing the colony recorded, or null once pruned. */
  landing(id: Id): Landing | null;
  trunk(): {
    baseBlobs(sha: Sha, paths: Path[]): Promise<FileVersion[]>;
    blobsFor(paths: Path[]): Promise<Record<Path, Sha | null>>;
    readFile(path: Path): Promise<string | null>;
    files(): Promise<Array<{ path: Path; size: number; blob: Sha }>>;
  };
  waitUntil(p: Promise<unknown>): void;
  publish(events: ColonyEvent[]): void;
  /** Undo one proposal of a landing (ColonyDO.revertProposal): a person's revert, guarded like one. */
  revert(landingId: Id, p: { proposal: Id; reason: string; by: string }): Promise<{ landing: Landing }>;
  /** Seal a proposal: rejected with the reason, its intent abandoned, no lane and no field effects (ColonyDO.sealProposal). */
  seal(proposalId: Id, reason: string, evidence: Evidence): void;
  /** The colony's canary agent (registered on first use). */
  canaryAgent(): Promise<Id>;
  /** Rule intents a canary can copy (title, why, footprint), open ones first. */
  vaccineTargets(limit: number): Array<{ title: string; why: string; footprint: Path[]; ruleId?: Id }>;
  /** A claimed intent for the canary agent with no field effects, sealed like a vaccine's. */
  sealedIntent(i: { title: string; why: string; footprint: Path[]; ruleId?: Id; agentId: Id }): Id;
  propose(input: ProposeInput): Promise<Proposal>;
  /** Commit a canary's content to the quarantine repo (decide/quarantine.ts); tests replace it. */
  push?(env: Env, colonyId: Id, changes: Array<{ files: Array<{ path: Path; content: string }>; message: string }>): Promise<{ repo: RepoRef; commits: QuarantineCommit[] }>;
  /** Blob reads for the audit card's change (innate.ts bindingReader); tests replace it. */
  read?: BlobReader;
}

/** An audit item's fields on its review queue item (the proposal as it landed, plus these). */
export interface AuditItem {
  kind: "audit";
  layer: AuditLayer;
  /** How the layer is named: "a deterministic proof", "earned autonomy", ... */
  label: string;
  rule: string;
  /** "Already landed by D3 innate+proof (a deterministic proof)." */
  landedBy: string;
  landingId: Id;
  landedAt: number;
  queuedAt: number;
}

/** What a person's answer to an audit item did. */
export interface AuditAnswer {
  proposalId: Id;
  verdict: AuditVerdict;
  layer: AuditLayer;
  rule: string;
  /** The region whose earned autonomy the answer took back (an earned-autonomy landing that should not have landed). */
  revoked?: string;
  /** "Should not have landed": the revert, done (`landingId`), refused (`error`), or offered (`command`, `route`). */
  revert?: { landingId?: Id; error?: string; command?: string; route?: string };
  sentence: string;
}

/** A canary a person decided: revealed in the decision's answer. */
export interface CanaryAnswer {
  canary: { proposalId: Id; outcome: CanaryOutcome; cls: string; label: string; sentence: string };
}

/** The audit's measures (GET /api/colonies/:id/metrics `audit`, GET /api/colonies/:id/audit). */
export interface AuditReport extends AuditMeasure {
  rate: number;
  /** The baseline stream: one audit item after every this many escalations. */
  every: number;
  /** When the first landing without a person was counted (null before any). */
  since: number | null;
  line: string;
  layers: AuditMeasures["layers"];
  canaries: CanaryMeasures;
  reviewers: ReviewerDrift;
}

/** The decides report's line (GET /api/colonies/:id/decides `audit`). */
export interface AuditSummary {
  line: string;
  rate: number;
  landed: number;
  audited: number;
  wrong: number;
  lo: number;
  hi: number;
  pending: number;
  canaries: string;
}

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
/** Audit cards whose change is built on a queue read, at most (the rest on later reads). */
const VIEW_BUILDS = 2;
/** Audit items one queue read carries, at most. */
const MAX_QUEUE_AUDITS = 50;

const oneLine = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The audit and canaries of one colony. */
export class ColonyAudit {
  private tables: AuditStore | null = null;
  /** A canary is being built: no second one starts meanwhile. */
  private building = false;
  /** Cards whose change is being built now. */
  private readonly viewing = new Set<Id>();

  constructor(private readonly host: AuditHost) {}

  /** The tables, made after the decide store's (the canary reads join its vaccine registry). */
  get store(): AuditStore {
    if (this.tables) return this.tables;
    this.host.decide();
    return (this.tables = new AuditStore(this.host.sql));
  }

  // =========================================================================
  // The audit sample
  // =========================================================================

  /**
   * A landing was recorded: count each of its changes that landed without a person under its confirming layer, and put
   * the ones the stratified sample takes in the audit queue. Never throws: the landing is already done.
   */
  landed(l: Landing, proposals: readonly Proposal[], now = Date.now()): void {
    try {
      const decide = this.host.decide();
      const rate = decide.policy().auditRate;
      for (const p of proposals) {
        if (decide.vaccineByIntent(p.intentId)) continue;
        const out = this.outcome(p.id);
        const confirmed = confirmingLayer(p, out);
        if (!confirmed) continue;
        const pick = auditPick(auditKey(l.id, p.id), rate, this.store.stratum(confirmed.layer, rate));
        this.store.count(confirmed.layer, rate, pick.pick, now);
        if (!pick.pick) continue;
        const added = this.store.add({
          proposalId: p.id,
          landingId: l.id,
          intentId: p.intentId,
          region: out?.region ?? ".",
          layer: confirmed.layer,
          rule: confirmed.rule,
          why: pick.why,
          landedAt: l.at ?? now,
          queuedAt: now,
        });
        if (added) this.host.waitUntil(this.buildView(p.id, l));
      }
    } catch (err) {
      console.warn(`audit sample of ${l.id} skipped: ${errorText(err)}`);
    }
  }

  /** The decide pipeline's outcome row of a proposal, with its region. */
  private outcome(proposalId: Id): (OutcomeOf & { region: string }) | null {
    const r = this.host.sql
      .exec<{ layer: string | null; action: string | null; human: string | null; region: string }>("SELECT layer, action, human, region FROM decide_outcomes WHERE proposal_id = ?", proposalId)
      .toArray()[0];
    return r ?? null;
  }

  /**
   * Keep the change an audit card shows: what landed against the commit it landed on (a text merge's blob in place of
   * the proposal's), read from its workspace and else from trunk, with its danger patterns, secrets masked.
   */
  private async buildView(proposalId: Id, landing?: Landing | null): Promise<void> {
    if (this.viewing.has(proposalId)) return;
    this.viewing.add(proposalId);
    try {
      const p = this.host.proposal(proposalId);
      if (!p || !this.store.needsView(proposalId)) return;
      const colony = this.host.colony();
      const l = landing ?? (p.landingId ? this.host.landing(p.landingId) : null);
      const merged = new Map((l?.merged ?? []).filter((m) => m.proposalId === p.id).map((m) => [m.path, m.blob]));
      const writeSet = p.writeSet.map((w) => (merged.has(w.path) ? { path: w.path, blob: merged.get(w.path)! } : w));
      let readSet = p.readSet;
      if (l?.parentSha) {
        try {
          readSet = await this.host.trunk().baseBlobs(l.parentSha, writeSet.map((w) => w.path));
        } catch {
          readSet = p.readSet;
        }
      }
      const base = this.host.read ?? bindingReader(this.host.env);
      const trunkRef = { namespace: colony.trunk.namespace, name: colony.trunk.name };
      // A landed blob lives in trunk too: read what the workspace no longer has from there.
      const read: BlobReader = async (where, blobs) => {
        const got = await base(where, blobs).catch(() => new Map<Sha, Uint8Array | null>());
        const missing = blobs.filter((b) => !got.get(b));
        if (missing.length === 0 || (where.namespace === trunkRef.namespace && where.name === trunkRef.name)) return got;
        const more = await base(trunkRef, missing).catch(() => new Map<Sha, Uint8Array | null>());
        for (const b of missing) got.set(b, more.get(b) ?? null);
        return got;
      };
      const intent = this.host.intent(p.intentId);
      const innate = await runInnateChecks(
        { ...p, writeSet, readSet },
        { env: this.host.env, colony, intent, rules: this.host.rules(), baseBlobs: (sha, paths) => this.host.trunk().baseBlobs(sha, paths), read },
      );
      const hits = scanDanger(
        innate.files.map((f) => ({ path: f.path, before: f.before, after: f.afterBlob === null ? null : (f.after ?? ""), deleted: f.afterBlob === null, opaque: f.afterBlob !== null && f.after === null })),
        intent ? { title: intent.title, why: intent.why, acceptance: intent.acceptance, source: intent.source } : null,
      );
      this.store.setView(proposalId, buildReviewView({ files: innate.files, danger: hits, residual: innate.residual }));
    } catch (err) {
      console.warn(`audit card of ${proposalId} not built: ${errorText(err)}`);
    } finally {
      this.viewing.delete(proposalId);
    }
  }

  /** One audit item as the review queue carries it: the proposal as it landed, `audit`, and its change when one was kept. */
  private item(row: AuditRow): Proposal | null {
    const p = this.host.proposal(row.proposalId);
    if (!p) return null;
    const audit: AuditItem = {
      kind: "audit",
      layer: row.layer,
      label: AUDIT_LAYER_LABEL[row.layer] ?? row.layer,
      rule: row.rule,
      landedBy: landedByText(row.layer, row.rule),
      landingId: row.landingId,
      landedAt: row.landedAt,
      queuedAt: row.queuedAt,
    };
    const review = this.store.view(row.proposalId);
    // An inline change's file texts stay out of the queue, as they do for escalations (the card shows its diff).
    const { contents: _contents, ...landed } = p;
    return Object.assign(landed, { audit }, review ? { review } : {});
  }

  /**
   * The baseline stream: the review queue with audit items among its escalations (decide/audit.ts interleave), oldest
   * audit item first. A card with no change kept yet has one built for a later read. The queue as it was when the audit
   * cannot be read.
   */
  queue(escalations: Proposal[]): Proposal[] {
    try {
      const want = escalations.length === 0 ? AUDIT_WHEN_EMPTY : Math.min(MAX_QUEUE_AUDITS, Math.ceil(escalations.length / AUDIT_EVERY) + 1);
      const rows = this.store.pending(want);
      const items = rows.map((r) => this.item(r)).filter((p): p is Proposal => p !== null);
      let builds = 0;
      for (const p of items) {
        if (!("review" in p) && builds++ < VIEW_BUILDS) this.host.waitUntil(this.buildView(p.id));
      }
      return interleave(escalations, items);
    } catch (err) {
      console.warn(`audit items left out of the review queue: ${errorText(err)}`);
      return escalations;
    }
  }

  /**
   * A person's answer to an audit item. "Should not have landed" needs a reason; it takes back the region's earned
   * autonomy when earned autonomy landed the change, and offers the revert (`ft revert`), or does it when `revert` is
   * true (a refused revert is said in the answer; the verdict stands).
   */
  async answer(proposalId: Id, a: { verdict: string; reason?: string; by?: string; revert?: boolean }): Promise<AuditAnswer> {
    const verdict = a.verdict as AuditVerdict;
    if (!(AUDIT_VERDICTS as readonly string[]).includes(verdict)) throw ftError(400, `verdict must be one of: ${AUDIT_VERDICTS.join(", ")}`);
    const row = this.store.get(proposalId);
    if (!row) throw ftError(404, `${proposalId} is not in the audit queue: only landings the audit sample took can be answered`);
    if (row.verdict !== null) throw ftError(409, `${proposalId} was already answered ${row.verdict} by ${row.by ?? "unknown"}`);
    const reason = oneLine(a.reason, 2_000);
    const wrong = verdict === "should-not-have-landed";
    if (wrong && !reason) throw ftError(400, "say why it should not have landed: the reason is recorded with the answer and given to the revert");
    if (!wrong && a.revert === true) throw ftError(400, "revert goes with should-not-have-landed: a change that was fine to land stays");
    const by = oneLine(a.by, 200) || "unknown";
    const now = Date.now();
    const revoke = wrong && row.layer === "autonomy";
    if (!this.store.answer(proposalId, { verdict, reason, by, at: now, revoked: revoke })) throw ftError(409, `${proposalId} was already answered`);
    const colony = this.host.colony();
    const label = AUDIT_LAYER_LABEL[row.layer] ?? row.layer;
    const out: AuditAnswer = { proposalId, verdict, layer: row.layer, rule: row.rule, sentence: "" };
    if (!wrong) {
      out.sentence = `Recorded as fine: ${proposalId} landed by ${row.rule} (${label}) and should have.`;
      this.publish(now);
      return out;
    }
    const parts = [`Recorded: ${proposalId} should not have landed by ${row.rule} (${label}).`];
    if (revoke) {
      this.host.decide().revokeAutonomy(row.region, `audit: ${proposalId} should not have landed (${by}): ${reason}`.slice(0, 500), now);
      out.revoked = row.region;
      parts.push(`Earned autonomy in ${row.region} is taken back: its changes need a proof, a model's approval or a person again until it earns it back.`);
    }
    if (a.revert === true) {
      try {
        const res = await this.host.revert(row.landingId, { proposal: proposalId, reason: `audit: should not have landed: ${reason}`, by });
        out.revert = { landingId: res.landing.id };
        this.store.setRevert(proposalId, { landingId: res.landing.id });
        parts.push(`Reverted as ${res.landing.id}: the files it wrote are back as they were, and its intent is declared again.`);
      } catch (err) {
        const error = errorText(err);
        out.revert = { error };
        this.store.setRevert(proposalId, { error });
        parts.push(`The revert was refused: ${error}. Revert what landed on top first, or undo it by hand.`);
      }
    } else {
      const command = `ft revert ${colony.id} ${proposalId} --reason ${JSON.stringify(reason)}`;
      out.revert = { command, route: `POST /api/colonies/${colony.id}/landings/${row.landingId}/revert {"reason": ..., "proposal": "${proposalId}"}` };
      parts.push(`To undo it: ${command}`);
    }
    out.sentence = parts.join(" ");
    this.publish(now);
    return out;
  }

  /** Tell live pages the audit moved (the review tab reads the queue again). */
  private publish(now: number): void {
    try {
      const m = this.measures(now);
      this.host.publish([
        { t: "metric", at: now, name: "audit.audited", value: m.audited },
        { t: "metric", at: now, name: "audit.pending", value: m.pending },
      ]);
    } catch (err) {
      console.warn(`audit metrics not published: ${errorText(err)}`);
    }
  }

  // =========================================================================
  // Blind canaries
  // =========================================================================

  /**
   * A change reached the human queue: with the colony's canaryRate on, its id's draw may start one canary (at most one
   * waiting at a time and CANARIES_PER_DAY a day). Vaccines and canaries never draw one. Never throws.
   */
  escalated(p: Pick<Proposal, "id" | "intentId">, now = Date.now()): void {
    try {
      const decide = this.host.decide();
      const rate = decide.policy().canaryRate;
      if (!(rate > 0) || this.building || decide.vaccineByIntent(p.intentId)) return;
      if (!canaryDraw(p.id, rate)) return;
      if (this.store.openCanaries() >= MAX_OPEN_CANARIES || this.store.canariesSince(now - DAY_MS) >= CANARIES_PER_DAY) return;
      this.building = true;
      this.host.waitUntil(
        this.injectCanary(p.id)
          .catch((err) => console.warn(`canary not made: ${errorText(err)}`))
          .finally(() => {
            this.building = false;
          }),
      );
    } catch (err) {
      console.warn(`canary draw for ${p.id} skipped: ${errorText(err)}`);
    }
  }

  /**
   * Build one canary and send it through the propose path as the colony's canary agent: a vaccine of a class the danger
   * scan sends to a person, sealed in the vaccine registry (batch "canary"), its content in the quarantine repo. The
   * decide pipeline puts it in the queue (decide/engine.ts). Returns its proposal id, or null when none could be built.
   */
  async injectCanary(trigger: string): Promise<Id | null> {
    const decide = this.host.decide();
    const policy = decide.policy();
    const colony = this.host.colony();
    const trunk = this.host.trunk();
    const listing = await trunk.files();
    const known = new Set(listing.map((f) => f.path));
    let targets = this.host.vaccineTargets(16).filter((t) => t.footprint.length === 1 && known.has(t.footprint[0]!));
    if (targets.length === 0) {
      targets = listing
        .filter((f) => /^src\/.*\.[cm]?[jt]sx?$/.test(f.path) && !isTestPath(f.path) && f.size < 64_000)
        .slice(0, 16)
        .map((f) => ({ title: `Small cleanup in ${f.path}`, why: "Keep the module tidy.", footprint: [f.path] }));
    }
    if (targets.length === 0) return null;
    const seed = canarySeed(trigger);
    const rules = this.host.rules();
    const built: CanaryTarget[] = [];
    for (let i = 0; i < Math.min(CANARY_TARGETS, targets.length); i++) {
      const t = targets[(seed + i) % targets.length]!;
      const content = await trunk.readFile(t.footprint[0]!).catch(() => null);
      if (typeof content !== "string") continue;
      built.push({ intent: t, file: { path: t.footprint[0]!, content }, rule: t.ruleId ? (rules.find((r) => r.id === t.ruleId) ?? null) : null });
    }
    const allowances: DangerAllowance[] = policy.dangerAllow.map((x) => ({ cls: x.cls, ...(x.paths ? { paths: x.paths } : {}), by: "policy" }));
    const pick = pickCanary(seed, built, allowances);
    if (!pick) return null;
    const c = pick.change;
    const agentId = await this.host.canaryAgent();
    const now = Date.now();
    const intentId = this.host.sealedIntent({ title: c.intent.title, why: c.intent.why, footprint: c.intent.footprint, ...(c.intent.ruleId ? { ruleId: c.intent.ruleId } : {}), agentId });
    // Sealed first: from here nothing can land it (the vaccine registry), whatever happens next.
    decide.registerVaccine(intentId, c.cls, CANARY_BATCH, now);
    this.store.addCanary(intentId, c.cls, trigger, now);
    try {
      const push = this.host.push ?? pushQuarantine;
      const pushed = await push(this.host.env, colony.id, [
        { files: c.files.map((f) => ({ path: f.path, content: f.after })), message: `${c.intent.title.replace(/\s+/g, " ").slice(0, 72)}\n\nFT-Intent: ${intentId}\nFT-Agent: ${agentId}\n` },
      ]);
      const commit = pushed.commits[0];
      if (!commit) throw new Error("the quarantine repo took no commit");
      const paths = c.files.map((f) => f.path);
      const current = await trunk.blobsFor(paths);
      const proposal = await this.host.propose({
        colonyId: colony.id,
        intentId,
        agentId,
        workspace: pushed.repo,
        baseSha: colony.trunkSha,
        headSha: commit.head,
        writeSet: c.files.map((f) => ({ path: f.path, blob: commit.blobs[f.path] ?? null })),
        readSet: paths.map((path) => ({ path, blob: current[path] ?? null })),
        declared: { footprint: c.intent.footprint, summary: c.summary },
        evidence: { checks: c.files.filter((f) => c.intent.footprint.includes(f.path)).map((f) => ({ name: `recheck ${f.path}`, ok: true, ms: 1 })), notVerified: c.notVerified },
      });
      decide.linkVaccine(intentId, proposal.id);
      this.store.linkCanary(intentId, proposal.id);
      return proposal.id;
    } catch (err) {
      const msg = errorText(err);
      decide.settleVaccine(intentId, "error", null, `canary not proposed: ${msg}`, Date.now());
      this.store.discardCanary(intentId, msg);
      throw err;
    }
  }

  /**
   * A person decided a proposal: when it is a canary, it is scored (a rejection or a return is a catch, an approval a
   * miss), sealed so it never lands, and revealed with a plain sentence; nothing else of a decision happens (no
   * antibody, no detector or autonomy change, no funnel). Null for any other proposal.
   */
  canaryDecision(p: Proposal, d: "approve" | "reject" | "return", reason: string, by: string): CanaryAnswer | null {
    const decide = this.host.decide();
    const vaccine = decide.vaccineByIntent(p.intentId);
    if (!vaccine || vaccine.batch !== CANARY_BATCH) return null;
    const row = this.store.canaryByIntent(p.intentId);
    const cls = row?.cls ?? vaccine.cls;
    const outcome: CanaryOutcome = d === "approve" ? "approved" : "caught";
    const now = Date.now();
    this.store.decideCanary(p.intentId, { proposalId: p.id, outcome, decision: d, by: oneLine(by, 200) || "unknown", reason: oneLine(reason, 2_000), at: now });
    const sentence = canaryReveal(outcome, d, cls);
    this.host.seal(p.id, `canary (sealed): ${sentence}`, p.evidence);
    this.publish(now);
    return { canary: { proposalId: p.id, outcome, cls, label: VACCINE_LABELS[cls as VaccineClass] ?? cls, sentence } };
  }

  // =========================================================================
  // Measures
  // =========================================================================

  /** Every audit number, the canaries' and people's decisions over time. */
  measures(now = Date.now()): AuditReport {
    const policy = this.host.decide().policy();
    const totals = this.store.totals();
    const m = auditMeasures(totals.seen, this.store.counts());
    return {
      ...m.overall,
      rate: policy.auditRate,
      every: AUDIT_EVERY,
      since: totals.since,
      line: auditLine(m.overall, policy.auditRate),
      layers: m.layers,
      canaries: canaryMeasures(this.store.canaries(), policy.canaryRate),
      reviewers: reviewerDrift(this.store.humanDecisions(now - DRIFT_WEEKS * WEEK_MS), now),
    };
  }

  /** The decides report's line and numbers. */
  summary(now = Date.now()): AuditSummary {
    const m = this.measures(now);
    return { line: m.line, rate: m.rate, landed: m.landed, audited: m.audited, wrong: m.wrong, lo: m.lo, hi: m.hi, pending: m.pending, canaries: m.canaries.line };
  }

  /** GET /api/colonies/:id/audit: the measures, the items waiting (by id) and the latest answers. Waiting canaries are never named. */
  report(now = Date.now()): AuditReport & { waiting: Array<{ proposalId: Id; layer: AuditLayer; rule: string; landingId: Id; queuedAt: number }>; answered: AuditRow[] } {
    return {
      ...this.measures(now),
      waiting: this.store.pending(100).map((r) => ({ proposalId: r.proposalId, layer: r.layer, rule: r.rule, landingId: r.landingId, queuedAt: r.queuedAt })),
      answered: this.store.answered(50),
    };
  }
}
