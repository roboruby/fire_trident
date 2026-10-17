import type { ColonyEvent, Millis, PauseScope, PauseState } from "@fire_trident/core";
import { maskSecrets } from "../trunk/mask.ts";
import { decodeError, errorText, ftError } from "./errors.ts";

/**
 * The pause switch. A person pauses every agent of one colony, or of the whole deployment, with a reason; code that
 * acts for a person (a spend cap) can trip it the same way, naming itself. While a pause is in force every write an
 * agent makes is refused with one sentence (pausedSentence): take, propose, an agent's declaration, escalate, starting
 * in-platform agents, and the Agent2Agent writes. Reads keep working, and so does everything a person does (approve,
 * reject, amend, withdraw, revert, resume), so a person can still clear the queue. The lanes hold what is in them and
 * the trunk writer defers what it was handed (trunk/pause.ts), so trunk stops moving; resuming lets it all go.
 *
 * A colony's own pause lives in its own storage (`pause_switch`, row `colony`). The deployment's lives in the
 * registry instance of ColonyDO (registryFlag DEPLOYMENT_PAUSE_KEY, api/pause.ts writes it); every colony keeps a
 * copy (row `deployment`), refreshed from the registry at most every DEPLOYMENT_PAUSE_TTL_MS and pushed to it when a
 * person pauses or resumes the deployment. Both rows survive a restart. Each change is published as a `paused` or
 * `resumed` event, so the colony's event record (and every replay) shows it.
 */

/** The status a refusal carries: the colony's state conflicts with the write. */
export const PAUSED_STATUS = 409;
/** Longest reason, and longest name of who paused or resumed, that the colony keeps. */
export const MAX_PAUSE_REASON = 300;
export const MAX_PAUSE_BY = 100;
/** How long a colony trusts its copy of the deployment's pause before it reads the registry again. */
export const DEPLOYMENT_PAUSE_TTL_MS = 5_000;
/** How long an in-platform agent waits before it looks again while its colony is paused. */
export const PAUSE_WAIT_MS = 15_000;
/** How long a lane holding for a pause waits before it asks again. */
export const LANE_PAUSE_RECHECK_MS = 2_000;
/** The registry marker that holds the deployment's pause (ColonyDO.registryFlag). */
export const DEPLOYMENT_PAUSE_KEY = "pause";
/** Who the Agent2Agent door acts as (api/a2a.ts): its CancelTask is an agent's write, refused while paused. */
export const A2A_ACTOR = "a2a";

const SENTENCE = /^Agents are paused in this colony by /;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * The last change of one switch, as the colony and the registry store it: paused or resumed, by whom, why, when.
 * A resume keeps when the pause it ended began (`pausedAt`).
 */
export interface PauseRecord {
  paused: boolean;
  by: string;
  reason: string;
  at: Millis;
  pausedAt?: Millis;
}

/** What ColonyDO.pauseState answers: the pauses in force (the colony's own first) and the sentence a write meets. */
export interface PauseView {
  paused: boolean;
  pauses: PauseState[];
  refusal: string | null;
}

/** What pausing answers: the pause in force (the one already standing when `already`), and whether the trunk writer confirmed it. */
export interface PauseAnswer {
  pause: PauseState;
  already: boolean;
  writer?: boolean;
}

/** What resuming answers: the pause it ended (null when there was none), and the pauses still in force. */
export interface ResumeAnswer {
  resumed: (PauseRecord & { scope: PauseScope }) | null;
  already: boolean;
  pauses: PauseState[];
  writer?: boolean;
}

/**
 * What the trunk writer keeps of a colony's pauses (trunk/pause.ts): whether any is in force, the first one's who and
 * why, and when the colony worked it out (its clock), so the writer keeps the newest record it is handed.
 */
export interface WriterPause {
  paused: boolean;
  by?: string;
  reason?: string;
  at: Millis;
}

/** The sentence every agent-facing write meets while a pause is in force. */
export function pausedSentence(p: Pick<PauseState, "by" | "reason">): string {
  const reason = cleanReason(p.reason).replace(/\.+$/, "") || "no reason given";
  const end = /[!?]$/.test(reason) ? "" : ".";
  return `Agents are paused in this colony by ${cleanBy(p.by)}: ${reason}${end} Reads still work; wait for a person to resume.`;
}

