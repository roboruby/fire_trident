import type { Id } from "@fire_trident/core";
import { revalidationEnabled } from "@fire_trident/core";
import { JUDGE_ATTEMPTS, JUDGE_DEADLINE_MS, JUDGE_TIMEOUT_MS, askJudge, judgeMessages, judgeView } from "./contest.ts";
import type { JudgeIntent, PairJudge, PairVerdict } from "./contest.ts";
import type { CallLimiter } from "./limiter.ts";
import { modelFamily } from "./policy.ts";
import { isThrottled, type AiRunner } from "./reflex.ts";

/**
 * The contest jury (FT_CONTEST_JURY). In place of the one judge model in contest.ts, two or three small
 * models from different families compare a pair of changes, each asked in both orders, all at once. A
 * member whose two answers agree casts a consistent vote: for the first change, for the second, or for
 * neither. A member whose answers flip with the order (a preference for a position), that does not
 * answer within the judge's deadline, or that answers nothing usable is inconsistent and counts for
 * nobody. The side with more consistent votes wins; a split, or no consistent vote at all, is a tie,
 * which selectWinner breaks exactly as today (the smaller diff, then the earlier change). The verdict
 * names how each member voted, so the lineage note and `ft why` show it, and every member's calls go
 * through the same metered binding as the judge's, so the colony's spend counts them per model in the
 * judge layer. Off without the flag: the single judge path is untouched.
 */

/** Members a jury seats: at least two (one would be a judge), at most three. */
export const JURY_MIN = 2;
export const JURY_MAX = 3;

/** Is the contest jury on for this colony? FT_CONTEST_JURY, read like FT_REVALIDATE: "on", a list of colony ids, or off. */
export function juryEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * The members seated for changes by these authors: one model per family from the colony's configured
 * jury (the decide policy's `juryModels`), outside the authors' families as the judge keeps, at most
 * JURY_MAX. When that seats fewer than JURY_MIN, a model of an author's family joins (one per family
 * first), then any other configured model, so that two models compare whenever the colony lists two.
 */
export function juryMembers(authors: ReadonlyArray<string | undefined>, configured: readonly string[]): string[] {
  const list = [...new Set(configured.filter((m) => typeof m === "string" && m.trim() !== "").map((m) => m.trim()))];
  const taken = new Set(authors.map((a) => modelFamily(a)).filter((f) => f !== ""));
  const seated: string[] = [];
  const families = new Set<string>();
  const seat = (m: string): void => {
    seated.push(m);
    families.add(modelFamily(m));
  };
  for (const m of list) if (seated.length < JURY_MAX && !taken.has(modelFamily(m)) && !families.has(modelFamily(m))) seat(m);
  for (const m of list) if (seated.length < JURY_MIN && !seated.includes(m) && !families.has(modelFamily(m))) seat(m);
  for (const m of list) if (seated.length < JURY_MIN && !seated.includes(m)) seat(m);
  return seated;
}

/** How one member voted: a consistent vote for the first change, the second or neither, or an inconsistent one. */
export type JuryVote = "first" | "second" | "neither" | "inconsistent";

/** One member of a jury and its vote on one pair. */
export interface JuryMember {
  model: string;
  vote: JuryVote;
  /** The member's reason (a consistent vote), or what made it inconsistent (which position it preferred, a time-out, no usable answer). */
  why: string;
  /** Model calls this member made. */
  calls: number;
}

/** One answer of a member, as askJudge parses it. */
type Answer = { better: "A" | "B" | "tie"; reason: string };

/**
 * A member's vote from its two answers: x was change A in `first` and change B in `second`. Both
 * answers must agree; the same letter twice is a preference for a position, which is inconsistent.
 */
export function memberVote(model: string, first: Answer, second: Answer, calls: number): JuryMember {
  if (first.better === "A" && second.better === "B") return { model, vote: "first", why: oneLine(first.reason || second.reason, 200), calls };
  if (first.better === "B" && second.better === "A") return { model, vote: "second", why: oneLine(second.reason || first.reason, 200), calls };
  if (first.better === "tie" || second.better === "tie") return { model, vote: "neither", why: "saw no clear difference", calls };
  return { model, vote: "inconsistent", why: `preferred the change shown ${first.better === "A" ? "first" : "second"} in both orders`, calls };
}

/** How a member's vote reads in the verdict. */
function voteText(m: JuryMember, firstId: Id, secondId: Id): string {
  if (m.vote === "first") return `${m.model} for ${firstId}`;
  if (m.vote === "second") return `${m.model} for ${secondId}`;
  return `${m.model} ${m.why}`;
}

