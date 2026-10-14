import { footprintCovers, newId, revalidationEnabled } from "@fire_trident/core";
import type { CheckResult, Id, Landing, MegafileHold, MegafileReport, Path, Proposal, Sha } from "@fire_trident/core";
// Direct import until packages/core/src/index.ts re-exports hotness.ts (orchestrator-owned).
import { HOTNESS, hotness, lineCount, type Hotness, type HotnessThresholds, type PathWrite } from "../../../core/src/hotness.ts";
import { isTestPath } from "../decide/signals.ts";
import { isRedirect } from "./direction.ts";
import { errorText, ftError } from "./errors.ts";
import { normalizePath } from "./logic.ts";

/**
 * The megafile alarm (FT_MEGAFILE). A script file that many agents each add a little to grows until it is slow to
 * read, diff and merge, and changes to it collide; since text merge lands disjoint additions cleanly, its growth is
 * the signal. The colony records, per file, who wrote it and how long it is after each landing (onLanding) and which
 * changes went back colliding on it (deliverOutcomes); core/hotness.ts says when it is hot. A file that turns hot
 * gets one split intent (source `system`), and the file is held: take offers no other intent whose footprint covers
 * it, and a change that writes it, other than the split's, goes back at propose. Changes already on their way that
 * write it go back when the hold begins. The hold lifts when the split lands, is withdrawn or reported, when a person
 * releases it, or after HOLD_MS. A person can also hold a file by hand. With the flag off nothing here runs.
 */

/** Above every spec intent (they use 1 to 5) and below a red trunk's repair (10): a hot file is split before more is added to it. */
export const SPLIT_PRIORITY = 8;
/** A hold lifts by itself this long after it began, split or not, so a file is never blocked for long. */
export const HOLD_MS = 60 * 60_000;
/** Who declares a split intent (its createdBy). */
export const SPLIT_BY = "megafile";
/** Who holds a file the alarm found hot. */
export const COLONY_BY = "colony";
/** Holds read from storage are reused this long by takes and proposals: a split intent withdrawn or reported stops holding within it. */
const HOLDS_TTL_MS = 1_000;
/** Lifted holds the report lists at most, and how long they are kept. */
const LIFTED_LISTED = 10;
const LIFTED_KEEP_MS = 7 * 24 * 60 * 60_000;
/** Stored signals are pruned at most this often. */
const PRUNE_EVERY_MS = 5 * 60_000;
/** How long a trunk read for a file's length may take before the alarm goes on without it. */
const READ_MS = 5_000;
/** Longest name of a person holding or releasing a file that the colony keeps. */
const MAX_BY = 100;

const SCRIPT = /\.[cm]?[jt]sx?$/i;
const HOLD_REASON = / is being split by intent \S+; take again after it lands$/;
const LIVE: ReadonlySet<string> = new Set(["open", "claimed", "proposed"]);

/** Is the megafile alarm on for this colony? `setting` is FT_MEGAFILE, read like FT_REVALIDATE: "on", a comma-separated list of colony ids, or absent / "off". */
export function megafileEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * The files the alarm watches: JavaScript and TypeScript sources. Test files are left out: splitting one moves
 * assertions out of it, which review reads as weakened tests and sends to a person.
 */
export function watchedPath(path: Path): boolean {
  return typeof path === "string" && SCRIPT.test(path) && !isTestPath(path);
}

/** What a change that writes a held file is told when it goes back. */
export function holdReason(path: Path, intentId: Id): string {
  return `${path} is being split by intent ${intentId}; take again after it lands`;
}

/** Whether a return reason is a hold's (holdReason). */
export function isHoldReason(reason: string | undefined): boolean {
  return typeof reason === "string" && HOLD_REASON.test(reason);
}

/**
 * Whether a change went back because it collided: a stale read or write, or a conflict with another change (the
 * lane's and the trunk writer's reasons start so). Review verdicts, changes of direction and holds do not count.
 */
export function collisionReason(reason: string | undefined): boolean {
  if (typeof reason !== "string" || isRedirect(reason) || isHoldReason(reason)) return false;
  return /^(stale\b|conflicts? )/i.test(reason.trim());
}

/** Whether `text` names `path` as a whole path, not as part of a longer path or name. */
export function namesPath(text: string, path: Path): boolean {
  if (!path) return false;
  for (let i = text.indexOf(path); i >= 0; i = text.indexOf(path, i + 1)) {
    const before = i === 0 ? "" : text[i - 1]!;
    const after = text.slice(i + path.length, i + path.length + 2);
    if (/[\w./-]/.test(before)) continue;
    if (/^[\w/-]/.test(after) || /^\.\w/.test(after)) continue;
    return true;
  }
  return false;
}

