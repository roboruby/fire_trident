import { revalidationEnabled } from "@fire_trident/core";
import type { Certification, ColonyEvent, FailingTest, Id, IntentEscalation, Path, Proposal, RedBrakeEnd, RedBrakeReport, Sha, StuckItem, TrunkHealth } from "@fire_trident/core";
import { isRedirect } from "./direction.ts";
import { STEPUP_MODEL, type ModelHint } from "./stepup.ts";
import { clip } from "./stuck.ts";

/**
 * The red brake (FT_RED_BRAKE: "on", or a comma-separated list of colony ids; off when absent). Certifying after landing
 * lets work stack on a broken trunk: in the measured contention run trunk went red about six minutes in, eleven more
 * changes landed while it stayed red, and the repair certification declared never landed. While the latest
 * certification of trunk is red and its repair intent is open, the brake puts the repair first and holds what would
 * build on the failure:
 *
 * - Take: the first agent that asks for work gets the open repair, whatever its region, its thresholds or other agents'
 *   claims (ColonyDO.takeFor), and the take asks for the stronger model class (repairHint, colony/stepup.ts).
 * - Hold: a change that turns ready and writes a file the failing test files load (their import closure at the red
 *   commit, as certification read it: the cone) waits here instead of going to its lane, and its agent is told so in
 *   its inbox. Changes outside the cone go on as before, and changes for the repair itself are never held.
 * - Release: held changes go to their lanes when trunk is green again or when no repair is open any more. Holding stops
 *   for the rest of the red episode after CEILING_MS of holding, when the repair's agent reports it to a person, or when
 *   the repair failed FAILURES times (the brake then sends it to a person with the failing tests), so the colony cannot
 *   wedge; those stops are reported as stuck work.
 *
 * Tables `red_brake_episodes` and `red_brake_holds` are made at the first red result seen with the flag on. With the flag
 * off nothing here runs, except that changes held before it was turned off go on to their lanes.
 */

/** Holding stops for the episode this long after it began. */
export const CEILING_MS = 15 * 60_000;
/** Changes for the repair that came back (or attempts given back) before the brake sends it to a person. */
export const FAILURES = 2;
/** While changes are held, the colony's alarm looks again at least this often (a report or a withdrawal is noticed without a take). */
export const RECHECK_MS = 30_000;
/** Files the cone keeps at most (certification reads at most 400 modules a run). */
export const CONE_MAX = 2_000;
/** Who the brake's escalation of a repair names as its reporter (the repair's own creator). */
export const BRAKE_BY = "certify";
/** Failing tests an episode keeps for the escalation's report, and paths a hold names. */
const FAILING_KEPT = 20;
const PATHS_NAMED = 5;
const ERROR_CHARS = 200;
const REASON_CHARS = 200;
const TITLE_CHARS = 100;
/** Ended episodes and released holds kept (the newest). */
const EPISODES_KEEP = 200;
const HOLDS_KEEP = 5_000;
/** Proposals of the repair read at most when counting its failures. */
const LOOKBACK = 20;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS red_brake_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, red_sha TEXT NOT NULL, red_at INTEGER NOT NULL, latest_sha TEXT NOT NULL, latest_at INTEGER NOT NULL,
    cone TEXT NOT NULL, failing TEXT NOT NULL, failing_n INTEGER NOT NULL DEFAULT 0, repair_id TEXT, holding_since INTEGER, stopped TEXT, stopped_at INTEGER,
    green_sha TEXT, green_at INTEGER, ended_at INTEGER, reserved INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS red_brake_holds (
    proposal_id TEXT PRIMARY KEY, episode INTEGER NOT NULL, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, paths TEXT NOT NULL,
    held_at INTEGER NOT NULL, released_at INTEGER, outcome TEXT)`,
  "CREATE INDEX IF NOT EXISTS red_brake_holds_open ON red_brake_holds(released_at)",
];

/** Whether FT_RED_BRAKE covers the colony: "on", or a comma-separated list that names it; off when absent. */
export function redBrakeEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** The cone: every file the failing test files load (each one's import closure, itself first), at most CONE_MAX. */
export function coneOf(files: readonly Path[], reach: ((file: Path) => Path[]) | null): Path[] {
  const out = new Set<Path>();
  for (const file of files) {
    for (const path of reach ? reach(file) : [file]) {
      if (out.size >= CONE_MAX) return [...out];
      if (typeof path === "string" && path !== "") out.add(path);
    }
  }
  return [...out];
}

/** The paths of a change's write set that the cone holds. */
export function meetsCone(p: Pick<Proposal, "writeSet">, cone: ReadonlySet<Path>): Path[] {
  const out: Path[] = [];
  for (const w of Array.isArray(p.writeSet) ? p.writeSet : []) if (typeof w?.path === "string" && cone.has(w.path) && !out.includes(w.path)) out.push(w.path);
  return out;
}

/** The take's model hint for a red trunk's repair: the stronger model class, whatever its returns (colony/stepup.ts). */
export function repairHint(returns: number): ModelHint {
  return {
    model: STEPUP_MODEL,
    returns: Number.isInteger(returns) && returns >= 0 ? returns : 0,
    reason: `Trunk is red and this intent is its repair, so this attempt asks for the stronger model class (${STEPUP_MODEL}).`,
    cause: "repair",
  };
}

/** A duration in words: "45 s", "6.1 min", "1.2 h". */
export function span(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 90 * 60) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** The p-th quantile of sorted numbers (nearest rank), or null over nothing. */
function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a change's agent is told when its change waits (a directive of kind "hold", in its inbox). */
export function holdMessage(paths: readonly Path[], redSha: Sha, repair: { id: Id; title: string } | null, untilMs: number): string {
  const named = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
  const waits = repair ? `the repair, intent ${repair.id} "${clip(repair.title, TITLE_CHARS)}"` : "the repair";
  return `Trunk is red in files your change touches (${named}): the tests that load them fail at ${redSha.slice(0, 7)}. Your change waits for ${waits}, and goes on to its lane when trunk is green again or within ${span(untilMs)}; there is nothing to do now.`;
}

/** Why held changes go on, as their agents are told. Null: no repair is open any more. */
export function releaseMessage(end: RedBrakeEnd | null, heldMs: number): string {
  const held = `after waiting ${span(heldMs)}`;
  switch (end) {
    case "green":
      return `Trunk is green again: your change goes on to its lane now, ${held}.`;
    case "ceiling":
      return `Trunk is still red after ${span(CEILING_MS)} of holding: your change goes on to its lane now, ${held}, and lands or comes back by the usual checks.`;
    case "escalated":
      return `The repair failed ${FAILURES} times and went to a person: your change goes on to its lane now, ${held}, though trunk may still be red in files it touches.`;
    case "reported":
      return `The repair's agent reported it to a person: your change goes on to its lane now, ${held}, though trunk may still be red in files it touches.`;
    case "off":
      return `The red brake was turned off for this colony: your change goes on to its lane now, ${held}.`;
    default:
      return `No repair is open for the red trunk any more: your change goes on to its lane now, ${held}.`;
  }
}