/**
 * The jury's verdict on a pair (first = x, second = y, as selectWinner names them): the side with more
 * consistent votes wins, and the one line says who voted for it, with its reason, and how every other
 * member voted. Equal votes, or none, make a tie; the line then shows every vote, so the tie-break that
 * follows is read against it.
 */
export function tally(members: readonly JuryMember[], firstId: Id, secondId: Id): Pick<PairVerdict, "better" | "why"> {
  const n = members.length;
  const firsts = members.filter((m) => m.vote === "first");
  const seconds = members.filter((m) => m.vote === "second");
  const winners = firsts.length > seconds.length ? firsts : seconds.length > firsts.length ? seconds : null;
  if (winners) {
    const others = members.filter((m) => !winners.includes(m)).map((m) => voteText(m, firstId, secondId));
    const reason = winners.map((m) => m.why).find((w) => w !== "") ?? "";
    const names = winners.map((m) => m.model).join(", ");
    return {
      better: winners === firsts ? "first" : "second",
      why: `judged better by ${winners.length} of ${n} jurors in both orders (${names})${reason ? `: ${reason}` : ""}${others.length > 0 ? `; ${others.join("; ")}` : ""}`,
    };
  }
  const votes = members.map((m) => voteText(m, firstId, secondId)).join("; ");
  if (firsts.length === 0) return { better: "tie", why: `the jury of ${n} had no consistent vote: ${votes}` };
  return { better: "tie", why: `the jury of ${n} split ${firsts.length} to ${seconds.length}: ${votes}` };
}

/** What a jury needs: the (metered) Workers AI binding, the members, the shared call limiter and the intent. */
export interface JuryOptions {
  ai: AiRunner;
  models: readonly string[];
  limiter: CallLimiter;
  intent: JudgeIntent;
  /** Called with each model call made (for metrics). */
  onCall?: (model: string) => void;
  /** Called with the jury's verdict on each pair it compared (for metrics). */
  onVerdict?: (members: readonly JuryMember[], better: PairVerdict["better"]) => void;
  now?: () => number;
  deadlineMs?: number;
  timeoutMs?: number;
}

/**
 * A pair judge that seats a jury: every member is asked both orders at once, each call waiting for a
 * slot in the shared limiter (throttled calls back off and retry, as the judge's do), all within one
 * deadline from the first call, the judge's. A member still without both answers at the deadline is
 * an inconsistent vote. A pair the jury cannot see whole, or no member to seat, is a tie.
 */
export function pairJury(o: JuryOptions): PairJudge {
  const now = o.now ?? Date.now;
  const deadlineMs = o.deadlineMs ?? JUDGE_DEADLINE_MS;
  const timeoutMs = o.timeoutMs ?? JUDGE_TIMEOUT_MS;
  return async (x, y) => {
    const vx = judgeView(x.diffs);
    const vy = judgeView(y.diffs);
    if (!vx.complete || !vy.complete) return { better: "tie", why: "too large or unreadable for the jury to see whole", calls: 0 };
    if (o.models.length === 0) return { better: "tie", why: "no jury model configured", calls: 0 };
    const deadline = now() + deadlineMs;
    const sit = async (model: string): Promise<JuryMember> => {
      let calls = 0;
      const ask = async (a: string, b: string): Promise<Answer> => {
        for (let attempt = 0; ; attempt++) {
          const release = await o.limiter.acquire(model, deadline);
          if (!release) throw new Error(`got no slot within ${Math.round(deadlineMs / 1000)} s`);
          try {
            const left = deadline - now();
            if (left <= 0) throw new Error(`did not answer within ${Math.round(deadlineMs / 1000)} s`);
            calls++;
            o.onCall?.(model);
            return await askJudge(o.ai, model, judgeMessages(o.intent, a, b), Math.min(timeoutMs, left));
          } catch (err) {
            if (!isThrottled(err) || attempt + 1 >= JUDGE_ATTEMPTS) throw err;
            o.limiter.cooldown(model, 2_000 * 2 ** attempt);
          } finally {
            release();
          }
        }
      };
      try {
        const [first, second] = await Promise.all([ask(vx.text, vy.text), ask(vy.text, vx.text)]);
        return memberVote(model, first, second, calls);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        // askJudge's errors start with the model's id, which the verdict line already names.
        return { model, vote: "inconsistent", why: oneLine(text.startsWith(model) ? text.slice(model.length) : text, 160), calls };
      }
    };
    const members = await Promise.all(o.models.map((model) => sit(model)));
    const verdict = tally(members, x.proposalId, y.proposalId);
    o.onVerdict?.(members, verdict.better);
    return { ...verdict, calls: members.reduce((n, m) => n + m.calls, 0), jury: members };
  };
}

/** One line, collapsed whitespace, at most `max` characters. */
function oneLine(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
