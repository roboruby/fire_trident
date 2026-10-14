import type { ColonyEvent, EscalationKind } from "@fire_trident/core";
import { fmtInt, plural, shortId } from "./format.ts";
import type { EscalationView, NoticeGroup } from "./store.ts";

/**
 * Plain-language lines for the events that escalations, contests, landing notices and assumption
 * revalidation add to the log, kept apart from the components so they can be tested. Agents' words
 * come back as plain strings: callers render them as text.
 */

/** An agent's report kind, as a short label (the review card's chip). */
export const KIND_LABEL: Readonly<Record<EscalationKind, string>> = {
  "broken-test": "broken test",
  "contradictory-spec": "contradictory spec",
  impossible: "impossible as written",
  other: "other",
  chain: "agent chain",
};

/** An agent's report kind, as the object of "reports …". */
const KIND_PHRASE: Readonly<Record<EscalationKind, string>> = {
  "broken-test": "a broken test",
  "contradictory-spec": "a contradictory spec",
  impossible: "it is impossible as written",
  other: "a problem",
  chain: "a chain of agent-declared intents to check",
};

/** Up to `max` items joined for a sentence: "a", "a and b", "a, b and 2 more". */
export function listOf(items: readonly string[], max = 2): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  if (items.length <= max) return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `${items.slice(0, max).join(", ")} and ${fmtInt(items.length - max)} more`;
}

/** The first line of untrusted text, trimmed and cut to `max` characters. */
export function firstLine(text: string, max = 140): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "forager-007 reports a broken test: <title>", or what the person who answered did. */
export function escalationText(e: Pick<EscalationView, "kind" | "title" | "resolved">, agent: string): string {
  const r = e.resolved;
  if (!r) return `${agent} reports ${KIND_PHRASE[e.kind] ?? KIND_PHRASE.other}: ${e.title}`;
  const note = r.note.trim() ? `: ${firstLine(r.note)}` : "";
  if (r.decision === "amend") return `${r.by} amended “${e.title}” after a report${note}`;
  if (r.decision === "withdraw") return `${r.by} withdrew “${e.title}” after a report${note}`;
  return `${r.by} dismissed the report on “${e.title}”${note}`;
}

/** "<title>: prp_x won over 2 other attempts · <reason>". */
export function contestText(e: Extract<ColonyEvent, { t: "contest" }>): string {
  const n = Array.isArray(e.losers) ? e.losers.length : 0;
  const reason = typeof e.reason === "string" && e.reason.trim() ? ` · ${firstLine(e.reason)}` : "";
  const winner = typeof e.winner === "string" && e.winner ? shortId(e.winner) : "one attempt";
  return `${typeof e.title === "string" && e.title ? e.title : "An intent"}: ${winner} won over ${plural(n, "other attempt")}${reason}`;
}

/**
 * "landed on revalidation: src/app.ts changed after it was read; the imports it relies on (Context,
 * Router) are still exported".
 */
export function revalidatedText(e: Extract<ColonyEvent, { t: "revalidated" }>): string {
  const paths = Array.isArray(e.paths) ? e.paths.filter((p): p is string => typeof p === "string") : [];
  const names = Array.isArray(e.names) ? e.names.filter((n): n is string => typeof n === "string") : [];
  const what = paths.length ? `${listOf(paths)} changed after it was read` : "files it read changed after it read them";
  const held = names.length ? `the imports it relies on (${listOf(names, 4)}) are still exported` : `it imports nothing from ${paths.length === 1 ? "it" : "them"}`;
  return `landed on revalidation: ${what}; ${held}`;
}

/** "told 3 agents: src/context.ts changed", or the first notice's own words when no file is named. */
export function noticeText(g: Pick<NoticeGroup, "agents" | "paths" | "message">): string {
  const n = Math.max(1, g.agents.length);
  const what = g.paths.length ? `${listOf(g.paths)} changed` : firstLine(g.message) || "trunk changed under them";
  return `told ${plural(n, "agent")}: ${what}`;
}