/** The split intent's footprint: the file, new files beside it in its directory, and a directory named after it. */
export function splitFootprint(path: Path): Path[] {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return [path, `${dir}*`, `${dir}${stem}/**`];
}

/** What a split intent is declared with (ColonyDO.addIntent input, without the colony). */
export interface SplitIntentInput {
  title: string;
  why: string;
  source: "system";
  footprint: Path[];
  acceptance: string[];
  priority: number;
  createdBy: string;
}

/** A share as a whole percentage. */
function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** A duration in whole minutes ("30 minutes"). */
function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** The numbers a hold keeps, from the file's hotness when it was held. */
interface HoldNumbers {
  signal: MegafileHold["signal"];
  lines: number | null;
  baseline: number | null;
  growth: number | null;
  agents: number;
  returns: number;
  windowMs: number;
}

/** What made the file hot, in a sentence with its numbers. */
function signalText(path: Path, n: HoldNumbers, by: string): string {
  const window = minutes(n.windowMs);
  const size = n.lines !== null ? ` It has ${n.lines} lines.` : "";
  if (n.signal === "person") return `${by} asked for ${path} to be split.${size}`;
  if (n.signal === "returns") {
    return `${n.returns} changes that wrote ${path} went back in the last ${window} because they collided on it (stale versions or conflicts).${size}`;
  }
  const grew = n.baseline !== null ? `, up from ${n.baseline}${n.growth !== null ? ` (${percent(n.growth)})` : ""} in the last ${window}` : "";
  return `${path} has ${n.lines ?? "an unknown number of"} lines${grew}, and changes from ${n.agents} agents landed on it in that time.`;
}

/** A hold's numbers in one line, for logs and the status. */
export function holdNumbersText(h: Pick<MegafileHold, "signal" | "lines" | "baseline" | "growth" | "agents" | "returns" | "windowMs">): string {
  const parts = [h.lines !== null ? `${h.lines} lines` : "length not known"];
  if (h.baseline !== null && h.lines !== null) parts.push(`from ${h.baseline}${h.growth !== null ? ` (+${percent(h.growth)})` : ""} in ${minutes(h.windowMs)}`);
  parts.push(`${h.agents} agent${h.agents === 1 ? "" : "s"}`, `${h.returns} return${h.returns === 1 ? "" : "s"}`);
  return `${h.signal}: ${parts.join(", ")}`;
}

/**
 * The split intent for a hot file: its numbers in the why, the file and new files beside it as the footprint, and
 * as acceptance that every name the file exports stays importable from it and the tests pass.
 */
export function splitIntent(path: Path, n: HoldNumbers, by: string): SplitIntentInput {
  const why = [
    signalText(path, n, by),
    "A file that many agents each add a little to keeps growing until it is slow to read, diff and merge, and changes to it keep colliding.",
    `Split it into smaller modules beside it: move groups of related code into new files in its directory (or a directory named after it) and re-export what moved from ${path}, so every import of ${path} keeps working.`,
    `Until this lands (at most ${minutes(HOLD_MS)}), no other change may write ${path}.`,
  ].join(" ");
  return {
    title: `Split ${path} into smaller modules`,
    why,
    source: "system",
    footprint: splitFootprint(path),
    acceptance: [`Every name ${path} exports today is still exported from ${path} (re-export what moved), so no import of it changes`, "The tests pass"],
    priority: SPLIT_PRIORITY,
    createdBy: SPLIT_BY,
  };
}

/** The SQL the alarm runs (a Durable Object's storage, or node:sqlite in unit tests). */
export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** Create the alarm's tables (additive: nothing existing is touched). */
export function migrateMegafile(sql: SqlRunner): void {
  // One row per landing that changed a watched file: when, its length after (null when not known), and the agents that wrote it.
  sql.exec("CREATE TABLE IF NOT EXISTS megafile_writes (path TEXT NOT NULL, landing_id TEXT NOT NULL, at INTEGER NOT NULL, lines INTEGER, agents TEXT NOT NULL, PRIMARY KEY (path, landing_id))");
  sql.exec("CREATE INDEX IF NOT EXISTS megafile_writes_by_path ON megafile_writes(path, at)");
  // One row per change that went back colliding on a watched file.
  sql.exec("CREATE TABLE IF NOT EXISTS megafile_returns (path TEXT NOT NULL, proposal_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (path, proposal_id))");
  sql.exec("CREATE INDEX IF NOT EXISTS megafile_returns_by_path ON megafile_returns(path, at)");
  // Holds, lifted ones kept a while (the report lists them; the newest per file names its split intent).
  sql.exec(
    `CREATE TABLE IF NOT EXISTS megafile_holds (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, intent_id TEXT NOT NULL, held_by TEXT NOT NULL, at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      numbers TEXT NOT NULL, lifted_at INTEGER, lifted TEXT, lines_after INTEGER)`,
  );
  sql.exec("CREATE INDEX IF NOT EXISTS megafile_holds_by_path ON megafile_holds(path, at)");
  sql.exec("CREATE INDEX IF NOT EXISTS megafile_holds_by_lift ON megafile_holds(lifted_at)");
}