/** Is `err` (perhaps across RPC) a pause's refusal? */
export function isPauseRefusal(err: unknown): boolean {
  const { status, message } = decodeError(err);
  return status === PAUSED_STATUS && SENTENCE.test(message);
}

/** The error a refused write throws (status PAUSED_STATUS, survives RPC). */
export function pauseError(p: Pick<PauseState, "by" | "reason">): Error {
  return ftError(PAUSED_STATUS, pausedSentence(p));
}

/** A reason as kept: one line, secret-looking text masked, at most MAX_PAUSE_REASON characters. */
export function cleanReason(raw: unknown): string {
  return oneLine(maskSecrets(typeof raw === "string" ? raw : ""), MAX_PAUSE_REASON);
}

/** Who paused or resumed, as kept: one line, at most MAX_PAUSE_BY characters ("unknown" when empty). */
export function cleanBy(raw: unknown): string {
  return oneLine(maskSecrets(typeof raw === "string" ? raw : ""), MAX_PAUSE_BY) || "unknown";
}

function oneLine(s: string, max: number): string {
  const t = s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A stored record read defensively: null when it is not one (an absent or odd marker reads as no pause). */
export function parseRecord(raw: unknown): PauseRecord | null {
  let x: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      x = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.paused !== "boolean" || typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  const rec: PauseRecord = { paused: o.paused, by: cleanBy(o.by), reason: cleanReason(o.reason), at: o.at };
  if (typeof o.pausedAt === "number" && Number.isFinite(o.pausedAt)) rec.pausedAt = o.pausedAt;
  return rec;
}

/** The pause a record says is in force, or null. */
export function stateOf(rec: PauseRecord | null, scope: PauseScope): PauseState | null {
  return rec?.paused ? { scope, by: rec.by, reason: rec.reason || "no reason given", at: rec.at } : null;
}

/** The SQL the switch runs (a Durable Object's storage, or node:sqlite in unit tests). */
export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** Create the switch's table (additive: nothing existing is touched). One row per scope: its last change. */
export function migratePause(sql: SqlRunner): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pause_switch (scope TEXT PRIMARY KEY, paused INTEGER NOT NULL, by TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, paused_at INTEGER)",
  );
}

/** What the switch uses of its colony (ColonyDO builds it). */
export interface PauseHost {
  sql: SqlRunner;
  now(): number;
  /** The registry's deployment marker (registryFlag DEPLOYMENT_PAUSE_KEY), read over RPC; null when it holds none. */
  readDeployment(): Promise<string | null>;
  /** Publish events into the colony's record and to its live sockets. */
  publish(events: ColonyEvent[]): void;
  /**
   * Hand the trunk writer the colony's pauses as they stand and wait for the cycle in flight (trunk/pause.ts); true
   * when it answered in time. Best effort: lanes pass the same record with every batch.
   */
  tellWriter(record: WriterPause): Promise<boolean>;
}

type Row = { scope: string; paused: number; by: string; reason: string; at: number; paused_at: number | null };

/** One colony's pause switch: its own pause, its copy of the deployment's, the refusal and the events. */
export class ColonyPause {
  /** When the deployment's pause was last read from the registry (or pushed), and the read in flight. */
  private readAt = 0;
  private reading: Promise<void> | null = null;

  constructor(private readonly host: PauseHost) {
    migratePause(host.sql);
  }

  /** The last change of one scope's switch, or null when it never changed. */
  record(scope: PauseScope): PauseRecord | null {
    const r = this.host.sql.exec("SELECT * FROM pause_switch WHERE scope = ?", scope).toArray()[0] as Row | undefined;
    if (!r) return null;
    const rec: PauseRecord = { paused: r.paused === 1, by: r.by, reason: r.reason, at: r.at };
    if (typeof r.paused_at === "number") rec.pausedAt = r.paused_at;
    return rec;
  }

  /** The colony's own pause, or null. */
  own(): PauseState | null {
    return stateOf(this.record("colony"), "colony");
  }

