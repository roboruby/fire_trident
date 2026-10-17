import { MODEL_PRICES, colonySpend, modelPrice, usdText } from "@fire_trident/core";
import type { Id, LayerUsage, SpendCap, SpendCapState, SpendLayer } from "@fire_trident/core";
import type { ModelClient, ModelReply } from "../agents/loop.ts";
import type { ChatMessage } from "../agents/prompt.ts";
import { extractUsage } from "../agents/prompt.ts";
import type { AiRunner } from "../decide/reflex.ts";
import { decodeError, errorText, ftError } from "./errors.ts";
import { cleanBy, isPauseRefusal, pauseError, type PauseAnswer, type ResumeAnswer, type SqlRunner } from "./pause.ts";
import { counterUsage, type AgentModelUsage, type ReviewConfig } from "./spend.ts";

/**
 * The spend cap (no flag: nothing changes until a person sets one). A person caps what the model calls this platform
 * makes for one colony may cost (POST /api/colonies/:id/spend-cap, `ft spend-cap`), keeping part of it for review.
 * Only the platform's own calls count: in-platform agents, review, the contest judge, the conflict resolver, antibody
 * minting. What an external agent spends on its own model is never seen here.
 *
 * Reservations. Every model call is reserved before it starts and settled after, at the price of the tokens it
 * reported, so calls in flight together cannot pass the cap. The colony object holds the book (it is the one place that
 * sees every call): its own calls reserve in process (cappedAi, cappedClient), and an in-platform agent, which runs in
 * its own AgentDO, asks the colony over RPC before each call and settles after it (agentCapGate, ColonyDO.spendReserve
 * and spendSettle): one round trip before a call and one after, against calls that take seconds. A call is reserved at
 * its prompt's size (CHARS_PER_TOKEN characters a token) and its output limit, at the model's list price, twice when
 * a hedged copy may go out (FT_HEDGE); settling releases what it did not use. A hold never settled (its caller died) is
 * dropped after HOLD_TTL_MS.
 *
 * What counts as spent: the colony's spend as it last counted it (the agents' journals as last read, its own counters),
 * or the spend when the cap was set plus every call settled since, whichever is more. The second is current to the
 * call (journals are read every 15 s); the first catches a call no reservation saw (one in flight when the cap was set,
 * an agent on the previous code during a deploy, a call whose settle was lost). A model with no list price is held to
 * the dearest listed one: nothing is free against the cap.
 *
 * At the cap. Every call but review's stops at the cap minus the review reserve (the agents' share): the call that does
 * not fit is refused and the pause switch trips (colony/pause.ts), as SPEND_CAP_ACTOR, with the spend in its reason;
 * so does a settled call that brings the spend to the share. The pause stops takes and new changes; changes already in
 * flight still get their deterministic proof, and review may call from the reserve. When the reserve has no room
 * either, review makes no model call: the decide stage reads the refusal as the model being unavailable, and the gate
 * sends the change to a person (rule L8, decide/gate.ts), never to its lane. Raising the cap past the spend, or removing
 * it, lifts the pause the cap tripped; a person who resumes while the spend is still at the cap is told that the next
 * model call pauses the agents again.
 *
 * Stored in the colony's own storage (`spend_cap`, one row; `spend_cap_holds`): it survives a restart.
 */

/** Who the pause names when the cap trips it. */
export const SPEND_CAP_ACTOR = "platform:spend-cap";
/** Characters of prompt a reservation counts as one input token (code and JSON run 3 to 4, so this errs high). */
export const CHARS_PER_TOKEN = 3;
/** Output tokens a reservation assumes for a call that sets no limit. */
export const DEFAULT_OUTPUT_TOKENS = 4_000;
/** A hold not settled in this long is dropped (an agent's call times out at 180 s, a hedged one runs at most 240 s). */
export const HOLD_TTL_MS = 10 * 60_000;
/** The review reserve when a person sets a cap without one: this share of the cap. */
export const DEFAULT_RESERVE_SHARE = 0.1;
/** The largest cap a person may set (USD). */
export const MAX_CAP_USD = 1_000_000;
/** The status a refused call throws (the colony's state conflicts with the call). */
export const SPEND_CAP_STATUS = 409;
/** How long a reservation trusts the colony's spend as last counted, and how often it asks for the journals to be read. */
const BOOK_TTL_MS = 1_000;
const REFRESH_EVERY_MS = 5_000;
/** Float noise below this is no money. */
const EPSILON = 1e-9;

