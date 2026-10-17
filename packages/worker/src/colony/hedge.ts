import type { Id } from "@fire_trident/core";
import { revalidationEnabled } from "@fire_trident/core";
import type { AiRunner } from "../decide/reflex.ts";

/**
 * Hedged model calls (FT_HEDGE): one slow model call must not stall the work behind it. Where the flag covers the
 * colony, a call that has given no answer after its call site's wait (HEDGE_AFTER_MS, or FT_HEDGE_MS) is sent once more:
 * the same request, to the same model, or to the site's fallback model where it has one (the second opinion's next
 * candidate, the model a throttled second opinion moves on to). The first answer wins and the other copy is aborted
 * through its AbortSignal (Workers AI takes it in the run options, the AI SDK as `abortSignal`); an error wins only once
 * both copies have failed. At most one copy goes out per call, and a site that admits its calls through a limiter
 * admits the copy too: with no slot free at that moment, no copy goes out.
 *
 * No model call the platform makes streams, so "no answer" means no reply at all, and each site waits as long as its
 * normal latency calls for (HEDGE_AFTER_MS says why).
 *
 * Spend: each copy's tokens count where the call site counts them. The winner's count as before. A losing copy that
 * answers anyway (it finished at nearly the same moment, or its provider ignored the abort) reaches the site through
 * Hedge.onLate and Hedged.late, so its tokens count too. An aborted copy reports no usage, so it counts none.
 */

/** The call sites that hedge, each with its own wait. */
export type HedgeSite = "reflex" | "review" | "judge" | "antibody" | "resolver" | "agent";

/**
 * How long a call waits for its answer before its copy goes out, per site: several times the slowest answer the recorded
 * runs show, and well inside the site's own time-out, so the copy keeps most of it.
 * - reflex: Clef answered in 0.1 to 0.35 s in the recorded runs; its calls time out at 15 s.
 * - review (the second opinion, 45 s a call), judge (the contest judge and jury, 45 s) and antibody (rephrasing a
 *   rejection, 30 s): their small models answered in 1.8 to 5.4 s.
 * - resolver: its one call sits inside a 60 s budget for the whole resolution; 20 s leaves the copy 40 s.
 * - agent: agents' calls write whole files and are capped at 180 s; a third of the cap leaves the copy two minutes.
 */
export const HEDGE_AFTER_MS: Readonly<Record<HedgeSite, number>> = {
  reflex: 3_000,
  review: 12_000,
  judge: 12_000,
  antibody: 12_000,
  resolver: 20_000,
  agent: 60_000,
};

/** The shortest and longest wait FT_HEDGE_MS may set (a wait in seconds by mistake would copy every call). */
const MIN_AFTER_MS = 1_000;
const MAX_AFTER_MS = 600_000;

/** Which copy answered a hedged call, as the decision record keeps it. Present only when a copy went out. */
export interface HedgeRecord {
  /** When the copy went out, in ms after the original. */
  after_ms: number;
  /** The copy whose answer was used. */
  winner: "original" | "copy";
  /** The model that answered. */
  model: string;
  /** Why the copy went out: the original had not answered by then ("slow"), or it had failed ("failed"). */
  cause: "slow" | "failed";
}

/** One call site's hedge (hedgeFor). */
export interface Hedge {
  site: HedgeSite;
  /** How long the original may go without an answer before the copy goes out. */
  afterMs: number;
  /** The model the copy goes to; absent, the original's. */
  copyModel?: string;
  /** Admits the copy where the site admits its calls: a release once the copy settles, or null for no copy. */
  admit?: (model: string) => Promise<(() => void) | null>;
  /** A losing copy's answer that arrived anyway, for the site to count its tokens (sites whose AI binding counts every run leave it out). */
  onLate?: (model: string, value: unknown) => void;
  /** Counts the copies sent (`hedge.<site>.sent`) and the ones whose answer was used (`hedge.<site>.copy`). */
  bump?: (name: string, delta: number) => void;
}

/** What a call site adds to its hedge. */
export type HedgeExtra = Partial<Pick<Hedge, "copyModel" | "admit" | "onLate" | "bump">>;

/** A hedged call's answer. */
export interface Hedged<T> {
  value: T;
  /** The model that answered. */
  model: string;
  /** Which copy answered, when a copy went out. */
  hedged?: HedgeRecord;
  /** When a copy went out: the losing copy's answer if it arrives anyway, or null once it failed or was aborted. */
  late?: Promise<{ model: string; value: T } | null>;
}