  /**
   * The deployment's pause: the copy, read from the registry again once it is DEPLOYMENT_PAUSE_TTL_MS old. A registry
   * that does not answer leaves the copy as it was (the last state this colony saw), and is asked again on the next call.
   */
  async deployment(): Promise<PauseState | null> {
    if (this.host.now() - this.readAt >= DEPLOYMENT_PAUSE_TTL_MS) {
      this.reading ??= this.host
        .readDeployment()
        .then((raw) => {
          const changed = this.adopt(parseRecord(raw));
          this.readAt = this.host.now();
          // The pushed change never reached this colony: its trunk writer hears of it now (lanes also pass the record).
          if (changed) void this.host.tellWriter(this.writerNow()).catch(() => undefined);
        })
        .catch((err: unknown) => console.warn(`pause: the deployment's switch was not read: ${errorText(err)}`))
        .finally(() => {
          this.reading = null;
        });
      await this.reading;
    }
    return stateOf(this.record("deployment"), "deployment");
  }

  /** The pauses in force, the colony's own first. */
  async current(): Promise<PauseState[]> {
    const deployment = await this.deployment();
    return [this.own(), deployment].filter((p): p is PauseState => p !== null);
  }

  /** The pauses in force and the sentence a write meets (ColonyDO.pauseState). */
  async view(): Promise<PauseView> {
    const pauses = await this.current();
    const first = pauses[0];
    return { paused: first !== undefined, pauses, refusal: first ? pausedSentence(first) : null };
  }

  /** Throw the refusal while a pause is in force (status PAUSED_STATUS); return otherwise. */
  async refuse(): Promise<void> {
    const first = (await this.current())[0];
    if (first) throw pauseError(first);
  }

  /** What the trunk writer is handed: whether a pause is in force, the first one's who and why, and now. */
  async writerRecord(): Promise<WriterPause> {
    await this.deployment();
    return this.writerNow();
  }

  /** The trunk writer's record from the stored switches as they stand (no registry read). */
  private writerNow(): WriterPause {
    const first = this.own() ?? stateOf(this.record("deployment"), "deployment");
    const at = this.host.now();
    return first ? { paused: true, by: first.by, reason: first.reason, at } : { paused: false, at };
  }

  /** Pause the colony's agents. A pause already in force stands as it is (`already`): its who and why are kept. */
  async pause(p: { by: unknown; reason: unknown }): Promise<PauseAnswer> {
    const standing = this.own();
    if (standing) return { pause: standing, already: true };
    const reason = cleanReason(p?.reason);
    if (!reason) throw ftError(400, "a reason is required: agents and people see it while the colony is paused");
    const rec: PauseRecord = { paused: true, by: cleanBy(p?.by), reason, at: this.host.now() };
    this.write("colony", rec);
    this.announce("colony", rec);
    const writer = await this.host.tellWriter(this.writerNow());
    return { pause: stateOf(rec, "colony")!, already: false, writer };
  }

  /** Resume the colony's agents; the deployment's pause, if one is in force, still holds them (it is in `pauses`). */
  async resume(p: { by: unknown; reason?: unknown }): Promise<ResumeAnswer> {
    const standing = this.record("colony");
    if (!standing?.paused) return { resumed: null, already: true, pauses: await this.current() };
    const rec: PauseRecord = { paused: false, by: cleanBy(p?.by), reason: cleanReason(p?.reason), at: this.host.now(), pausedAt: standing.at };
    this.write("colony", rec);
    this.announce("colony", rec);
    const writer = await this.host.tellWriter(this.writerNow());
    return { resumed: { scope: "colony", ...rec }, already: false, pauses: await this.current(), writer };
  }

  /**
   * The deployment's switch changed (api/pause.ts pushes it to every colony): keep the copy, publish the change, and
   * tell the trunk writer. Answers whether the trunk writer confirmed (null when nothing changed).
   */
  async deploymentChanged(raw: unknown): Promise<{ changed: boolean; writer: boolean | null }> {
    const changed = this.adopt(parseRecord(raw));
    this.readAt = this.host.now();
    return { changed, writer: changed ? await this.host.tellWriter(this.writerNow()) : null };
  }

  /**
   * Keep `rec` as the copy of the deployment's switch when it is a newer change than the one kept; publish it then.
   * No marker, or an older record (a registry read that started before a push arrived), changes nothing. True when
   * the copy changed what it says.
   */
  private adopt(rec: PauseRecord | null): boolean {
    const kept = this.record("deployment");
    if (!rec || (kept && rec.at < kept.at)) return false;
    if (kept && kept.paused === rec.paused && kept.at === rec.at) return false;
    if (!rec.paused && !kept?.paused) {
      // Resumed before this colony saw it paused (or resumed again): nothing it saw changed.
      this.write("deployment", rec);
      return false;
    }
    this.write("deployment", rec);
    this.announce("deployment", rec);
    return true;
  }