/**
 * What a model call is for: review (the reflex and the second opinion of a change that may land) may use the reserve;
 * agents, the contest judge, the conflict resolver and the rest (antibody minting, vaccines) may not.
 */
export type CapUse = SpendLayer;

/** The refusals' first words: the decide stage tells a refused call from an outage by them (isSpendCapRefusal). */
const REFUSAL = /^spend cap: /;

/** The review call's refusal. No figures: call sites read digits such as 429 as throttling (decide/reflex.ts isThrottled). */
export const REVIEW_REFUSAL = "spend cap: review made no model call, the review reserve of the colony's spend cap has no room left; a person decides this change";
/** Any other call's refusal inside the colony (the judge, the resolver, antibody minting), with no figures for the same reason. */
export const SHARE_REFUSAL = "spend cap: no model call, the colony's spend cap is reached for everything but review; a person raises the cap or waits";
/**
 * A call that would fit once the calls in flight settle: it waits (status 429, so call sites back off as for a throttled
 * model) and nothing trips. Its first words are not the refusals': review reads it as an outage, not as the cap.
 */
export const BUSY_REFUSAL = "model calls in flight hold what is left of the colony's spend cap; this call waits for them to settle and tries again";
/** The status a call that waits for the calls in flight throws. */
export const BUSY_STATUS = 429;

/** Was this error, or this error text, a call the spend cap refused (in the colony, or an agent's pause refusal from it)? */
export function isSpendCapRefusal(err: unknown): boolean {
  const message = typeof err === "string" ? err : decodeError(err).message;
  if (REFUSAL.test(message)) return true;
  return isPauseRefusal(err) && message.includes(`by ${SPEND_CAP_ACTOR}:`);
}

/** The price the cap holds a model to, per million tokens: its list price, else the dearest listed one. */
export function capPrice(model: string): { input: number; output: number } {
  const p = modelPrice(model);
  if (p) return p;
  let best = { input: 0, output: 0 };
  for (const q of Object.values(MODEL_PRICES)) if (q.input + q.output > best.input + best.output) best = q;
  return best;
}

/** A finite, non-negative number, or 0. */
function amount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Dollars kept to 1e-8. */
function round(usd: number): number {
  return Math.round(usd * 1e8) / 1e8;
}

/**
 * What a reservation holds for one call: its prompt (characters) and its output limit at the cap's price for the model.
 * A call with no output limit (null) is held at DEFAULT_OUTPUT_TOKENS.
 */
export function estimateUsd(model: string, chars: number, maxOutputTokens: number | null): number {
  const p = capPrice(model);
  const input = Math.ceil(amount(chars) / CHARS_PER_TOKEN);
  const output = maxOutputTokens === null ? DEFAULT_OUTPUT_TOKENS : Math.ceil(amount(maxOutputTokens));
  return (input * p.input + output * p.output) / 1_000_000;
}

/** What a settled call cost against the cap: its reported tokens at the cap's price (nothing reported, nothing spent). */
export function settledUsd(model: string, usage: { input?: number; output?: number } | null | undefined): number {
  if (!usage) return 0;
  const p = capPrice(model);
  return (Math.floor(amount(usage.input)) * p.input + Math.floor(amount(usage.output)) * p.output) / 1_000_000;
}