/** Is FT_HEDGE on for this colony? Read like FT_REVALIDATE: "on", a comma-separated list of colony ids, or off. */
export function hedgeEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * A site's wait under FT_HEDGE_MS: one number of ms for every site ("8000"), waits by site ("review=8000,agent=90000"),
 * or both, where a site's own wait wins over the one for all. Each is held to 1 s .. 10 minutes; a part that is not a
 * positive number is ignored, and a site with none keeps HEDGE_AFTER_MS. A number (wrangler.jsonc may write one) reads
 * as that number of ms.
 */
export function hedgeAfterMs(setting: string | undefined, site: HedgeSite): number {
  let all: number | null = null;
  let mine: number | null = null;
  const raw: unknown = setting;
  for (const part of (typeof raw === "string" || typeof raw === "number" ? String(raw) : "").split(",")) {
    const eq = part.indexOf("=");
    const n = Number((eq < 0 ? part : part.slice(eq + 1)).trim());
    if (!Number.isFinite(n) || n <= 0) continue;
    const ms = Math.min(MAX_AFTER_MS, Math.max(MIN_AFTER_MS, Math.round(n)));
    if (eq < 0) all = ms;
    else if (part.slice(0, eq).trim() === site) mine = ms;
  }
  return mine ?? all ?? HEDGE_AFTER_MS[site];
}

/** The hedge for one call site where FT_HEDGE covers the colony (FT_HEDGE_MS may change its wait); null where it does not. */
export function hedgeFor(env: { FT_HEDGE?: string; FT_HEDGE_MS?: string }, colonyId: Id, site: HedgeSite, extra: HedgeExtra = {}): Hedge | null {
  if (!hedgeEnabled(env?.FT_HEDGE, colonyId)) return null;
  return { site, afterMs: hedgeAfterMs(env.FT_HEDGE_MS, site), ...extra };
}

/** A Workers AI run with an abort signal in its options when there is one; without one, the call exactly as before. */
export function runAi(ai: AiRunner, model: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return signal ? ai.run(model, input, { signal }) : ai.run(model, input);
}

/**
 * Throttling, as decide/reflex.ts isThrottled and agents/llm.ts read it: a copy to the same model would only add to the
 * rate the provider just refused, so a throttled original sends none (its caller backs off as before).
 */
const THROTTLED = /rate limit|\b3021\b|\b3040\b|out of capacity|capacity temporarily|too many requests|\b429\b/i;

/** One copy of a hedged call in flight. */
interface Leg<T> {
  model: string;
  ctl: AbortController;
  state: "running" | "ok" | "failed";
  value?: T;
  error?: unknown;
}

/**
 * Make one model call through `call`, hedged when `hedge` is given (null: the call alone, with no signal, as before).
 * The copy goes out once the original has given no answer for `hedge.afterMs`, or at once when it fails first (a
 * throttled original to the same model fails at once instead). The first answer wins and the other copy is aborted;
 * an error wins only once both have failed, and it is the original's.
 */
