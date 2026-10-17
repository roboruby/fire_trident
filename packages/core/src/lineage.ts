import type { Landing, LineageNote, Proposal } from "./types.ts";
import { oneLine, truncate } from "./text.ts";
// Who answers for a landing and who said each line of its evidence, read from its note (answerable.ts).
export * from "./answerable.ts";
// A landing's test row: what landed it, the tests lost and gained, and the words (testdelta.ts).
export * from "./testdelta.ts";

const SUBJECT_MAX = 72;

/**
 * Commit message for a landing: a one-line subject, a body listing intents, and FT-* trailers.
 *
 * Subject "Land N change: <first intent title>" ("changes" when N != 1; N = proposals), cut to 72
 * characters. Then one "- <title>" bullet per intent and the trailers FT-Landing, FT-Intent per intent,
 * FT-Proposal per proposal, FT-Agent per unique agent, each paragraph separated by a blank line.
 * Titles are collapsed to one line so they cannot forge trailers; a missing title falls back to the
 * intent id. Intents of the proposals that the landing omits are appended. No trailing newline.
 */
export function landingMessage(landing: Pick<Landing, "id" | "intentIds">, proposals: Proposal[], intentTitles: Record<string, string>): string {
  const intentIds = unique([...landing.intentIds, ...proposals.map((p) => p.intentId)]);
  const proposalIds = unique(proposals.map((p) => p.id));
  const agentIds = unique(proposals.map((p) => p.agentId));
  const titles = intentIds.map((id) => titleOf(intentTitles, id));
  const count = proposalIds.length;
  const head = `Land ${count} ${count === 1 ? "change" : "changes"}`;
  const subject = truncate(titles[0] === undefined ? head : `${head}: ${titles[0]}`, SUBJECT_MAX);
  const bullets = titles.map((title) => `- ${title}`).join("\n");
  const trailers = [
    `FT-Landing: ${oneLine(landing.id)}`,
    ...intentIds.map((id) => `FT-Intent: ${id}`),
    ...proposalIds.map((id) => `FT-Proposal: ${id}`),
    ...agentIds.map((id) => `FT-Agent: ${id}`),
  ].join("\n");
  return [subject, bullets, trailers].filter((part) => part !== "").join("\n\n");
}

/** Stable JSON (sorted keys, 2-space indent) for refs/notes/firetrident. Keys sort recursively; ends with a newline. */
export function serializeNote(note: LineageNote): string {
  return `${stableJson(note, "", "", []) ?? "null"}\n`;
}

/** Ids collapsed to one line, deduplicated, first occurrence first. */
function unique(ids: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = oneLine(raw);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function titleOf(titles: Record<string, string>, id: string): string {
  const raw = Object.hasOwn(titles, id) ? titles[id] : undefined;
  const title = typeof raw === "string" ? oneLine(raw) : "";
  return title === "" ? id : title;
}

/**
 * JSON text with object keys in sorted order at every depth and 2-space indentation. Otherwise the
 * same output as the built-in serializer (toJSON, omitted undefined/function members, null for
 * non-finite numbers). Built by hand because integer-like keys would defeat sorted insertion order.
 */
function stableJson(value: unknown, indent: string, key: string, stack: object[]): string | undefined {
  if (typeof value === "object" && value !== null && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: (key: string) => unknown }).toJSON(key);
  }
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) as string | undefined;
  if (stack.includes(value)) throw new TypeError("serializeNote: cyclic structure");
  stack.push(value);
  const inner = `${indent}  `;
  let text: string;
  if (Array.isArray(value)) {
    const items = value.map((item, i) => stableJson(item, inner, String(i), stack) ?? "null");
    text = items.length === 0 ? "[]" : `[\n${inner}${items.join(`,\n${inner}`)}\n${indent}]`;
  } else {
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const k of Object.keys(record).sort()) {
      const json = stableJson(record[k], inner, k, stack);
      if (json !== undefined) members.push(`${JSON.stringify(k)}: ${json}`);
    }
    text = members.length === 0 ? "{}" : `{\n${inner}${members.join(`,\n${inner}`)}\n${indent}}`;
  }
  stack.pop();
  return text;
}