  private write(scope: PauseScope, rec: PauseRecord): void {
    this.host.sql.exec(
      "INSERT OR REPLACE INTO pause_switch (scope, paused, by, reason, at, paused_at) VALUES (?, ?, ?, ?, ?, ?)",
      scope,
      rec.paused ? 1 : 0,
      rec.by,
      rec.reason,
      rec.at,
      rec.pausedAt ?? null,
    );
  }

  private announce(scope: PauseScope, rec: PauseRecord): void {
    const at = this.host.now();
    const ev: ColonyEvent = rec.paused
      ? { t: "paused", at, scope, by: rec.by, reason: rec.reason }
      : { t: "resumed", at, scope, by: rec.by, ...(rec.reason ? { reason: rec.reason } : {}), ...(rec.pausedAt !== undefined ? { pausedAt: rec.pausedAt } : {}) };
    this.host.publish([ev]);
  }
}

/** The pause view of a colony stub that may not have one yet (an object still on the previous class answers null). */
export async function pauseViewOf(stub: { pauseState?(): Promise<unknown> }): Promise<PauseView | null> {
  if (typeof stub.pauseState !== "function") return null;
  try {
    return viewOf(await stub.pauseState());
  } catch (err) {
    // Deploys reach Durable Objects gradually: one still on the previous class has no switch, so it was never paused.
    if (/does not implement the method/i.test(errorText(err))) return null;
    throw err;
  }
}

/** A pause view read defensively from an RPC answer. */
export function viewOf(x: unknown): PauseView | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const pauses = (Array.isArray(o.pauses) ? o.pauses : []).filter(
    (p): p is PauseState => !!p && typeof p === "object" && typeof (p as PauseState).by === "string" && typeof (p as PauseState).reason === "string",
  );
  const refusal = typeof o.refusal === "string" && o.refusal ? o.refusal : null;
  return { paused: o.paused === true || pauses.length > 0, pauses, refusal: refusal ?? (pauses[0] ? pausedSentence(pauses[0]) : null) };
}

/**
 * The agent-facing doors' fast refusal (the MCP tools, the Agent2Agent door, POST /swarm): throw the colony's pause
 * sentence while a pause is in force. A colony still on the previous class has no switch and passes; the colony
 * itself checks again (authoritative), so a door that passes here is still refused inside.
 */
export async function refuseWhilePaused(stub: { pauseState?(): Promise<unknown> }): Promise<void> {
  const view = await pauseViewOf(stub);
  if (view?.paused && view.refusal) throw ftError(PAUSED_STATUS, view.refusal);
}

/** The ColonyDO stub a lane asks (the namespace binding is enough). */
type ColonyNamespace = { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): unknown };

/**
 * A lane's pause check at the start of a tick (RegionDO.tick): the wait before it asks again while a pause is in force,
 * else null. It fails closed: a colony that does not answer holds the lane for LANE_PAUSE_RECHECK_MS too. A colony
 * still on the previous class has no switch, so it was never paused, and neither was one that does not exist (404):
 * the lane goes on for both.
 */
export async function laneHold(env: { COLONY: ColonyNamespace }, colonyId: string): Promise<number | null> {
  try {
    const view = await pauseViewOf(env.COLONY.get(env.COLONY.idFromName(colonyId)) as { pauseState?(): Promise<unknown> });
    return view?.paused ? LANE_PAUSE_RECHECK_MS : null;
  } catch (err) {
    // A colony that does not exist has no switch to be paused by: the lane goes on as it did before the switch.
    if (decodeError(err).status === 404) return null;
    console.warn(`pause: lane of ${colonyId} holds, the colony's switch was not read: ${errorText(err)}`);
    return LANE_PAUSE_RECHECK_MS;
  }
}

/** Whether the lineage context a lane just read (ColonyDO.landContext's `pause`) says a pause began meanwhile. */
export function pausedIn(ctx: unknown): boolean {
  const p = ctx && typeof ctx === "object" ? (ctx as { pause?: unknown }).pause : undefined;
  return !!p && typeof p === "object" && (p as { paused?: unknown }).paused === true;
}
