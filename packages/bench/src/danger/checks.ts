/**
 * The decide stage's deterministic danger checks, run offline: the functions the decide engine
 * calls before any model (decide/danger.ts: danger patterns, loosened guards, governance paths,
 * CI and dependency paths), fed the way the engine feeds them (DecideEngine.decideOne in
 * decide/engine.ts), with no network and no colony. Nothing here changes what they detect.
 * Shared by the corpus evaluator (evaluate.ts) and the history sweep (history.ts). Pure: no I/O.
 *
 * What the offline run leaves out: a colony's own allowances (its decide policy's dangerAllow and
 * tolerating antibodies; the default policy allows nothing), and the checks that need a colony
 * (the rule re-check, import resolution against its trunk, the models).
 */
import { applyAllowances, scanDanger, triageDanger, type DangerClass, type DangerFile, type DangerHit, type DangerIntent } from "../../../worker/src/decide/danger.ts";
import { DEFAULT_POLICY } from "../../../worker/src/decide/policy.ts";

/** Largest text the decide stage reads (MAX_TEXT_BYTES in colony/innate.ts). */
export const MAX_TEXT_BYTES = 512 * 1024;

/** JavaScript and TypeScript files (.js .jsx .mjs .cjs .ts .tsx .mts .cts): the files the loosened-guard detector reads. */
export const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

/**
 * The text the decide stage reads from a file's bytes, or null where it reads none: more than
 * 512 KiB, a NUL in the first 8 KiB, or bytes that are not UTF-8. These are the rules of textOf
 * in colony/innate.ts (which cannot be imported here: it pulls in the Worker's bindings); a test
 * runs both on the same inputs.
 */
export function readableText(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_TEXT_BYTES || bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** One file of a change as plain text: before null when the change creates it, after null when it deletes it. */
export interface ChangeFile {
  path: string;
  before: string | null;
  after: string | null;
}

/**
 * The files as the decide engine hands them to scanDanger: each text read under the decide stage's
 * limits, a kept file whose new text cannot be read counted as empty, and a deleted file marked
 * deleted with no text after.
 */
export function dangerFiles(files: readonly ChangeFile[]): DangerFile[] {
  const enc = new TextEncoder();
  const read = (s: string): string | null => readableText(enc.encode(s));
  return files.map((f) => ({
    path: f.path,
    before: f.before === null ? null : read(f.before),
    after: f.after === null ? null : (read(f.after) ?? ""),
    deleted: f.after === null,
  }));
}

/** Where the deterministic stage sends a change: to a person, to a second opinion it cannot skip, or nowhere. */
export type DangerTier = "person" | "second-opinion" | "none";

/** What the deterministic danger checks make of one change. */
export interface DangerOutcome {
  /**
   * person: a must-human hit (auth, secret, an unrequested capability, governance, a repair's test
   * change), so the gate sends it to a person before any model (back to its agent first when its
   * other checks fail, which are not run offline); second-opinion: danger signals
   * only (crypto, CI, dependency, test weakening, a loosened guard), which count as damage, so a
   * second opinion or a person must look; none: nothing counts.
   */
  tier: DangerTier;
  /** tier is person or second-opinion. */
  flagged: boolean;
  /** Danger classes of the hits that count, sorted. */
  classes: DangerClass[];
  /** Hits that send it to a person. */
  mustHuman: DangerHit[];
  /** Hits that count as danger signals. */
  signals: DangerHit[];
  /** Hits the intent asked for (written by a person or a rule): recorded, not counted. */
  recorded: DangerHit[];
}

/** The policy allowances of the default decide policy (none), as the engine passes them. */
const ALLOWANCES = DEFAULT_POLICY.dangerAllow.map((a) => ({ cls: a.cls, ...(a.paths ? { paths: a.paths } : {}), by: "policy" }));

/** Run the checks on files already read under the decide stage's limits (see dangerFiles). */
export function checkDangerFiles(files: readonly DangerFile[], intent: DangerIntent | null): DangerOutcome {
  const { mustHuman, signals, recorded } = triageDanger(applyAllowances(scanDanger(files, intent), ALLOWANCES));
  const counting = [...mustHuman, ...signals];
  return {
    tier: mustHuman.length > 0 ? "person" : signals.length > 0 ? "second-opinion" : "none",
    flagged: counting.length > 0,
    classes: [...new Set(counting.map((h) => h.cls))].sort(),
    mustHuman,
    signals,
    recorded,
  };
}

/**
 * Run the checks on a change given as text. With no intent (the default) nothing is asked for,
 * as for a change whose intent an agent declared: the strictest reading.
 */
export function checkChange(files: readonly ChangeFile[], intent: DangerIntent | null = null): DangerOutcome {
  return checkDangerFiles(dangerFiles(files), intent);
}

/** An intent a person wrote, with this text as its title and why (what may ask for a capability). */
export function personIntent(text: string): DangerIntent {
  return { title: text, why: text, source: "human" };
}

/** One hit as results show it. */
export interface HitRow {
  cls: DangerClass;
  pattern: string;
  path: string;
  /** 1-based line in the new text; 0 for a hit on the whole file. */
  line: number;
  /** The line, trimmed and cut, secret-looking values masked (by the detector). */
  excerpt: string;
}

/** The hits that count (to a person first), as rows. */
export function hitRows(o: DangerOutcome): HitRow[] {
  return [...o.mustHuman, ...o.signals].map((h) => ({ cls: h.cls, pattern: h.pattern, path: h.path, line: h.line, excerpt: h.excerpt }));
}
