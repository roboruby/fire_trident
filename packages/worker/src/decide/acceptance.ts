import type { CheckResult, Id, Intent, NoteAcceptance, Path, Sha } from "@fire_trident/core";
import { revalidationEnabled } from "@fire_trident/core";
import { errorText } from "../colony/errors.ts";
import { acceptanceDetail, acceptanceLines, type AcceptanceLine, type KeepSource } from "./quotes.ts";

/**
 * The decide engine's hooks for quoted acceptance (FT_QUOTED_ACCEPTANCE, decide/quotes.ts): which lines a change's
 * second opinion answers, and the evidence check that records what counted.
 */

/** Is quoted acceptance on for this colony? `setting` is FT_QUOTED_ACCEPTANCE: "on", a comma-separated list of colony ids, or absent / "off". */
export function quotedAcceptanceEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** What the lines need from the colony: the flag, the colony's id, and the newest landing by another intent on some paths. */
export interface AcceptanceHost {
  env: { FT_QUOTED_ACCEPTANCE?: string };
  colony(): { id: Id };
  /** The newest landing by an intent other than `intentId` on these paths, with that intent's acceptance list; null when none. */
  keepAcceptance?(intentId: Id, paths: Path[]): KeepSource | null;
}

/**
 * The acceptance lines a change's second opinion answers, or null to keep today's rule: the flag is off for the colony,
 * the change is a vaccine, or its intent has no acceptance list of its own (decide/quotes.ts acceptanceLines). Keep lines
 * come from the newest landing by another intent on the files the change modifies (those it changes or deletes, not
 * the ones it adds); when that lookup fails, the change is judged on its own lines.
 */
export function acceptanceFor(host: AcceptanceHost, intent: Intent | null, files: ReadonlyArray<{ path: Path; beforeBlob: Sha | null }>, vaccine: boolean): AcceptanceLine[] | null {
  if (!intent || vaccine) return null;
  if (!quotedAcceptanceEnabled(host.env.FT_QUOTED_ACCEPTANCE, host.colony().id)) return null;
  if (acceptanceLines(intent) === null) return null;
  const modified = files.filter((f) => f.beforeBlob !== null).map((f) => f.path);
  let keep: KeepSource | null = null;
  if (modified.length > 0 && host.keepAcceptance) {
    try {
      keep = host.keepAcceptance(intent.id, modified);
    } catch (err) {
      console.warn(`keep lines for intent ${intent.id} not read: ${errorText(err)}`);
    }
  }
  return acceptanceLines(intent, keep);
}

/** The evidence check for the checked lines: ok when every line of the intent is met and none is answered not met. */
export function acceptanceCheck(lines: readonly NoteAcceptance[]): CheckResult {
  const ok = lines.every((l) => (l.kind === "intent" ? l.verdict === "met" : l.verdict !== "not met"));
  return { name: "acceptance: quoted", ok, ms: 0, detail: acceptanceDetail(lines) };
}