/** The report the brake leaves on a repair it sends to a person after it failed FAILURES times (`total`: failing tests in all). */
export function escalationReport(failures: number, reasons: readonly string[], redSha: Sha, failing: readonly FailingTest[], total = failing.length): string {
  const latest = reasons[0] ? ` The latest came back with: ${clip(reasons[0], REASON_CHARS)}` : "";
  const tests = failing.slice(0, 10).map((f) => clip(`${f.file} > ${f.name === f.file ? "(the file fails to load)" : f.name}${f.error ? `: ${f.error}` : ""}`, ERROR_CHARS + 120));
  const rest = Math.max(total, failing.length) - tests.length;
  const more = rest > 0 ? ` and ${rest} more` : "";
  return [
    `The repair failed ${failures} times (its changes came back or were given back).${latest}`,
    `Trunk is still red at ${redSha.slice(0, 7)}; failing tests: ${tests.length > 0 ? tests.join("; ") : "none named"}${more}.`,
    "A person decides: amend this intent with what the fix needs, dismiss the report so agents try again with your note as guidance, or withdraw it. The red brake stopped holding changes for this red trunk, so the colony goes on meanwhile.",
  ].join("\n");
}

/** What the brake needs from the colony. */
export interface RedBrakeHost {
  sql: SqlStorage;
  /** FT_RED_BRAKE covers the colony. */
  enabled(): boolean;
  now(): number;
  /** Put a held change that still waits into its region's lane (ColonyDO.enqueue). */
  enqueue(p: Proposal, region: string, priority: number): Promise<void>;
  /** Leave a notice in an agent's inbox (a directive of kind "hold"); returns the event to publish. */
  notice(agentId: Id, intentId: Id, message: string): ColonyEvent;
  publish(events: ColonyEvent[]): void;
  bump(name: string, delta: number): void;
  /** Make sure the colony's alarm fires by `at`. */
  wake(at: number): void;
  /** An intent stopped being offered (its report waits for a person): drop it from any candidate list takes share. */
  forget(intentId: Id): void;
  waitUntil(p: Promise<unknown>): void;
}

/** One red episode as the brake stores it (`red_brake_episodes`). */
export type BrakeEpisode = {
  id: number;
  red_sha: string;
  red_at: number;
  latest_sha: string;
  latest_at: number;
  cone: string;
  failing: string;
  failing_n: number;
  repair_id: string | null;
  holding_since: number | null;
  stopped: string | null;
  stopped_at: number | null;
  green_sha: string | null;
  green_at: number | null;
  ended_at: number | null;
  reserved: number;
};

