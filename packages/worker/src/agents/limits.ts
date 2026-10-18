import type { Path } from "@fire_trident/core";

/**
 * What one in-platform agent can do in one change, checked before it reads a file or calls a model, so an intent past
 * the limits goes to a person as too large for one agent instead of landing in part as done or failing every attempt:
 * - files: a job writes at most MAX_FILES files (loop.ts); an intent whose footprint covers more would land with only
 *   some of them written, so none is written.
 * - size: a model writes a whole file back in one reply, and that reply's output budget tops out at
 *   MAX_REWRITE_TOKENS (prompt.ts maxTokensFor, with room kept for reasoning), about MAX_REWRITE_CHARS characters. A
 *   larger file would fail all three attempts, so the agent makes none.
 * Each is an escalation of kind "other" with a report that says what is too large and what a person can do about it.
 */

/** An escalation the loop sends for the job (loop.ts escalateJob). */
export interface LimitEscalation {
  kind: "other";
  report: string;
}

/** A count as text with thousands separators. */
function count(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

/**
 * The escalation for a footprint that covers more files than one agent writes (`limit`), or null when it fits. `found`
 * is the files it covers as far as they were listed; reaching `listedMax` means there may be more.
 */
export function tooManyFiles(found: number, limit: number, listedMax: number): LimitEscalation | null {
  if (found <= limit) return null;
  const how = found >= listedMax ? `at least ${count(found)}` : count(found);
  return {
    kind: "other",
    report:
      `Too large for one agent: this intent's footprint covers ${how} files, and one agent writes at most ${count(limit)} in one change, so it wrote none rather than land some of them as done. ` +
      `Split the intent into intents of at most ${count(limit)} files each, or narrow its footprint.`,
  };
}

/** The escalation for a file too large for a model to write back in one reply (`limit` characters), or null when it fits. */
export function tooLargeToRewrite(path: Path, chars: number, limit: number): LimitEscalation | null {
  if (!(chars > limit)) return null;
  return {
    kind: "other",
    report:
      `Too large for one agent: ${path} has ${count(chars)} characters, and a model can write back at most ${count(limit)} in one reply, so the agent made no model call. ` +
      `Split the file into smaller ones, or leave it out of this intent's footprint and change it another way.`,
  };
}
