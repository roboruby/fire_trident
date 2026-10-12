import type { Landing, LineageNote, Proposal } from "./types.ts";

/** Commit message for a landing: a one-line subject, a body listing intents, and FT-* trailers. */
export function landingMessage(landing: Pick<Landing, "id" | "intentIds">, proposals: Proposal[], intentTitles: Record<string, string>): string {
  throw new Error("not implemented");
}

/** Stable JSON (sorted keys, 2-space indent) for refs/notes/firetrident. */
export function serializeNote(note: LineageNote): string {
  throw new Error("not implemented");
}