/** What the alarm uses of its colony (ColonyDO builds it). */
export interface MegafileHost {
  sql: SqlRunner;
  /** FT_MEGAFILE covers the colony; read on every call, so a changed flag counts at once. */
  enabled(): boolean;
  now(): number;
  /** A proposal as the colony stores it, or null. */
  proposal(id: Id): Proposal | null;
  /** An inline change's texts by blob id while the colony keeps them, or null. */
  contents(proposalId: Id): Record<Sha, string> | null;
  /** An intent's status and whether a report on it waits for a person, or null when the colony has no such intent. */
  intent(id: Id): { status: string; reported: boolean } | null;
  /** Declare an intent (ColonyDO.addIntent). */
  declare(input: SplitIntentInput): Promise<{ id: Id }>;
  /** A trunk file's text, or null when it is not on trunk. */
  readFile(path: Path): Promise<string | null>;
  /** Changes on their way (pending, checking, in a lane, or waiting for a person) that write `path`, except `intentId`'s. */
  inFlight(path: Path, intentId: Id): Id[];
  /** Send changes back to their agents with these reasons (ColonyDO.updateProposals). */
  sendBack(items: Array<{ id: Id; reason: string }>): Promise<void>;
  /** Keep the object alive for work that goes on after the call that started it. */
  waitUntil(p: Promise<unknown>): void;
}

/** A hold as stored. */
type HoldRow = {
  id: string;
  path: string;
  intent_id: string;
  held_by: string;
  at: number;
  ends_at: number;
  numbers: string;
  lifted_at: number | null;
  lifted: string | null;
  lines_after: number | null;
};

/** A landing of one file as stored. */
type WriteRow = { landing_id: string; at: number; lines: number | null; agents: string };

/** What one landing did to one file: who wrote it, how long it is after (when a change's own text says), how many changes wrote it. */
type FileChange = { agents: Set<Id>; lines: number | null; writers: number };