interface RepairNow {
  id: Id;
  title: string;
  status: string;
  reported: boolean;
  createdAt: number;
  updatedAt: number;
}

const LIVE: ReadonlySet<string> = new Set(["open", "claimed", "proposed"]);
const ENDS: ReadonlySet<string> = new Set<RedBrakeEnd>(["green", "ceiling", "escalated", "reported", "off"]);

function parseList<T>(json: string | null, fallback: T[]): T[] {
  try {
    const v = JSON.parse(json ?? "") as unknown;
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

/** Runs the red brake for one colony (see the module comment). */
export class RedBrake {
  /** Whether the tables exist (null: not looked yet). */
  private ready: boolean | null = null;
  private coneCache: { key: string; set: Set<Path> } | null = null;
  /** When the alarm was last asked to fire (so a take does not ask on every call). */
  private armedFor = 0;
  /** With the flag off: nothing was left to let go, so later looks need not read the tables (until the flag is on again). */
  private quiet = false;

  constructor(private readonly host: RedBrakeHost) {}

  /** The colony was erased: its tables went with it. */
  reset(): void {
    this.ready = null;
    this.coneCache = null;
    this.armedFor = 0;
    this.quiet = false;
  }

  // Every entry point fails open: an error is logged and the colony goes on as if the brake were off at that moment.

  /**
   * A green or red certification was recorded. `reach` gives what a failing test file loads at the red commit (its
   * import closure, itself first), or is null when the run read no modules. Red opens or updates the episode (its cone,
   * failing tests and repair) and starts holding when a repair is open; green ends it and lets held changes go.
   */
  verdict(cert: Certification, reach: ((file: Path) => Path[]) | null): void {
    this.safe("verdict", undefined, () => this.verdictNow(cert, reach));
  }

  /** Look at the episode now: start holding, stop it (ceiling, report, two failures), or let held changes go. */
  sweep(now: number): void {
    this.safe("sweep", undefined, () => this.sweepNow(now));
  }

  /**
   * The repair the agent asking for work should take before anything else, or null: the brake is off or not holding,
   * or the repair is not open for taking (an agent holds it, or its report waits for a person).
   */
  first(now: number): Id | null {
    return this.safe("take", null, () => this.firstNow(now));
  }

  /**
   * A change just turned ready: should it wait for the repair instead of going to its lane? It waits when the brake
   * holds and its write set meets the cone, and it is not for the repair (`source` "certify"). The hold is recorded and
   * its agent's notice made; returns the events to publish with the change's, or null to let it go to its lane.
   */
  hold(p: Proposal, intent: { source: string } | null, now: number): ColonyEvent[] | null {
    return this.safe(`change ${p.id}`, null, () => this.holdNow(p, intent, now));
  }

  /** What /metrics serves as `redBrake`: undefined when the brake never ran in the colony and is off now (or cannot be read). */
  report(now: number): RedBrakeReport | undefined {
    return this.safe("report", undefined, () => this.reportNow(now));
  }

  private safe<T>(what: string, fallback: T, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      console.warn(`red brake: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }

  private verdictNow(cert: Certification, reach: ((file: Path) => Path[]) | null): void {
    const now = this.host.now();
    if (!this.host.enabled()) return this.off(now);
    if (cert.status !== "green" && cert.status !== "red") return;
    const at = typeof cert.finishedAt === "number" ? cert.finishedAt : now;
    if (cert.status === "green") {
      if (!this.tables(false)) return;
      const ep = this.open();
      if (!ep) return;
      const events: ColonyEvent[] = [];
      this.host.sql.exec("UPDATE red_brake_episodes SET green_sha = ?, green_at = ?, ended_at = ? WHERE id = ?", cert.trunkSha, at, now, ep.id);
      const toGreenMs = Math.max(0, at - ep.red_at);
      events.push({ t: "brake", at: now, action: "green", trunkSha: cert.trunkSha, toGreenMs, ...(ep.repair_id ? { repairId: ep.repair_id } : {}) });
      this.release("green", now, events);
      this.host.bump("brake.green", 1);
      this.host.publish(events);
      this.trim();
      return;
    }
    this.tables(true);
    const failing = (cert.failing ?? []).filter((f) => typeof f?.file === "string" && f.file !== "");
    const files = [...new Set(failing.map((f) => f.file))];
    const cone = coneOf(files, reach);
    const kept = failing.slice(0, FAILING_KEPT).map((f): FailingTest => ({ name: f.name, file: f.file, ...(f.error ? { error: clip(f.error, ERROR_CHARS) } : {}) }));
    // Failing tests in all (the result lists at most 50, the lost ones among them).
    const failingN = Math.max(failing.length, cert.counts ? cert.counts.fail + cert.counts.cancelled : 0);
    const ep = this.open();
    const repairId = cert.repairIntentId ?? this.openRepairId() ?? ep?.repair_id ?? null;
    if (!ep) {
      this.host.sql.exec(
        "INSERT INTO red_brake_episodes (red_sha, red_at, latest_sha, latest_at, cone, failing, failing_n, repair_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        cert.trunkSha,
        at,
        cert.trunkSha,
        at,
        JSON.stringify(cone),
        JSON.stringify(kept),
        failingN,
        repairId,
      );
    } else {
      this.host.sql.exec(
        "UPDATE red_brake_episodes SET latest_sha = ?, latest_at = ?, cone = ?, failing = ?, failing_n = ?, repair_id = ? WHERE id = ?",
        cert.trunkSha,
        at,
        JSON.stringify(cone),
        JSON.stringify(kept),
        failingN,
        repairId,
        ep.id,
      );
    }
    this.coneCache = null;
    this.sweepNow(now);
  }

  private sweepNow(now: number): void {
    if (!this.host.enabled()) return this.off(now);
    if (!this.tables(false)) return;
    const events: ColonyEvent[] = [];
    const ep = this.open();
    if (ep) this.step(ep, now, events);
    else if (this.unreleased() > 0) this.release(null, now, events);
    if (events.length > 0) this.host.publish(events);
  }

  private firstNow(now: number): Id | null {
    if (!this.host.enabled()) {
      this.off(now);
      return null;
    }
    if (!this.tables(false)) return null;
    const ep = this.open();
    if (!ep) return null;
    const events: ColonyEvent[] = [];
    const holding = this.step(ep, now, events);
    if (events.length > 0) this.host.publish(events);
    if (!holding || !ep.repair_id) return null;
    const rep = this.repair(ep.repair_id);
    return rep && rep.status === "open" && !rep.reported ? rep.id : null;
  }

  /** The repair went to the first agent that asked (ColonyDO.takeFor). */
  reserved(repairId: Id, agentId: Id, now: number): void {
    this.safe("reservation", undefined, () => this.reservedNow(repairId, agentId, now));
  }

  private reservedNow(repairId: Id, agentId: Id, now: number): void {
    if (!this.tables(false)) return;
    const ep = this.open();
    if (ep) this.host.sql.exec("UPDATE red_brake_episodes SET reserved = reserved + 1 WHERE id = ?", ep.id);
    this.host.bump("brake.reserved", 1);
    this.host.publish([{ t: "brake", at: now, action: "reserve", repairId, agentId, ...(ep ? { trunkSha: ep.latest_sha } : {}) }]);
  }

  private holdNow(p: Proposal, intent: { source: string } | null, now: number): ColonyEvent[] | null {
    if (!this.host.enabled() || !intent || intent.source === "certify") return null;
    if (!this.tables(false)) return null;
    const ep = this.open();
    if (!ep) return null;
    const events: ColonyEvent[] = [];
    const holding = this.step(ep, now, events);
    const paths = holding ? meetsCone(p, this.coneSet(ep)) : [];
    if (paths.length === 0) {
      if (events.length > 0) this.host.publish(events);
      return null;
    }
    this.host.sql.exec(
      "INSERT OR REPLACE INTO red_brake_holds (proposal_id, episode, intent_id, agent_id, paths, held_at, released_at, outcome) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
      p.id,
      ep.id,
      p.intentId,
      p.agentId,
      JSON.stringify(paths.slice(0, PATHS_NAMED)),
      now,
    );
    const rep = ep.repair_id ? this.repair(ep.repair_id) : null;
    events.push({ t: "brake", at: now, action: "hold", proposalId: p.id, intentId: p.intentId, agentId: p.agentId, paths: paths.slice(0, PATHS_NAMED), trunkSha: ep.latest_sha, ...(ep.repair_id ? { repairId: ep.repair_id } : {}) });
    events.push(this.host.notice(p.agentId, p.intentId, holdMessage(paths, ep.latest_sha, rep ? { id: rep.id, title: rep.title } : null, (ep.holding_since ?? now) + CEILING_MS - now)));
    this.host.bump("brake.held", 1);
    return events;
  }

  /** The take's model hint when the intent is a red trunk's repair (with the brake on), else undefined. */
  modelFor(intent: { id: Id; source?: string }): ModelHint | undefined {
    if (intent.source !== "certify" || !this.safe("model hint", false, () => this.host.enabled())) return undefined;
    return this.safe("model hint", repairHint(0), () => repairHint(this.failures(intent.id, 0).returns));
  }

  private reportNow(now: number): RedBrakeReport | undefined {
    const on = this.host.enabled();
    if (!this.tables(false)) return on ? summarize(on, [], [], now) : undefined;
    const episodes = this.host.sql.exec<BrakeEpisode>("SELECT * FROM red_brake_episodes ORDER BY id DESC LIMIT ?", EPISODES_KEEP).toArray();
    const holds = this.host.sql.exec<{ held_at: number; released_at: number | null }>("SELECT held_at, released_at FROM red_brake_holds ORDER BY held_at DESC LIMIT ?", HOLDS_KEEP).toArray();
    return summarize(on, episodes, holds, now);
  }

  /** Stuck work: an episode whose holding stopped at the ceiling, at a report, or after two failures, while trunk is still red. */
  stuckItems(_now: number): StuckItem[] {
    return this.safe("stuck work", [], () => this.stuckNow());
  }

  private stuckNow(): StuckItem[] {
    if (!this.tables(false)) return [];
    const ep = this.open();
    if (!ep || !ep.stopped || ep.stopped === "off" || ep.stopped_at === null) return [];
    const held = this.host.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM red_brake_holds WHERE episode = ?", ep.id).one().n;
    const rep = ep.repair_id ? this.repair(ep.repair_id) : null;
    const title = rep ? `“${clip(rep.title, TITLE_CHARS)}”` : "the repair";
    const red = `trunk is still red since ${ep.red_sha.slice(0, 7)}${ep.failing_n > 0 ? ` (${ep.failing_n} failing)` : ""}`;
    const letGo = held > 0 ? ` and let ${plural(held, "held change")} go` : "";
    const text =
      ep.stopped === "ceiling"
        ? `The red brake stopped holding after ${span(CEILING_MS)}${letGo}: repair ${title} has not made trunk green, and ${red}`
        : ep.stopped === "escalated"
          ? `Repair ${title} failed ${FAILURES} times, so the red brake sent it to a person with the failing tests${letGo}; ${red}`
          : `Repair ${title} was reported to a person, so the red brake stopped holding${letGo}; ${red}`;
    const item: StuckItem = { key: `brake:${ep.red_sha}:${ep.stopped}`, kind: "red", since: ep.stopped_at, text, action: ep.stopped === "ceiling" ? "tests" : "answer", trunkSha: ep.red_sha };
    if (rep) {
      item.intentId = rep.id;
      item.title = clip(rep.title, TITLE_CHARS);
    }
    return [item];
  }

  // -------------------------------------------------------------------------

  /**
   * One look at an open episode. Returns whether the brake holds now: the episode has not stopped, its repair is open
   * and not reported, and the ceiling has not passed. Stops and releases go into `events`.
   */
  private step(ep: BrakeEpisode, now: number, events: ColonyEvent[]): boolean {
    if (ep.stopped) {
      if (this.unreleased() > 0) this.release(ENDS.has(ep.stopped) ? (ep.stopped as RedBrakeEnd) : null, now, events);
      return false;
    }
    const rep = ep.repair_id ? this.repair(ep.repair_id) : null;
    // A repair that landed after the latest red result is still open until its verdict comes.
    const open = !!rep && (LIVE.has(rep.status) || (rep.status === "landed" && rep.updatedAt >= ep.latest_at));
    if (open && rep.reported) {
      this.stop(ep, "reported", now, events);
      return false;
    }
    if (open && rep.status === "open") {
      const f = this.failures(rep.id, rep.createdAt);
      if (f.count >= FAILURES) {
        this.escalate(ep, rep, f, now, events);
        this.stop(ep, "escalated", now, events, f.count);
        return false;
      }
    }
    if (ep.holding_since !== null && now >= ep.holding_since + CEILING_MS) {
      this.stop(ep, "ceiling", now, events);
      return false;
    }
    if (!open) {
      if (this.unreleased() > 0) this.release(null, now, events);
      return false;
    }
    if (ep.holding_since === null) {
      ep.holding_since = now;
      this.host.sql.exec("UPDATE red_brake_episodes SET holding_since = ? WHERE id = ? AND holding_since IS NULL", now, ep.id);
      const failing = [...new Set(parseList<FailingTest>(ep.failing, []).map((f) => f.file))];
      events.push({ t: "brake", at: now, action: "on", trunkSha: ep.latest_sha, repairId: rep.id, paths: failing.slice(0, PATHS_NAMED) });
    }
    this.dropGone(now, events);
    this.arm(Math.min(ep.holding_since + CEILING_MS, now + RECHECK_MS), now);
    return true;
  }

  /** Holds whose change no longer waits (recalled, withdrawn, sent to a person) end as gone, so they stop counting as held. */
  private dropGone(now: number, events: ColonyEvent[]): void {
    const rows = this.host.sql
      .exec<{ proposal_id: string; intent_id: string; agent_id: string; held_at: number }>(
        `SELECT h.proposal_id AS proposal_id, h.intent_id AS intent_id, h.agent_id AS agent_id, h.held_at AS held_at FROM red_brake_holds h
           LEFT JOIN proposals p ON p.id = h.proposal_id WHERE h.released_at IS NULL AND (p.status IS NULL OR p.status != 'ready')`,
      )
      .toArray();
    for (const r of rows) {
      const claimed = this.host.sql.exec("UPDATE red_brake_holds SET released_at = ?, outcome = 'gone' WHERE proposal_id = ? AND released_at IS NULL RETURNING proposal_id", now, r.proposal_id).toArray();
      if (claimed.length === 0) continue;
      events.push({ t: "brake", at: now, action: "release", proposalId: r.proposal_id, intentId: r.intent_id, agentId: r.agent_id, heldMs: Math.max(0, now - r.held_at), gone: true });
      this.host.bump("brake.released", 1);
    }
  }

  /** Stop holding for the rest of the episode, and let held changes go. */
  private stop(ep: BrakeEpisode, end: RedBrakeEnd, now: number, events: ColonyEvent[], failures?: number): void {
    ep.stopped = end;
    ep.stopped_at = now;
    this.host.sql.exec("UPDATE red_brake_episodes SET stopped = ?, stopped_at = ? WHERE id = ? AND stopped IS NULL", end, now, ep.id);
    const held = this.release(end, now, events);
    events.push({ t: "brake", at: now, action: "stop", end, trunkSha: ep.latest_sha, held, ...(ep.repair_id ? { repairId: ep.repair_id } : {}), ...(failures !== undefined ? { failures } : {}) });
    this.host.bump(`brake.${end}`, 1);
  }

  /**
   * Let every held change go: one that still waits goes to its lane and its agent is told why; one that no longer
   * waits (recalled, withdrawn, sent to a person) is only marked. Each hold is claimed in storage before anything is
   * sent, so two looks never send one twice. Returns the changes sent to their lanes.
   */
  private release(end: RedBrakeEnd | null, now: number, events: ColonyEvent[]): number {
    const rows = this.host.sql
      .exec<{ proposal_id: string; intent_id: string; agent_id: string; held_at: number }>("SELECT proposal_id, intent_id, agent_id, held_at FROM red_brake_holds WHERE released_at IS NULL")
      .toArray();
    const sends: Array<Promise<void>> = [];
    let sent = 0;
    let claimedAll = 0;
    for (const r of rows) {
      const row = this.host.sql
        .exec<{ status: string; region: string | null; priority: number | null; data: string }>("SELECT status, region, priority, data FROM proposals WHERE id = ?", r.proposal_id)
        .toArray()[0];
      const go = row?.status === "ready";
      const claimed = this.host.sql
        .exec("UPDATE red_brake_holds SET released_at = ?, outcome = ? WHERE proposal_id = ? AND released_at IS NULL RETURNING proposal_id", now, go ? (end ?? "none") : "gone", r.proposal_id)
        .toArray();
      if (claimed.length === 0) continue;
      claimedAll++;
      const heldMs = Math.max(0, now - r.held_at);
      events.push({ t: "brake", at: now, action: "release", proposalId: r.proposal_id, intentId: r.intent_id, agentId: r.agent_id, heldMs, ...(end ? { end } : {}), ...(go ? {} : { gone: true }) });
      if (!go || !row) continue;
      let p: Proposal;
      try {
        p = JSON.parse(row.data) as Proposal;
      } catch {
        continue;
      }
      sent++;
      events.push(this.host.notice(r.agent_id, r.intent_id, releaseMessage(end, heldMs)));
      sends.push(this.host.enqueue(p, row.region ?? ".", row.priority ?? 1));
    }
    if (claimedAll > 0) this.host.bump("brake.released", claimedAll);
    if (sends.length > 0) this.host.waitUntil(Promise.all(sends));
    return sent;
  }

  /** Send the repair to a person with the failing tests, as an open report on it (take offers it to no agent until answered). */
  private escalate(ep: BrakeEpisode, rep: RepairNow, f: { count: number; reasons: string[] }, now: number, events: ColonyEvent[]): void {
    const report = escalationReport(f.count, f.reasons, ep.latest_sha, parseList<FailingTest>(ep.failing, []), ep.failing_n);
    const e: IntentEscalation = { kind: "other", report, by: BRAKE_BY, at: now };
    const done = this.host.sql
      .exec("UPDATE intents SET escalation = ?, escalation_open = 1, updated_at = ? WHERE id = ? AND status = 'open' AND escalation_open IS NOT 1 RETURNING id", JSON.stringify(e), now, rep.id)
      .toArray();
    if (done.length === 0) return;
    this.host.sql.exec("INSERT OR REPLACE INTO intent_escalations (intent_id, at, agent_id, kind, report, resolved) VALUES (?, ?, ?, ?, ?, NULL)", rep.id, now, BRAKE_BY, "other", report);
    this.host.forget(rep.id);
    events.push({ t: "brake", at: now, action: "escalate", repairId: rep.id, failures: f.count, trunkSha: ep.latest_sha });
    events.push({ t: "escalation", at: now, intentId: rep.id, agentId: BRAKE_BY, kind: "other", report, title: rep.title });
  }

  /**
   * The repair's failures since it last changed course (it was declared, a person answered a report on it, or it was
   * amended substantively): its changes that came back for a reason other than a change of direction, and the attempts
   * agents gave back. `returns` counts the changes only (the model hint's count).
   */
  private failures(intentId: Id, createdAt: number): { count: number; returns: number; reasons: string[] } {
    const sql = this.host.sql;
    let since = createdAt;
    try {
      const answered = sql.exec<{ at: number | null }>("SELECT MAX(CAST(json_extract(resolved, '$.at') AS INTEGER)) AS at FROM intent_escalations WHERE intent_id = ? AND resolved IS NOT NULL", intentId).one().at;
      if (typeof answered === "number") since = Math.max(since, answered);
    } catch {
      // No reports kept in this colony yet.
    }
    try {
      const revised = sql.exec<{ at: number | null }>("SELECT MAX(at) AS at FROM intent_revisions WHERE intent_id = ? AND substantive = 1", intentId).one().at;
      if (typeof revised === "number") since = Math.max(since, revised);
    } catch {
      // No revisions kept in this colony yet.
    }
    const back = sql
      .exec<{ reason: string | null; superseded_by: string | null }>(
        `SELECT json_extract(data, '$.reason') AS reason, json_extract(data, '$.supersededBy') AS superseded_by FROM proposals
          WHERE intent_id = ? AND status IN ('returned', 'rejected') AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`,
        intentId,
        since,
        LOOKBACK,
      )
      .toArray()
      .filter((r) => !(typeof r.superseded_by === "string" && r.superseded_by !== "") && !isRedirect(typeof r.reason === "string" ? r.reason : undefined));
    let gaveBack = 0;
    try {
      gaveBack = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM intent_closures WHERE intent_id = ? AND at >= ? AND cause IN ('gave_up', 'released')", intentId, since).one().n;
    } catch {
      // No closure ledger in this colony yet.
    }
    const reasons = back.map((r) => (typeof r.reason === "string" ? r.reason : "")).filter((s) => s !== "");
    return { count: back.length + gaveBack, returns: back.length, reasons };
  }

  /** Flag off: an open episode ends, and changes it held go to their lanes. Cheap once it knows there are no tables. */
  private off(now: number): void {
    if (this.quiet || !this.tables(false)) return;
    this.quiet = true;
    const events: ColonyEvent[] = [];
    const ep = this.open();
    if (ep) {
      if (!ep.stopped) events.push({ t: "brake", at: now, action: "stop", end: "off", trunkSha: ep.latest_sha, held: 0 });
      this.host.sql.exec("UPDATE red_brake_episodes SET stopped = COALESCE(stopped, 'off'), stopped_at = COALESCE(stopped_at, ?), ended_at = ? WHERE id = ?", now, now, ep.id);
    }
    if (this.unreleased() > 0) {
      const sent = this.release("off", now, events);
      const stop = events.find((e) => e.t === "brake" && e.action === "stop");
      if (stop && stop.t === "brake") stop.held = sent;
    }
    if (events.length > 0) this.host.publish(events);
  }

  private tables(create: boolean): boolean {
    if (create) this.quiet = false;
    if (this.ready === true) return true;
    if (create) {
      for (const s of SCHEMA) this.host.sql.exec(s);
      this.ready = true;
      return true;
    }
    if (this.ready === false) return false;
    this.ready = this.host.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'red_brake_episodes'").toArray().length > 0;
    return this.ready;
  }

  private open(): BrakeEpisode | null {
    return this.host.sql.exec<BrakeEpisode>("SELECT * FROM red_brake_episodes WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").toArray()[0] ?? null;
  }

  private unreleased(): number {
    return this.host.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM red_brake_holds WHERE released_at IS NULL").one().n;
  }

  private repair(id: Id): RepairNow | null {
    const r = this.host.sql
      .exec<{ id: string; title: string; status: string; escalation_open: number | null; created_at: number; updated_at: number | null }>(
        "SELECT id, title, status, escalation_open, created_at, updated_at FROM intents WHERE id = ?",
        id,
      )
      .toArray()[0];
    return r ? { id: r.id, title: r.title, status: r.status, reported: r.escalation_open === 1, createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at } : null;
  }

  /** The open repair certification declared (the newest), read at a verdict. */
  private openRepairId(): Id | null {
    return (
      this.host.sql.exec<{ id: string }>("SELECT id FROM intents WHERE source = 'certify' AND status IN ('open', 'claimed', 'proposed') ORDER BY created_at DESC LIMIT 1").toArray()[0]?.id ?? null
    );
  }

  private coneSet(ep: BrakeEpisode): Set<Path> {
    const key = `${ep.id}:${ep.latest_at}:${ep.latest_sha}`;
    if (this.coneCache?.key !== key) this.coneCache = { key, set: new Set(parseList<Path>(ep.cone, [])) };
    return this.coneCache.set;
  }

  /** Ask for the colony's alarm by `at`, unless an earlier ask still stands. */
  private arm(at: number, now: number): void {
    if (this.armedFor > now && this.armedFor <= at) return;
    this.armedFor = at;
    this.host.wake(at);
  }

  /** Keep the newest ended episodes and released holds. */
  private trim(): void {
    this.host.sql.exec("DELETE FROM red_brake_episodes WHERE ended_at IS NOT NULL AND id IN (SELECT id FROM red_brake_episodes ORDER BY id DESC LIMIT -1 OFFSET ?)", EPISODES_KEEP);
    this.host.sql.exec(
      "DELETE FROM red_brake_holds WHERE released_at IS NOT NULL AND proposal_id IN (SELECT proposal_id FROM red_brake_holds ORDER BY held_at DESC LIMIT -1 OFFSET ?)",
      HOLDS_KEEP,
    );
  }
}

/** The metrics report from the stored episodes (newest first) and holds. */
export function summarize(on: boolean, episodes: readonly BrakeEpisode[], holds: ReadonlyArray<{ held_at: number; released_at: number | null }>, now: number): RedBrakeReport {
  const released = holds
    .filter((h) => h.released_at !== null)
    .map((h) => Math.max(0, h.released_at! - h.held_at))
    .sort((a, b) => a - b);
  const holding = holds.filter((h) => h.released_at === null).length;
  const heldMs = holds.reduce((sum, h) => sum + Math.max(0, (h.released_at ?? now) - h.held_at), 0);
  const greens = episodes
    .filter((e) => e.green_at !== null)
    .map((e) => Math.max(0, e.green_at! - e.red_at))
    .sort((a, b) => a - b);
  const by = (end: RedBrakeEnd): number => episodes.filter((e) => e.stopped === end).length;
  const report: RedBrakeReport = {
    on,
    text: "",
    episodes: { count: episodes.length, green: greens.length, open: episodes.filter((e) => e.ended_at === null).length, ceiling: by("ceiling"), escalated: by("escalated"), reported: by("reported") },
    held: { changes: holds.length, holding, ms: heldMs, p50Ms: quantile(released, 0.5), maxMs: quantile(released, 1) },
    toGreen: { episodes: greens.length, p50Ms: quantile(greens, 0.5), maxMs: quantile(greens, 1) },
    repairs: { reserved: episodes.reduce((sum, e) => sum + (e.reserved ?? 0), 0), escalated: by("escalated") },
  };
  const cur = episodes.find((e) => e.ended_at === null);
  if (on && cur && !cur.stopped && cur.holding_since !== null && now < cur.holding_since + CEILING_MS) {
    report.holding = {
      since: cur.holding_since,
      until: cur.holding_since + CEILING_MS,
      trunkSha: cur.latest_sha,
      ...(cur.repair_id ? { repairId: cur.repair_id } : {}),
      failing: [...new Set(parseList<FailingTest>(cur.failing, []).map((f) => f.file))].slice(0, FAILING_KEPT),
      cone: parseList<Path>(cur.cone, []).length,
    };
  }
  report.text = brakeText(report);
  return report;
}

/** The report's line: "held 4 changes for 6.1 min in all over 1 red episode; 1 episode back to green in 3.2 min at p50; holding 1 now". */
export function brakeText(r: RedBrakeReport): string {
  if (r.episodes.count === 0) return r.on ? "the red brake is on; trunk has not been red since" : "the red brake is off for this colony";
  const parts = [`held ${plural(r.held.changes, "change")}${r.held.changes > 0 ? ` for ${span(r.held.ms)} in all` : ""} over ${plural(r.episodes.count, "red episode")}`];
  if (r.toGreen.episodes > 0 && r.toGreen.p50Ms !== null) parts.push(`${plural(r.toGreen.episodes, "episode")} back to green in ${span(r.toGreen.p50Ms)} at p50`);
  const stops = [r.episodes.ceiling > 0 ? `${r.episodes.ceiling} at the ceiling` : "", r.episodes.escalated > 0 ? `${r.episodes.escalated} sent to a person` : "", r.episodes.reported > 0 ? `${r.episodes.reported} reported` : ""].filter((s) => s !== "");
  if (stops.length > 0) parts.push(`stopped holding ${stops.join(", ")}`);
  if (r.holding) parts.push(`holding ${r.held.holding} now`);
  if (!r.on) parts.push("off now");
  return parts.join("; ");
}

/** Trunk health with the brake's numbers added (a copy; the stored report is not changed), or as it was when the brake never ran. */
export function withBrake(h: TrunkHealth, r: RedBrakeReport | undefined): TrunkHealth {
  if (h.status !== "measured" || !r || r.episodes.count === 0) return h;
  return { ...h, brake: { episodes: r.episodes, held: r.held, toGreen: r.toGreen, repairs: r.repairs }, detail: [...h.detail, `Red brake: ${r.text}.`] };
}