export function hedged<T>(call: (model: string, signal?: AbortSignal) => Promise<T>, model: string, hedge: Hedge | null | undefined, now: () => number = Date.now): Promise<Hedged<T>> {
  if (!hedge) return call(model).then((value) => ({ value, model }));
  const h = hedge;
  const copyModel = typeof h.copyModel === "string" && h.copyModel.trim() !== "" ? h.copyModel : model;
  const t0 = now();
  return new Promise<Hedged<T>>((resolve, reject) => {
    let done = false;
    let copy: Leg<T> | null = null;
    let admitting = false;
    let release: (() => void) | null = null;
    let sentAt = 0;
    let cause: HedgeRecord["cause"] = "slow";
    let lateResolve: ((v: { model: string; value: T } | null) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      void send("slow");
    }, h.afterMs);

    const stopTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const freeSlot = (): void => {
      const r = release;
      release = null;
      r?.();
    };
    const count = (name: "sent" | "copy"): void => {
      try {
        h.bump?.(`hedge.${h.site}.${name}`, 1);
      } catch {
        // Counting never fails a call.
      }
    };
    const start = (m: string, who: "original" | "copy"): Leg<T> => {
      const leg: Leg<T> = { model: m, ctl: new AbortController(), state: "running" };
      let p: Promise<T>;
      try {
        p = call(m, leg.ctl.signal);
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(
        (value) => {
          leg.state = "ok";
          leg.value = value;
          answered(leg, who, value);
        },
        (error: unknown) => {
          leg.state = "failed";
          leg.error = error;
          failed(who);
        },
      );
      return leg;
    };
    const original = start(model, "original");

    function answered(leg: Leg<T>, who: "original" | "copy", value: T): void {
      if (who === "copy") freeSlot();
      if (done) {
        // The losing copy answered anyway: its tokens were spent, so the site counts them.
        try {
          h.onLate?.(leg.model, value);
        } catch {
          // Counting never fails a call.
        }
        lateResolve?.({ model: leg.model, value });
        return;
      }
      done = true;
      stopTimer();
      const loser = who === "original" ? copy : original;
      if (!loser) {
        resolve({ value, model: leg.model });
        return;
      }
      let late: Promise<{ model: string; value: T } | null>;
      if (loser.state === "running") {
        late = new Promise((r) => {
          lateResolve = r;
        });
        loser.ctl.abort();
      } else {
        late = Promise.resolve(null);
      }
      if (who === "copy") count("copy");
      resolve({ value, model: leg.model, hedged: { after_ms: sentAt, winner: who, model: leg.model, cause }, late });
    }

    function failed(who: "original" | "copy"): void {
      if (who === "copy") freeSlot();
      if (done) {
        lateResolve?.(null);
        return;
      }
      if (who === "copy") {
        if (original.state === "failed") lose();
        return;
      }
      // The original failed: a copy in flight decides; one being admitted is sent or not as admission says.
      if (copy) {
        if (copy.state === "failed") lose();
        return;
      }
      if (admitting) return;
      stopTimer();
      if (copyModel === model && THROTTLED.test(errorText(original.error))) {
        lose();
        return;
      }
      void send("failed");
    }

    function lose(): void {
      done = true;
      stopTimer();
      reject(original.error);
    }

    async function send(why: HedgeRecord["cause"]): Promise<void> {
      if (done || copy || admitting) return;
      cause = why;
      if (h.admit) {
        admitting = true;
        let slot: (() => void) | null = null;
        try {
          slot = await h.admit(copyModel);
        } catch {
          slot = null;
        }
        admitting = false;
        if (done) {
          slot?.();
          return;
        }
        if (!slot) {
          // No slot free: no copy, and the original alone decides.
          if (original.state === "failed") lose();
          return;
        }
        let freed = false;
        release = () => {
          if (freed) return;
          freed = true;
          slot();
        };
      }
      sentAt = Math.max(0, now() - t0);
      count("sent");
      copy = start(copyModel, "copy");
    }
  });
}

/** A hedge record as stored (a decision's answers) read back: null when it is not one, so old or odd data reads as no hedge. */
export function cleanHedgeRecord(v: unknown): HedgeRecord | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.winner !== "copy" && o.winner !== "original") return null;
  if (typeof o.after_ms !== "number" || !Number.isFinite(o.after_ms) || typeof o.model !== "string" || o.model.trim() === "") return null;
  return { after_ms: Math.max(0, Math.round(o.after_ms)), winner: o.winner, model: o.model.replace(/\s+/g, " ").trim().slice(0, 200), cause: o.cause === "failed" ? "failed" : "slow" };
}

/** An error's message, or the value as text. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The hedge as people read it, beside the model's answer: "answered by the hedge copy after 8.0 s", or "answered by
 * the original; its hedge copy went out after 8.0 s". With `asked` (the model the original went to), a copy that went
 * to another model names it.
 */
export function hedgeText(h: HedgeRecord, asked?: string): string {
  const after = `${(Math.max(0, h.after_ms) / 1000).toFixed(1)} s`;
  if (h.winner === "original") return `answered by the original; its hedge copy went out after ${after}`;
  const to = asked && asked !== h.model ? ` to ${h.model}` : "";
  return h.cause === "failed" ? `answered by the hedge copy${to}, sent when the original failed after ${after}` : `answered by the hedge copy${to} after ${after}`;
}

/**
 * Several hedged calls (a judge's two orders, a jury's members) as one clause, or null when no copy went out: "1 answer
 * came from a hedge copy sent after 12.0 s", or "a hedge copy went out after 12.0 s; the original answered".
 */
export function hedgeSummary(records: readonly HedgeRecord[]): string | null {
  if (records.length === 0) return null;
  const won = records.filter((r) => r.winner === "copy");
  const after = `${(Math.max(...records.map((r) => Math.max(0, r.after_ms))) / 1000).toFixed(1)} s`;
  if (won.length === 0) return records.length === 1 ? `a hedge copy went out after ${after}; the original answered` : `${records.length} hedge copies went out after up to ${after}; the originals answered`;
  return `${won.length} answer${won.length === 1 ? "" : "s"} came from a hedge copy sent after ${won.length === 1 && records.length === 1 ? "" : "up to "}${after}`;
}