/** A stored list of agent ids (anything else counts as none). */
function agentsOf(text: string): Id[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.filter((x): x is Id => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
}

/** A whole number of lines, or null. */
function lines(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** A hold's stored numbers (old or odd rows count as unknown). */
function numbersOf(text: string): HoldNumbers {
  let v: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") v = parsed as Record<string, unknown>;
  } catch {
    // Unknown numbers.
  }
  const signal = v.signal === "growth" || v.signal === "returns" || v.signal === "person" ? v.signal : "growth";
  const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  return {
    signal,
    lines: lines(v.lines),
    baseline: lines(v.baseline),
    growth: typeof v.growth === "number" && Number.isFinite(v.growth) ? v.growth : null,
    agents: n(v.agents),
    returns: n(v.returns),
    windowMs: n(v.windowMs) || HOTNESS.windowMs,
  };
}

/** A stored hold as the colony reports it. */
function toHold(r: HoldRow): MegafileHold {
  const out: MegafileHold = { path: r.path, intentId: r.intent_id, by: r.held_by, at: r.at, until: r.ends_at, ...numbersOf(r.numbers) };
  if (typeof r.lifted_at === "number") {
    out.liftedAt = r.lifted_at;
    out.lifted = r.lifted ?? "lifted";
  }
  const after = lines(r.lines_after);
  if (after !== null) out.linesAfter = after;
  return out;
}

/** A person's name as the colony keeps it: one line, at most MAX_BY characters. */
function cleanBy(by: unknown): string {
  const s = typeof by === "string" ? by.replace(/\s+/g, " ").trim().slice(0, MAX_BY) : "";
  return s || "a person";
}

/** One colony's megafile alarm (see the module comment). */
export class MegafileAlarm {
  private ready = false;
  /** The holds standing when last read, and when (see standing). */
  private cache: { at: number; rows: HoldRow[] } | null = null;
  /** Files whose split intent and hold are being made now. */
  private readonly declaring = new Set<Path>();
  private lastPrune = 0;

  constructor(
    private readonly host: MegafileHost,
    private readonly t: Readonly<HotnessThresholds> = HOTNESS,
  ) {}

  /** Whether the alarm runs for the colony now; its tables exist once it does (a failed migration leaves it off, logged). */
  private on(): boolean {
    if (!this.host.enabled()) return false;
    if (!this.ready) {
      try {
        migrateMegafile(this.host.sql);
      } catch (err) {
        console.warn(`megafile: tables not made, the alarm stays off: ${errorText(err)}`);
        return false;
      }
      this.ready = true;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // The hold: take and propose
  // -------------------------------------------------------------------------

  /**
   * The open intents a take may offer: an intent whose footprint covers a held file waits, except a split intent. A
   * split's footprint covers the files beside its own (its directory), which may be held too: two hot files in one
   * directory must not keep each other's split waiting (a split that writes another held file still goes back at
   * propose). `reason` says why when the holds left none (the take then waits). Fails open: an alarm that cannot read
   * its holds offers everything.
   */
  offerable<R extends { id: string }>(rows: R[], footprint: (r: R) => Path[]): { rows: R[]; reason?: string } {
    if (rows.length === 0 || !this.on()) return { rows };
    const holds = this.safeStanding();
    if (holds.length === 0) return { rows };
    const splits = new Set(holds.map((h) => h.intent_id));
    const out: R[] = [];
    let blocked: HoldRow | null = null;
    for (const r of rows) {
      const fp = footprint(r);
      const h = splits.has(r.id) ? undefined : holds.find((x) => fp.some((entry) => footprintCovers(entry, x.path)));
      if (!h) out.push(r);
      else blocked ??= h;
    }
    if (out.length > 0 || blocked === null) return { rows: out };
    return { rows: out, reason: `every open intent covers a file being split: ${holdReason(blocked.path, blocked.intent_id)}` };
  }

  /**
   * Why a change for `intentId` that writes these files goes back now (it writes, or deletes, a file held for another
   * intent's split), or null. Fails open: an alarm that cannot read its holds holds nothing back.
   */
  heldBack(writes: ReadonlyArray<{ path: Path }>, intentId: Id): string | null {
    if (writes.length === 0 || !this.on()) return null;
    const holds = this.safeStanding();
    if (holds.length === 0) return null;
    const written = new Set(writes.map((w) => w.path));
    const h = holds.find((x) => x.intent_id !== intentId && written.has(x.path));
    return h ? holdReason(h.path, h.intent_id) : null;
  }

  /**
   * For a change to a split intent: a check that records the held file and its lines before (when it was held) and
   * after this change, from the change's own text (not known for a pushed commit). It goes in the change's evidence,
   * so the lineage note of the landing keeps it. Null for any other change, or while the alarm is off.
   */
  splitCheck(intentId: Id, writes: ReadonlyArray<{ path: Path; blob: Sha | null }>, contents: Readonly<Record<Sha, string>> | null): CheckResult | null {
    if (writes.length === 0 || !this.on()) return null;
    const h = this.safeStanding().find((x) => x.intent_id === intentId);
    if (!h) return null;
    const n = numbersOf(h.numbers);
    const w = writes.find((x) => x.path === h.path);
    const text = w?.blob ? contents?.[w.blob] : undefined;
    const after = !w ? null : w.blob === null ? 0 : typeof text === "string" ? lineCount(text) : null;
    const plural = (k: number): string => `${k} line${k === 1 ? "" : "s"}`;
    const before = n.lines !== null ? `${plural(n.lines)} when it was held${n.baseline !== null ? ` (${n.baseline} when its window opened)` : ""}` : "its length when it was held is not known";
    const now = !w ? "this change leaves it as it was" : after !== null ? `${plural(after)} after this change` : "its length after this change is not known (a pushed commit)";
    return { name: "megafile: split", ok: true, ms: 0, detail: `${h.path}: ${before}; ${now}` };
  }

  // -------------------------------------------------------------------------
  // Signals: landings and returns
  // -------------------------------------------------------------------------

  /**
   * A landing arrived (ColonyDO.onLanding, before its proposals settle, while an inline change's texts are still
   * kept). For each watched file it changed: the agents that wrote it and its length after, when a change's own text
   * that landed as written says it. A held file whose split intent landed is released, the split's length after it
   * recorded; then the files it changed are looked at again. Never throws.
   */
  landed(l: Landing): void {
    try {
      if (!l || typeof l.id !== "string" || !this.on()) return;
      const now = this.host.now();
      const holds = this.standing(now);
      const { files, intents } = this.changesOf(l, holds);
      for (const [path, c] of files) {
        this.host.sql.exec("INSERT OR IGNORE INTO megafile_writes (path, landing_id, at, lines, agents) VALUES (?, ?, ?, ?, ?)", path, l.id, now, c.lines, JSON.stringify([...c.agents]));
      }
      const unmeasured: HoldRow[] = [];
      for (const h of holds) {
        if (!intents.has(h.intent_id)) continue;
        const after = files.get(h.path)?.lines ?? null;
        this.lift(h, "landed", now, after, l.id);
        if (after === null && files.has(h.path)) unmeasured.push(h);
      }
      this.prune(now);
      const paths = [...files.keys()].filter((p) => watchedPath(p));
      // Once the colony has settled the landing's proposals and intents (a landed split intent is no longer live).
      if (paths.length > 0 || unmeasured.length > 0) this.host.waitUntil(Promise.resolve().then(() => this.afterLanding(l.id, paths, unmeasured)));
    } catch (err) {
      console.warn(`megafile: landing ${l?.id} not recorded: ${errorText(err)}`);
    }
  }

  /**
   * Changes that settled (ColonyDO.deliverOutcomes). One that went back for a collision counts against each watched
   * file it wrote that its reason names; those files are then looked at again. A file a change only read does not
   * count: changes that read a widely imported file go back together whenever it changes (assumption revalidation's
   * case), which says it is a hub, not that it is too big. Never throws.
   */
  returned(list: readonly Proposal[]): void {
    try {
      if (!Array.isArray(list) || list.length === 0 || !this.on()) return;
      const now = this.host.now();
      const touched = new Set<Path>();
      for (const p of list) {
        if (!p || p.status !== "returned" || !collisionReason(p.reason)) continue;
        const reason = p.reason ?? "";
        const writes: ReadonlyArray<{ path?: unknown }> = Array.isArray(p.writeSet) ? p.writeSet : [];
        const paths = new Set(writes.map((f) => f?.path));
        for (const path of paths) {
          if (typeof path !== "string" || !watchedPath(path) || !namesPath(reason, path)) continue;
          this.host.sql.exec("INSERT OR IGNORE INTO megafile_returns (path, proposal_id, at) VALUES (?, ?, ?)", path, p.id, now);
          touched.add(path);
        }
      }
      if (touched.size > 0) this.host.waitUntil(Promise.resolve().then(() => this.evaluate([...touched])));
    } catch (err) {
      console.warn(`megafile: returns not recorded: ${errorText(err)}`);
    }
  }

  /** The watched files a landing changed (and held ones, whatever their kind), and the intents it completed. */
  private changesOf(l: Landing, holds: readonly HoldRow[]): { files: Map<Path, FileChange>; intents: Set<Id> } {
    const held = new Set(holds.map((h) => h.path));
    const wanted = (path: unknown): path is Path => typeof path === "string" && (watchedPath(path) || held.has(path));
    // Text merge: a file the trunk writer merged landed as a blob no change sent, so no change's text gives its length.
    const merged = new Set((Array.isArray(l.merged) ? l.merged : []).map((m) => `${m?.proposalId}\u0000${m?.path}`));
    const files = new Map<Path, FileChange>();
    const intents = new Set<Id>((Array.isArray(l.intentIds) ? l.intentIds : []).filter((x) => typeof x === "string"));
    const entry = (path: Path): FileChange => {
      let c = files.get(path);
      if (!c) files.set(path, (c = { agents: new Set(), lines: null, writers: 0 }));
      return c;
    };
    for (const pid of Array.isArray(l.proposalIds) ? l.proposalIds : []) {
      const p = this.host.proposal(pid);
      if (!p) continue;
      intents.add(p.intentId);
      let texts: Record<Sha, string> | null | undefined;
      for (const w of Array.isArray(p.writeSet) ? p.writeSet : []) {
        if (!wanted(w?.path)) continue;
        const c = entry(w.path);
        c.agents.add(p.agentId);
        c.writers++;
        if (w.blob === null) {
          c.lines = 0;
        } else if (merged.has(`${p.id}\u0000${w.path}`)) {
          c.lines = null;
        } else {
          if (texts === undefined) texts = this.host.contents(p.id);
          const text = texts?.[w.blob];
          c.lines = typeof text === "string" ? lineCount(text) : null;
        }
      }
    }
    // A file two changes of the landing wrote: neither text alone is what landed.
    for (const c of files.values()) if (c.writers > 1) c.lines = null;
    // Files the landing changed that no change the colony knows wrote (a revert, a system commit): length and writers not known.
    for (const path of Array.isArray(l.paths) ? l.paths : []) if (wanted(path) && !files.has(path)) entry(path);
    return { files, intents };
  }

  /** After a landing: the length of a split file no change's text gave, then the files the landing changed. */
  private async afterLanding(landingId: Id, paths: Path[], unmeasured: HoldRow[]): Promise<void> {
    for (const h of unmeasured) {
      const text = await this.read(h.path);
      if (text === null) continue;
      const n = lineCount(text);
      this.host.sql.exec("UPDATE megafile_holds SET lines_after = ? WHERE id = ?", n, h.id);
      this.host.sql.exec("UPDATE megafile_writes SET lines = ? WHERE path = ? AND landing_id = ? AND lines IS NULL", n, h.path, landingId);
    }
    await this.evaluate(paths);
  }

  /**
   * Look at these files again: a file that is hot now, not held and with no split intent still live, gets its split
   * intent and its hold. When only the file's length is missing for the growth signal, it is read from trunk, for that
   * file only. Never throws.
   */
  private async evaluate(paths: readonly Path[]): Promise<void> {
    for (const path of paths) {
      try {
        if (!this.on() || !this.possible(path, this.host.now()) || !this.free(path, this.host.now())) continue;
        let m = this.measure(path, this.host.now());
        if (!m.hot.hot && m.newest !== null && lines(m.newest.lines) === null && m.hot.agents >= this.t.minAgents) {
          const text = await this.read(path);
          if (text === null) continue;
          this.host.sql.exec("UPDATE megafile_writes SET lines = ? WHERE path = ? AND landing_id = ?", lineCount(text), path, m.newest.landing_id);
          m = this.measure(path, this.host.now());
        }
        if (m.hot.hot && this.free(path, this.host.now())) await this.hold(path, numbersFrom(m.hot), COLONY_BY);
      } catch (err) {
        console.warn(`megafile: ${path} not checked: ${errorText(err)}`);
      }
    }
  }

  /**
   * Whether either signal could fire for a file: enough writers in the window (summed per landing, never fewer than
   * the distinct ones), or enough returns. Two sums on an index: most files a landing touches stop here.
   */
  private possible(path: Path, now: number): boolean {
    const start = now - this.t.windowMs;
    const sum = (q: string): number => Number((this.host.sql.exec(q, path, start).toArray()[0] as { n?: unknown } | undefined)?.n ?? 0);
    return (
      sum("SELECT COALESCE(SUM(json_array_length(agents)), 0) AS n FROM megafile_writes WHERE path = ? AND at > ? AND json_valid(agents)") >= this.t.minAgents ||
      sum("SELECT COUNT(*) AS n FROM megafile_returns WHERE path = ? AND at > ?") >= this.t.minReturns
    );
  }

  /** A file's hotness now, from what the colony recorded, with the newest landing within the window. */
  private measure(path: Path, now: number): { hot: Hotness; newest: WriteRow | null } {
    const start = now - this.t.windowMs;
    const inside = this.host.sql.exec("SELECT landing_id, at, lines, agents FROM megafile_writes WHERE path = ? AND at > ? ORDER BY at", path, start).toArray() as WriteRow[];
    const before = this.host.sql
      .exec("SELECT landing_id, at, lines, agents FROM megafile_writes WHERE path = ? AND at <= ? AND lines IS NOT NULL ORDER BY at DESC LIMIT 1", path, start)
      .toArray() as WriteRow[];
    const returns = this.host.sql.exec("SELECT at FROM megafile_returns WHERE path = ? AND at > ?", path, start).toArray() as Array<{ at: number }>;
    const writes: PathWrite[] = [...before, ...inside].map((r) => ({ at: r.at, lines: lines(r.lines), agents: agentsOf(r.agents) }));
    return { hot: hotness(path, writes, returns, now, this.t), newest: inside[inside.length - 1] ?? null };
  }

  /** Whether the alarm may hold a file: not held, not being held, and no split intent for it still live. */
  private free(path: Path, now: number): boolean {
    if (this.declaring.has(path)) return false;
    if (this.standing(now).some((h) => h.path === path)) return false;
    return this.liveSplit(path) === null;
  }

  /** The split intent last declared for a file while it is still live (open, claimed or proposed, no report waiting), or null. */
  private liveSplit(path: Path): Id | null {
    const row = this.host.sql.exec("SELECT intent_id FROM megafile_holds WHERE path = ? ORDER BY at DESC LIMIT 1", path).toArray()[0] as { intent_id: string } | undefined;
    if (!row) return null;
    const intent = this.host.intent(row.intent_id);
    return intent && LIVE.has(intent.status) && !intent.reported ? row.intent_id : null;
  }

  // -------------------------------------------------------------------------
  // Holding and lifting
  // -------------------------------------------------------------------------

  /**
   * Hold a file: its split intent (the live one, else a new one), the hold, and the changes on their way that write
   * the file sent back with the hold's reason, so none lands under the split.
   */
  private async hold(path: Path, n: HoldNumbers, by: string): Promise<HoldRow> {
    this.declaring.add(path);
    try {
      const intentId = this.liveSplit(path) ?? (await this.host.declare(splitIntent(path, n, by))).id;
      const now = this.host.now();
      const row: HoldRow = { id: newId("mfh_"), path, intent_id: intentId, held_by: by, at: now, ends_at: now + HOLD_MS, numbers: JSON.stringify(n), lifted_at: null, lifted: null, lines_after: null };
      this.host.sql.exec(
        "INSERT INTO megafile_holds (id, path, intent_id, held_by, at, ends_at, numbers, lifted_at, lifted, lines_after) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
        row.id,
        row.path,
        row.intent_id,
        row.held_by,
        row.at,
        row.ends_at,
        row.numbers,
      );
      this.cache = null;
      console.log(`megafile: ${path} held for split intent ${intentId} by ${by} (${holdNumbersText({ ...n })})`);
      const back = this.host.inFlight(path, intentId);
      if (back.length > 0) await this.host.sendBack(back.map((id) => ({ id, reason: holdReason(path, intentId) })));
      return row;
    } finally {
      this.declaring.delete(path);
    }
  }

  /**
   * The holds standing now. A hold whose time ran out, or whose split intent landed, was withdrawn, was reported or is
   * gone, is lifted on the way. Reused for HOLDS_TTL_MS unless `fresh`.
   */
  private standing(now: number, fresh = false): HoldRow[] {
    if (!fresh && this.cache && now - this.cache.at >= 0 && now - this.cache.at < HOLDS_TTL_MS) return this.cache.rows.filter((h) => h.ends_at > now);
    const rows = this.host.sql.exec("SELECT * FROM megafile_holds WHERE lifted_at IS NULL ORDER BY at").toArray() as HoldRow[];
    const out: HoldRow[] = [];
    for (const h of rows) {
      const ended = this.ended(h, now);
      if (ended) this.lift(h, ended.reason, ended.at, null, null);
      else out.push(h);
    }
    this.cache = { at: now, rows: out };
    return out;
  }

  /** The holds standing now for take and propose, or none when they cannot be read (logged). */
  private safeStanding(): HoldRow[] {
    try {
      return this.standing(this.host.now());
    } catch (err) {
      console.warn(`megafile: holds not read, nothing held back: ${errorText(err)}`);
      return [];
    }
  }

  /** Why a hold has ended without anyone lifting it, and when; null while it stands. */
  private ended(h: HoldRow, now: number): { reason: string; at: number } | null {
    if (h.ends_at <= now) return { reason: "expired", at: h.ends_at };
    const intent = this.host.intent(h.intent_id);
    if (!intent) return { reason: "its split intent is gone", at: now };
    if (intent.status === "withdrawn") return { reason: "withdrawn", at: now };
    if (intent.reported) return { reason: "escalated", at: now };
    if (!LIVE.has(intent.status)) return { reason: intent.status, at: now };
    return null;
  }

  /**
   * Lift a hold, keeping why and, for a split that landed, the file's length after it. The file starts afresh: the
   * landings and returns that made it hot are forgotten (a landed split's own landing stays, as the next baseline),
   * so it turns hot again only on new evidence.
   */
  private lift(h: HoldRow, reason: string, at: number, linesAfter: number | null, keepLanding: Id | null): void {
    this.host.sql.exec("UPDATE megafile_holds SET lifted_at = ?, lifted = ?, lines_after = COALESCE(?, lines_after) WHERE id = ? AND lifted_at IS NULL", at, reason, linesAfter, h.id);
    this.host.sql.exec("DELETE FROM megafile_writes WHERE path = ? AND landing_id != ?", h.path, keepLanding ?? "");
    this.host.sql.exec("DELETE FROM megafile_returns WHERE path = ?", h.path);
    this.cache = null;
    console.log(`megafile: ${h.path} released (${reason})${linesAfter !== null ? `, ${linesAfter} lines after its split` : ""}`);
  }

  /** Drop what no window needs any more (at most every PRUNE_EVERY_MS). */
  private prune(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    const cutoff = now - this.t.windowMs;
    this.host.sql.exec("DELETE FROM megafile_returns WHERE at <= ?", cutoff);
    // Older landings go, except each file's newest with a known length: the baseline of its next window.
    this.host.sql.exec(
      `DELETE FROM megafile_writes WHERE at <= ? AND (lines IS NULL OR EXISTS (
         SELECT 1 FROM megafile_writes AS n WHERE n.path = megafile_writes.path AND n.lines IS NOT NULL AND n.at <= ?
           AND (n.at > megafile_writes.at OR (n.at = megafile_writes.at AND n.landing_id > megafile_writes.landing_id))))`,
      cutoff,
      cutoff,
    );
    this.host.sql.exec("DELETE FROM megafile_holds WHERE lifted_at IS NOT NULL AND lifted_at < ?", now - LIFTED_KEEP_MS);
  }

  /** A trunk file's text for its length, or null when it cannot be read in time. */
  private async read(path: Path): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), READ_MS)));
      return await Promise.race([this.host.readFile(path), late]);
    } catch (err) {
      console.warn(`megafile: ${path} not read from trunk: ${errorText(err)}`);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // People: hold, release, status
  // -------------------------------------------------------------------------

  /**
   * A person holds a file (POST /api/colonies/:id/megafile, action "hold"): as the alarm would, whatever the file's
   * numbers, naming that person. The hold standing on the file, if any, is answered as it is (`already`). The file
   * must be on trunk. Refused (409) while the alarm is off for the colony.
   */
  async holdByHand(rawPath: string, rawBy: unknown): Promise<{ hold: MegafileHold; already: boolean }> {
    const path = this.personPath(rawPath);
    const by = cleanBy(rawBy);
    const now = this.host.now();
    const standing = this.standing(now, true).find((h) => h.path === path);
    if (standing) return { hold: toHold(standing), already: true };
    if (this.declaring.has(path)) throw ftError(409, `${path} is being held right now; ask again in a moment`);
    const text = await this.host.readFile(path);
    if (text === null) throw ftError(404, `${path} is not on trunk, so there is nothing to split`);
    // A hold that started while the file was read stands.
    const raced = this.standing(this.host.now(), true).find((h) => h.path === path);
    if (raced) return { hold: toHold(raced), already: true };
    if (this.declaring.has(path)) throw ftError(409, `${path} is being held right now; ask again in a moment`);
    const { hot } = this.measure(path, now);
    const row = await this.hold(path, { ...numbersFrom(hot), signal: "person", lines: lineCount(text) }, by);
    return { hold: toHold(row), already: false };
  }

  /**
   * A person releases a file (action "release"): its hold lifts ("released by <name>") and its split intent stays
   * open for any agent. Null when the file is not held. Refused (409) while the alarm is off for the colony.
   */
  release(rawPath: string, rawBy: unknown): MegafileHold | null {
    const path = this.personPath(rawPath);
    const by = cleanBy(rawBy);
    const now = this.host.now();
    const h = this.standing(now, true).find((x) => x.path === path);
    if (!h) return null;
    const reason = `released by ${by}`;
    this.lift(h, reason, now, null, null);
    return toHold({ ...h, lifted_at: now, lifted: reason });
  }

  /** The files held now and the holds lifted lately, for the colony's status; null while the alarm is off. */
  report(): MegafileReport | null {
    if (!this.on()) return null;
    const now = this.host.now();
    const held = this.standing(now, true).map(toHold);
    const lifted = (this.host.sql.exec("SELECT * FROM megafile_holds WHERE lifted_at IS NOT NULL ORDER BY lifted_at DESC LIMIT ?", LIFTED_LISTED).toArray() as HoldRow[]).map(toHold);
    return { at: now, held, lifted };
  }

  /** A path a person named, checked: the alarm is on, and it is one file (no glob, no directory, no ".."). */
  private personPath(raw: string): Path {
    if (!this.on()) throw ftError(409, "the megafile alarm is off for this colony (FT_MEGAFILE); nothing is held");
    const path = normalizePath(typeof raw === "string" ? raw : "");
    if (path === "" || path.endsWith("/") || /[*?{}[\]]/.test(path) || path.split("/").includes("..") || /[\x00-\x1f\x7f]/.test(path)) {
      throw ftError(400, `"${String(raw).slice(0, 200)}" is not a file path: name one file, with no glob`);
    }
    return path;
  }
}

/** A hold's numbers from a hotness reading (the signal that fired; growth when none did). */
function numbersFrom(h: Hotness): HoldNumbers {
  return { signal: h.signal ?? "growth", lines: h.lines, baseline: h.baseline, growth: h.growth, agents: h.agents, returns: h.returns, windowMs: h.windowMs };
}