/** The characters of a Workers AI request a reservation counts (its messages, or Clef's state and questions). */
export function requestChars(input: Record<string, unknown>): number {
  try {
    return JSON.stringify(input ?? {}).length;
  } catch {
    return 0;
  }
}

/** The characters of a chat a reservation counts. */
export function messagesChars(messages: readonly ChatMessage[]): number {
  return (messages ?? []).reduce((n, m) => n + (typeof m?.content === "string" ? m.content.length : 0) + 8, 0);
}

/** The pause's reason at the cap: "spend cap: $X of $Y spent on model calls this platform made". */
export function capReason(spentUsd: number, capUsd: number): string {
  return `spend cap: ${usdText(spentUsd)} of ${usdText(capUsd)} spent on model calls this platform made`;
}

/** The colony's spend as it last counted it, in USD: the agents' usage as last read and its own counters (colony/spend.ts). */
export function bookUsd(agents: readonly AgentModelUsage[], metrics: Readonly<Record<string, number>>, review: ReviewConfig): number {
  const usage: LayerUsage[] = [...agents.map((u) => ({ layer: "agents" as const, model: u.model, input: u.input, output: u.output })), ...counterUsage(metrics, review)];
  // A model with no list price counts at the dearest listed one, as the cap holds it (core/pricing.ts leaves it out).
  let extra = 0;
  for (const u of usage) if (!modelPrice(u.model)) extra += settledUsd(u.model, u);
  return colonySpend(usage, 0).usd + extra;
}

/** Create the cap's tables (additive: nothing existing is touched). */
export function migrateSpendCap(sql: SqlRunner): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS spend_cap (id INTEGER PRIMARY KEY CHECK (id = 1), usd REAL NOT NULL, reserve_usd REAL NOT NULL, baseline_usd REAL NOT NULL, settled_usd REAL NOT NULL, set_by TEXT NOT NULL, set_at INTEGER NOT NULL)",
  );
  sql.exec("CREATE TABLE IF NOT EXISTS spend_cap_holds (id TEXT PRIMARY KEY, use TEXT NOT NULL, usd REAL NOT NULL, unit_usd REAL NOT NULL, at INTEGER NOT NULL)");
}

/** What the cap uses of its colony (ColonyDO builds it; tests fake it). */
export interface SpendCapHost {
  sql: SqlRunner;
  now(): number;
  /** The colony's spend as it last counted it, in USD (bookUsd), without reading any journal. */
  bookUsd(): number;
  /** Ask for the agents' journals that are due to be read again (the spend book reads only those); best effort. */
  refreshBook?(): void;
  /** The colony's own pause in force (who paused), or null. */
  ownPause(): { by: string } | null;
  /** Trip the pause switch as SPEND_CAP_ACTOR, with this reason. */
  trip(reason: string): Promise<PauseAnswer | unknown>;
  /** Resume the colony's agents, as `by` (the person who raised or removed the cap), with this reason. */
  lift(by: string, reason: string): Promise<ResumeAnswer | unknown>;
  waitUntil(p: Promise<unknown>): void;
}

/**
 * A reservation's answer: the hold to settle (null with no cap: nothing to settle), or the refusal, with `busy` when the
 * call would fit once the calls in flight settle (it waits, and nothing trips).
 */
export type CapHold = { ok: true; hold: Id | null } | { ok: false; reason: string; busy: boolean };

/** What setting or removing the cap answers. */
export interface SpendCapAnswer {
  cap: SpendCap | null;
  /** The pause the cap had tripped was lifted (the cap now has room, or is gone). */
  lifted: boolean;
  /** The pause tripped now: the cap is already reached. */
  tripped: boolean;
  /** What happens now, in one or two sentences. */
  note: string;
}

type CapRow = { usd: number; reserve_usd: number; baseline_usd: number; settled_usd: number; set_by: string; set_at: number };

