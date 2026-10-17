import type { Intent, Landing, LandingTests } from "@fire_trident/core";
import type { ApiRequest } from "./api.ts";
import { colonyPath } from "./api.ts";
import { ago, type Colors } from "./format.ts";
import {
  LIFECYCLE_CAPTION,
  LIFECYCLE_LABEL,
  TAKE_BACK_PUSH,
  changeLifecycle,
  intentLifecycleOf,
  noteCertified,
  noteLifecycleFacts,
  placeCertified,
  testsCertified,
  type ChangeLifecycle,
  type IntentLifecycle,
  type LifecycleCertified,
  type LifecycleLink,
  type LifecycleStep,
} from "./lifecycle.ts";

/**
 * The lifecycle strip in the CLI (lifecycle.ts, a copy of core's, words it): `ft intent show` reads the intent's strip
 * (GET /api/colonies/:id/intents/:iid/lifecycle, a public read) and prints a row per step with its evidence and time,
 * where a change left the path, the caption, and the intent's other changes; `ft why` prints each landed change's strip
 * in one line from its lineage note, and what comes next. The last two steps happen in the team's forge and are never
 * marked done.
 */

/** The request for an intent's strip. */
export function lifecycleRequest(colony: string, intentId: string): ApiRequest {
  return { method: "GET", path: colonyPath(colony, `/intents/${encodeURIComponent(intentId)}/lifecycle`) };
}

/** Each state's mark: done, not yet, in the team's forge, does not apply. */
const MARK: Record<LifecycleStep["state"], string> = { done: "✓", todo: "○", outside: "↗", none: "–" };

/** Text from the server as one terminal line: no control characters. */
function plain(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** A step's mark and name, the step reached in bold. */
function stepWord(s: LifecycleStep, reached: boolean, c: Colors): string {
  const word = `${MARK[s.state]} ${s.label.toLowerCase()}`;
  if (reached) return c.bold(c.green(word));
  if (s.state === "done") return c.green(word);
  return c.dim(word);
}

/**
 * The strip in one line: "✓ declared → ✓ claimed → ✓ proposed → ✓ confirmed → ✓ landed → ○ certified → ↗ taken back →
 * ↗ merged by a person", the step reached in bold; a change that left the path stops after its step with where it went
 * ("↳ returned").
 */
export function stripLine(s: ChangeLifecycle, c: Colors): string {
  const arrow = c.dim(" → ");
  if (s.off) {
    const upTo = s.steps.slice(0, s.steps.findIndex((x) => x.key === s.off!.after) + 1);
    return `${upTo.map((x) => stepWord(x, x.key === s.reached, c)).join(arrow)} ${c.yellow(`↳ ${s.off.label.toLowerCase()}`)}`;
  }
  return s.steps.map((x) => stepWord(x, x.key === s.reached, c)).join(arrow);
}

/** A step's evidence as the CLI names it ("intent int_1", "landing lnd_1 abc1234"). */
function linkWords(l: LifecycleLink | undefined): string {
  if (!l) return "";
  switch (l.kind) {
    case "take-back":
      return "";
    case "certification":
      return l.sha ? `certification ${l.sha.slice(0, 7)}` : "";
    case "landing":
      return `landing ${plain(l.id)}${l.sha ? ` ${l.sha.slice(0, 7)}` : ""}`;
    default:
      return `${l.kind} ${plain(l.id)}`;
  }
}

const WIDTH = Math.max(...Object.values(LIFECYCLE_LABEL).map((l) => l.length)) + 2;

/** One strip as rows: a row per step (mark, name, what it says, when, its evidence), where it left the path after its step, and the take-back command. */
export function stripRows(s: ChangeLifecycle, c: Colors, now: number, indent = "    "): string[] {
  const out: string[] = [];
  for (const step of s.steps) {
    const when = typeof step.at === "number" ? c.dim(` · ${ago(step.at, now)}`) : "";
    const ev = linkWords(step.link);
    const evidence = ev && !plain(step.text).startsWith(plain(step.link?.id ?? "\u0000")) ? c.dim(` · ${ev}`) : "";
    const name = `${MARK[step.state]} ${step.label}`.padEnd(WIDTH + 2);
    const head = step.key === s.reached ? c.bold(c.green(name)) : step.state === "done" ? c.green(name) : c.dim(name);
    const text = step.state === "done" ? plain(step.text) : c.dim(plain(step.text));
    out.push(`${indent}${head}${text}${when}${evidence}`);
    if (step.command) out.push(`${indent}${"".padEnd(WIDTH + 2)}${step.command}`);
    if (s.off && s.off.after === step.key) {
      const o = s.off;
      const at = typeof o.at === "number" ? c.dim(` · ${ago(o.at, now)}`) : "";
      const beat = o.beatenBy ? c.dim(` · beaten by landing ${plain(o.beatenBy.landingId)}${o.beatenBy.trunkSha ? ` ${o.beatenBy.trunkSha.slice(0, 7)}` : ""}${o.beatenBy.title ? ` "${plain(o.beatenBy.title)}"` : ""}`) : "";
      out.push(`${indent}${c.yellow(`↳ ${o.label}`.padEnd(WIDTH + 2))}${plain(o.text)}${at}${beat}`);
    }
  }
  return out;
}

/** What `ft intent show` adds: the intent's strip with the caption, and its other changes in a line each (none for an older server). */
export function lifecycleLines(raw: unknown, c: Colors, now: number): string[] {
  const l: IntentLifecycle | null = intentLifecycleOf(raw);
  if (!l) return [];
  const out = [`  ${c.dim("lifecycle".padEnd(10))}${stripLine(l.current, c)}`, ...stripRows(l.current, c, now), `  ${"".padEnd(10)}${c.dim(LIFECYCLE_CAPTION)}`];
  const others = l.changes.filter((x) => x.proposalId !== l.current.proposalId);
  for (const [n, x] of others.slice(0, 5).entries()) out.push(`  ${c.dim((n === 0 ? "changes" : "").padEnd(10))}${plain(x.proposalId ?? "?")} ${c.dim(plain(x.text))}`);
  if (others.length > 5) out.push(`  ${"".padEnd(10)}${c.dim(`${others.length - 5} more (--json lists them)`)}`);
  return out;
}

/** What `ft why` knows about certification beyond a landing's note: its test rows, and the status read's green commit and landings. */
export interface WhyCertified {
  tests?: Record<string, LandingTests>;
  greenSha?: string;
  landings?: ReadonlyArray<Pick<Landing, "trunkSha" | "at">>;
}

/** Whether a green certification includes a landing: its test row, else its own note, else the status read's green commit. */
function certifiedFor(landing: Landing, certification: unknown, ctx: WhyCertified): LifecycleCertified {
  const row = ctx.tests && Object.hasOwn(ctx.tests, landing.id) ? testsCertified(ctx.tests[landing.id]) : null;
  if (row) return row;
  const own = noteCertified(certification, landing.trunkSha);
  if (own) return own;
  const landings = (ctx.landings ?? []).filter((l): l is { trunkSha: string; at: number } => !!l && typeof l.trunkSha === "string" && typeof l.at === "number");
  return placeCertified(landing, { ...(ctx.greenSha ? { greenSha: ctx.greenSha } : {}), landings });
}

/**
 * The rows `ft why` prints under a landed change: its strip in one line, then what comes next (the certified commit is
 * still to come, with why, or the take-back command once it is certified).
 */
export function whyLifecycleRows(landing: Landing, entry: unknown, certification: unknown, ctx: WhyCertified & { intents?: ReadonlyMap<string, Intent> }, c: Colors): Array<{ k: string; v: string }> {
  const id = (entry as { intent?: { id?: unknown } } | null)?.intent?.id;
  const intent = typeof id === "string" ? ctx.intents?.get(id) : undefined;
  const s = changeLifecycle(noteLifecycleFacts(landing, entry, { ...(intent ? { createdAt: intent.createdAt } : {}), certified: certifiedFor(landing, certification, ctx) }));
  const cert = s.steps.find((x) => x.key === "certified");
  const next = cert?.state === "done" ? `${c.dim("next: push certified to your forge as a branch and open a pull request:")} ${TAKE_BACK_PUSH}` : c.dim(plain(cert?.text ?? ""));
  return [
    { k: "path", v: stripLine(s, c) },
    { k: "", v: next },
  ];
}