/** A dollar figure a person sent: positive, finite, at most MAX_CAP_USD; null when it is not one. */
function dollars(v: unknown, allowZero = false): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v.trim().replace(/^\$/, "")) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_CAP_USD) return null;
  if (n === 0 && !allowZero) return null;
  return round(n);
}

/** One colony's spend cap: the cap, the holds of calls in flight, and the pause it trips. */
export class SpendCapBook {
  private book: { at: number; usd: number } | null = null;
  private refreshedAt = 0;

  constructor(private readonly host: SpendCapHost) {
    migrateSpendCap(host.sql);
  }

  private row(): CapRow | null {
    return (this.host.sql.exec("SELECT usd, reserve_usd, baseline_usd, settled_usd, set_by, set_at FROM spend_cap WHERE id = 1").toArray()[0] as CapRow | undefined) ?? null;
  }

  /** The colony's spend as last counted, trusted for BOOK_TTL_MS (a reservation does not scan the counters each time). */
  private counted(now: number, fresh = false): number {
    if (!fresh && this.book && now - this.book.at < BOOK_TTL_MS) return this.book.usd;
    let usd = this.book?.usd ?? 0;
    try {
      usd = amount(this.host.bookUsd());
    } catch (err) {
      console.warn(`spend cap: the colony's spend was not counted, the last count stands: ${errorText(err)}`);
    }
    this.book = { at: now, usd };
    return usd;
  }

  /** What the cap counts as spent (see the module comment): the spend as counted, or the spend at the cap plus every call settled since. */
  private spent(r: CapRow, now: number, fresh = false): number {
    return Math.max(this.counted(now, fresh), amount(r.baseline_usd) + amount(r.settled_usd));
  }

  /** Reserved for calls in flight; holds past HOLD_TTL_MS are dropped first. */
  private inFlight(now: number): number {
    this.host.sql.exec("DELETE FROM spend_cap_holds WHERE at < ?", now - HOLD_TTL_MS);
    const r = this.host.sql.exec("SELECT COALESCE(SUM(usd), 0) AS usd FROM spend_cap_holds").toArray()[0] as { usd?: number } | undefined;
    return amount(r?.usd);
  }

  /** The cap as it stands (null: no cap). */
  state(): SpendCap | null {
    const r = this.row();
    if (!r) return null;
    const now = this.host.now();
    const spent = this.spent(r, now, true);
    const state: SpendCapState = spent + EPSILON >= r.usd ? "spent" : spent + EPSILON >= r.usd - r.reserve_usd ? "review-only" : "open";
    return { usd: r.usd, reviewReserveUsd: r.reserve_usd, spentUsd: round(spent), inFlightUsd: round(this.inFlight(now)), state, setBy: r.set_by, setAt: r.set_at };
  }

  /**
   * Set the cap (or raise or lower it) to `usd`, keeping `reviewReserveUsd` of it for review: the reserve given, else the
   * one kept so far (when it is still below the cap), else DEFAULT_RESERVE_SHARE of the cap. With room under the new cap,
   * a pause the cap tripped is lifted; with none, the pause trips now.
   */
  async set(p: { usd: unknown; reviewReserveUsd?: unknown; by: unknown }): Promise<SpendCapAnswer> {
    const usd = dollars(p?.usd);
    if (usd === null) throw ftError(400, `the cap must be a dollar amount above 0 and at most ${MAX_CAP_USD.toLocaleString("en-US")}, such as 5 or 12.50`);
    const prev = this.row();
    const given = p?.reviewReserveUsd;
    let reserve: number | null;
    if (given === undefined || given === null) reserve = prev && prev.reserve_usd < usd ? prev.reserve_usd : round(usd * DEFAULT_RESERVE_SHARE);
    else reserve = dollars(given, true);
    if (reserve === null || reserve >= usd) throw ftError(400, `the review reserve must be a dollar amount of at least 0 and below the cap of ${usdText(usd)}`);
    const by = cleanBy(p?.by);
    const now = this.host.now();
    if (prev) {
      this.host.sql.exec("UPDATE spend_cap SET usd = ?, reserve_usd = ?, set_by = ?, set_at = ? WHERE id = 1", usd, reserve, by, now);
    } else {
      // The ledger starts at the colony's spend now: the cap covers everything the colony spent, before it too.
      this.host.sql.exec(
        "INSERT INTO spend_cap (id, usd, reserve_usd, baseline_usd, settled_usd, set_by, set_at) VALUES (1, ?, ?, ?, 0, ?, ?)",
        usd,
        reserve,
        this.counted(now, true),
        by,
        now,
      );
    }
    const r = this.row()!;
    const spent = this.spent(r, now, true);
    const share = usd - reserve;
    const own = this.host.ownPause();
    let lifted = false;
    let tripped = false;
    if (spent + this.inFlight(now) < share - EPSILON) {
      if (own?.by === SPEND_CAP_ACTOR) {
        await this.host.lift(by, `spend cap raised to ${usdText(usd)}`);
        lifted = true;
      }
    } else if (!own) {
      await this.host.trip(capReason(spent, usd));
      tripped = true;
    }
    const head = `Model calls this platform makes for the colony stop at ${usdText(usd)}: everything but review at ${usdText(share)}, and review keeps ${usdText(reserve)} for changes in flight. ${usdText(spent)} spent so far.`;
    const tail = tripped
      ? " That is already at the cap, so the agents are paused now; raise the cap to let them go on."
      : lifted
        ? " The pause the cap had tripped is lifted: agents may work again."
        : own?.by === SPEND_CAP_ACTOR
          ? " The cap is still reached, so the agents stay paused; raise it further to let them go on."
          : "";
    return { cap: this.state(), lifted, tripped, note: head + tail };
  }

  /** Remove the cap: calls go on with no limit, and a pause the cap tripped is lifted. */
  async clear(p: { by: unknown }): Promise<SpendCapAnswer> {
    const had = this.row() !== null;
    this.host.sql.exec("DELETE FROM spend_cap");
    this.host.sql.exec("DELETE FROM spend_cap_holds");
    let lifted = false;
    if (this.host.ownPause()?.by === SPEND_CAP_ACTOR) {
      await this.host.lift(cleanBy(p?.by), "spend cap removed");
      lifted = true;
    }
    const note = had ? `No spend cap: model calls go on with no limit.${lifted ? " The pause the cap had tripped is lifted: agents may work again." : ""}` : "There was no spend cap: model calls go on with no limit.";
    return { cap: null, lifted, tripped: false, note };
  }

  /**
   * Reserve `usd` for a call (`copies` times when a hedged copy may go out) before it starts. With no cap, nothing is held
   * and the call goes on as before. A call that does not fit is refused: review's while the cap itself has no room for
   * it, any other's while the agents' share (the cap minus the review reserve) has none. One that would fit once the
   * calls in flight settle is `busy`: it waits and nothing trips. Otherwise the pause trips (a review refusal trips it
   * only once the agents' share is spent).
   */
  reserve(p: { use: CapUse; usd: number; copies?: number }): CapHold {
    const r = this.row();
    if (!r) return { ok: true, hold: null };
    const now = this.host.now();
    if (now - this.refreshedAt >= REFRESH_EVERY_MS) {
      this.refreshedAt = now;
      try {
        this.host.refreshBook?.();
      } catch {
        // A journal read that does not start leaves the last count standing.
      }
    }
    const unit = amount(p.usd);
    // One call, or two when a hedged copy may go out.
    const want = unit * Math.min(2, Math.max(1, Math.floor(amount(p.copies) || 1)));
    const spent = this.spent(r, now);
    const held = this.inFlight(now);
    const share = r.usd - r.reserve_usd;
    const limit = p.use === "review" ? r.usd : share;
    if (spent + held + want <= limit + EPSILON) {
      const hold = `hld_${crypto.randomUUID()}`;
      this.host.sql.exec("INSERT INTO spend_cap_holds (id, use, usd, unit_usd, at) VALUES (?, ?, ?, ?, ?)", hold, p.use, want, unit, now);
      return { ok: true, hold };
    }
    // It fits once the calls in flight settle: it waits for them (they may cost less than they hold).
    if (held > 0 && spent + want <= limit + EPSILON) return { ok: false, reason: BUSY_REFUSAL, busy: true };
    const reason = spent >= share - EPSILON ? capReason(spent, r.usd) : `${capReason(spent, r.usd)}, and the next call (up to ${usdText(want)}) does not fit in the ${usdText(Math.max(0, share - spent))} left to agents`;
    if (p.use !== "review" || spent >= share - EPSILON) this.trip(reason);
    return { ok: false, reason, busy: false };
  }

  /**
   * Settle a call at what it cost (`usd`): its hold is released, or with `keep` (a hedged copy still out) cut to one
   * copy's reservation, to be settled again when that copy ends. A hold the book no longer has (the cap was removed, or
   * the hold expired) still counts what was spent. At the agents' share, the pause trips now, not only at the next call.
   */
  settle(hold: Id | null, usd: number, keep = false): void {
    if (hold) {
      if (keep) this.host.sql.exec("UPDATE spend_cap_holds SET usd = unit_usd WHERE id = ?", hold);
      else this.host.sql.exec("DELETE FROM spend_cap_holds WHERE id = ?", hold);
    }
    const r = this.row();
    if (!r) return;
    const add = amount(usd);
    if (add > 0) this.host.sql.exec("UPDATE spend_cap SET settled_usd = settled_usd + ? WHERE id = 1", add);
    const now = this.host.now();
    const spent = this.spent({ ...r, settled_usd: r.settled_usd + add }, now);
    if (spent >= r.usd - r.reserve_usd - EPSILON) this.trip(capReason(spent, r.usd));
  }

  /**
   * What a resume answer adds while the spend is still at the agents' share: that the next model call pauses the agents
   * again, and what to do instead. Null when the cap has room (or there is none).
   */
  resumeNote(colonyId: Id): string | null {
    const r = this.row();
    if (!r) return null;
    const spent = this.spent(r, this.host.now(), true);
    if (spent < r.usd - r.reserve_usd - EPSILON) return null;
    return `The spend cap is still reached (${capReason(spent, r.usd)}): the next model call pauses the agents again. Raise the cap first: ft spend-cap ${colonyId} <usd>.`;
  }

  /** Trip the pause (as SPEND_CAP_ACTOR), unless one of the colony's own is in force already. Never throws. */
  private trip(reason: string): void {
    if (this.host.ownPause()) return;
    try {
      this.host.waitUntil(
        Promise.resolve(this.host.trip(reason)).catch((err: unknown) => console.warn(`spend cap: the pause did not trip: ${errorText(err)}`)),
      );
    } catch (err) {
      console.warn(`spend cap: the pause did not trip: ${errorText(err)}`);
    }
  }
}

/** The error a refused call inside the colony throws: it waits (busy), or review's refusal, or everything else's. */
function refusal(held: { busy: boolean }, use: CapUse): Error {
  if (held.busy) return ftError(BUSY_STATUS, BUSY_REFUSAL);
  return ftError(SPEND_CAP_STATUS, use === "review" ? REVIEW_REFUSAL : SHARE_REFUSAL);
}

/** Settle without failing the call (a lost settle is dropped with its hold after HOLD_TTL_MS). */
function quietly(p: () => unknown): void {
  try {
    const out = p();
    if (out && typeof (out as Promise<unknown>).catch === "function") void (out as Promise<unknown>).catch(() => undefined);
  } catch {
    // Settling never fails a call.
  }
}

/**
 * The Workers AI binding with every run reserved against the colony's spend cap before it starts and settled after, at
 * the tokens it reported. With no cap each run goes out exactly as before. A refused run throws (SPEND_CAP_STATUS) a
 * refusal its call site reads as the model being unavailable: no model answered, so nothing was approved.
 */
export function cappedAi(ai: AiRunner, cap: Pick<SpendCapBook, "reserve" | "settle">, use: CapUse): AiRunner {
  return {
    run: async (model, input, options) => {
      const call = (): Promise<unknown> => (options === undefined ? ai.run(model, input) : ai.run(model, input, options));
      // Clef answers typed questions and reports no output tokens; any other call with no limit is held at the default.
      const maxTokens = typeof input?.max_tokens === "number" ? input.max_tokens : model.includes("/clef") ? 0 : null;
      const held = cap.reserve({ use, usd: estimateUsd(model, requestChars(input), maxTokens) });
      if (!held.ok) throw refusal(held, use);
      if (held.hold === null) return call();
      const hold = held.hold;
      let res: unknown;
      try {
        res = await call();
      } catch (err) {
        quietly(() => cap.settle(hold, 0));
        throw err;
      }
      quietly(() => cap.settle(hold, settledUsd(model, extractUsage(res))));
      return res;
    },
  };
}

/** One call a model client asks the cap for: its model (as asked: "default" and "bulk" are resolved where it is priced), prompt size and output limit. */
export interface CapAsk {
  model: string;
  chars: number;
  maxTokens: number;
  /** 2 when a hedged copy may go out (FT_HEDGE), else 1. */
  copies: number;
}

/** One call's end: the model that answered and its tokens; `keep` while a hedged copy is still out. */
export interface CapSettle {
  hold: Id;
  model: string;
  usage: { input: number; output: number } | null;
  keep?: boolean;
}

/** How a model client reserves and settles: in process for the colony's own calls, over RPC for an agent's. */
export interface CapGate {
  /** The hold to settle, or null with no cap; throws the refusal. */
  reserve(a: CapAsk): Promise<{ hold: Id | null }>;
  settle(s: CapSettle): Promise<unknown>;
}

/** A reply's tokens as the cap prices them. */
function usageOf(u: { input?: number; output?: number } | null | undefined): { input: number; output: number } | null {
  return u ? { input: Math.floor(amount(u.input)), output: Math.floor(amount(u.output)) } : null;
}

/**
 * A model client (the agents', the resolver's) with each call reserved before it starts and settled after. With no cap
 * the call goes as before. A hedged call that sent a copy settles the answer first and keeps one copy's hold until the
 * losing copy ends; a call that fails releases its hold.
 */
export function cappedClient(client: ModelClient, gate: CapGate, copies = 1): ModelClient {
  return {
    complete: async (req) => {
      const { hold } = await gate.reserve({ model: req.model, chars: messagesChars(req.messages), maxTokens: req.maxTokens, copies });
      if (hold === null) return client.complete(req);
      let reply: ModelReply;
      try {
        reply = await client.complete(req);
      } catch (err) {
        quietly(() => gate.settle({ hold, model: req.model, usage: null }));
        throw err;
      }
      const late = reply.late;
      quietly(() => gate.settle({ hold, model: reply.model ?? req.model, usage: usageOf(reply.usage), ...(late ? { keep: true } : {}) }));
      if (late) {
        void late.then(
          (l) => quietly(() => gate.settle({ hold, model: l?.model ?? req.model, usage: usageOf(l?.usage) })),
          () => quietly(() => gate.settle({ hold, model: req.model, usage: null })),
        );
      }
      return reply;
    },
  };
}

/** The colony's own gate (the conflict resolver): reservations in process, priced at the model each call resolves to. */
export function localGate(cap: Pick<SpendCapBook, "reserve" | "settle">, use: CapUse, resolve: (model: string) => string): CapGate {
  return {
    reserve: async (a) => {
      const held = cap.reserve({ use, usd: estimateUsd(resolve(a.model), a.chars, amount(a.maxTokens) || null), copies: a.copies });
      if (!held.ok) throw refusal(held, use);
      return { hold: held.hold };
    },
    settle: async (s) => cap.settle(s.hold, settledUsd(resolve(s.model), s.usage), s.keep === true),
  };
}

/** What an agent sends the colony before a call (ColonyDO.spendReserve). */
export interface AgentCapAsk extends CapAsk {
  agentId?: Id;
}

/**
 * An agent's reservation, on the colony's side (ColonyDO.spendReserve): `capped` says whether the colony has a cap.
 * Refused, it throws the pause's sentence (the cap trips the pause as it refuses), which the agent's loop reads as a
 * pause: it waits without counting a failure, keeping its job and its work. A call that only waits for the calls in
 * flight throws BUSY_STATUS, which the loop waits on as it does for a throttled model.
 */
export function agentReserve(cap: SpendCapBook, a: AgentCapAsk, resolve: (model: string) => string): { hold: Id | null; capped: boolean } {
  const model = resolve(typeof a?.model === "string" ? a.model : "");
  const held = cap.reserve({ use: "agents", usd: estimateUsd(model, amount(a?.chars), amount(a?.maxTokens) || null), copies: amount(a?.copies) || 1 });
  if (!held.ok) throw held.busy ? ftError(BUSY_STATUS, BUSY_REFUSAL) : pauseError({ by: SPEND_CAP_ACTOR, reason: held.reason });
  return { hold: held.hold, capped: held.hold !== null };
}

/** An agent's settle, on the colony's side (ColonyDO.spendSettle). */
export function agentSettle(cap: SpendCapBook, s: CapSettle, resolve: (model: string) => string): void {
  if (!s || typeof s.hold !== "string" || !s.hold.startsWith("hld_")) return;
  cap.settle(s.hold, settledUsd(resolve(typeof s.model === "string" ? s.model : ""), usageOf(s.usage)), s.keep === true);
}

/** The colony methods an agent's gate calls; a colony on the previous code has neither. */
export interface ColonyCapRpc {
  spendReserve?(a: AgentCapAsk): Promise<{ hold: Id | null; capped?: boolean }>;
  spendSettle?(s: CapSettle): Promise<unknown>;
}

/** What an agent remembers of its colony's cap between calls: whether it had one at the last answer (null: never asked). */
export interface CapMemo {
  capped: boolean | null;
}

const UNSUPPORTED = /does not implement the method/i;

/**
 * An in-platform agent's gate: it asks its colony over RPC before each model call and settles after. A colony on the
 * previous code has no cap, so the call goes on. A refusal (the pause's sentence) and any other answer with a status
 * pass to the loop as they are. When the colony does not answer, a colony known to have no cap lets the call go on as
 * before; otherwise no call starts (fail closed) and the loop waits as it does for a throttled model, counting no failure.
 */
export function agentCapGate(colony: ColonyCapRpc, agentId: Id, memo: CapMemo = { capped: null }): CapGate {
  return {
    reserve: async (a) => {
      if (typeof colony.spendReserve !== "function") return { hold: null };
      try {
        const r = await colony.spendReserve({ ...a, agentId });
        const hold = typeof r?.hold === "string" ? r.hold : null;
        memo.capped = hold !== null || r?.capped === true;
        return { hold };
      } catch (err) {
        if (UNSUPPORTED.test(errorText(err))) {
          memo.capped = false;
          return { hold: null };
        }
        if (decodeError(err).status !== 500) throw err;
        if (memo.capped === false) return { hold: null };
        throw ftError(429, `the colony did not answer its spend cap check, so no model call started; the agent tries again shortly: ${errorText(err)}`);
      }
    },
    settle: async (s) => (typeof colony.spendSettle === "function" ? colony.spendSettle(s) : undefined),
  };
}
