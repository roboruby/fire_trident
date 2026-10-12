import type { CheckResult, Colony, FileVersion, Intent, Path, Proposal, Rule, Sha } from "@fire_trident/core";
import { checkFile, residualPaths } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { bindingFor } from "../artifacts/shards.ts";
import { dispose, withArtifactsRetry } from "../artifacts/git.ts";
import { DEFAULT_NOT_VERIFIED } from "./logic.ts";

/**
 * Innate checks: the deterministic floor of the Decide prong, run on every proposal before any
 * model looks at it.
 * - Rule re-check: the proposal's changed files (new blobs read from its workspace through the
 *   binding, base blobs from trunk) must leave no violation of the intent's rule in its footprint,
 *   and must not add violations of any other colony rule.
 * - Residual: paths written outside the intent's declared footprint (a review signal, not a
 *   failure on its own).
 * - Not verified: the agent must state what it did not verify.
 * The results go into the proposal's evidence; the file contents feed the reflex arc.
 */

/** One written file with its old and new text. */
export interface InnateFile {
  path: Path;
  beforeBlob: Sha | null;
  afterBlob: Sha | null;
  /** Old text (null: new file, binary, too large or unreadable). */
  before: string | null;
  /** New text (null: deleted, binary, too large or unreadable). */
  after: string | null;
  binary: boolean;
  /** The new blob could not be read from the workspace. */
  unreadable: boolean;
}

/** What the innate checks found. */
export interface InnateResult {
  /** Rule re-check, blobs and the not-verified statement all pass. */
  ok: boolean;
  failures: string[];
  checks: CheckResult[];
  files: InnateFile[];
  /** Written paths outside the intent's footprint. */
  residual: Path[];
}

/** Reads blob bytes from a repo (null when absent). Injected in tests. */
export type BlobReader = (where: { namespace: string; name: string }, blobs: Sha[]) => Promise<Map<Sha, Uint8Array | null>>;

/** Everything the innate checks need. */
export interface InnateContext {
  env: Env;
  colony: Colony;
  intent: Intent | null;
  rules: Rule[];
  /** Base blob ids of paths missing from the read set (TrunkDO.baseBlobs). */
  baseBlobs?: (baseSha: Sha, paths: Path[]) => Promise<FileVersion[]>;
  read?: BlobReader;
}

/** Largest file the rule re-check and the reflex read. */
const MAX_TEXT_BYTES = 512 * 1024;
/** Rules re-checked per proposal. */
const MAX_RULES = 25;

/** Text of `bytes`, or null for binary (a NUL in the first 8 KiB, or invalid UTF-8) and oversized content. */
export function textOf(bytes: Uint8Array | null): { text: string | null; binary: boolean } {
  if (bytes === null) return { text: null, binary: false };
  if (bytes.length > MAX_TEXT_BYTES || bytes.subarray(0, 8192).includes(0)) return { text: null, binary: true };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), binary: false };
  } catch {
    return { text: null, binary: true };
  }
}

/** Read blobs through the Artifacts binding for the repo's namespace (14-20 ms each, run in parallel). */
export function bindingReader(env: Env): BlobReader {
  return async (where, blobs) => {
    const out = new Map<Sha, Uint8Array | null>();
    const binding = bindingFor(env, where.namespace);
    if (!binding || blobs.length === 0) {
      for (const b of blobs) out.set(b, null);
      return out;
    }
    const repo = await withArtifactsRetry(() => binding.get(where.name));
    try {
      await Promise.all(
        [...new Set(blobs)].map(async (b) => {
          try {
            const blob = await withArtifactsRetry(() => repo.readBlob(b));
            out.set(b, blob ? new Uint8Array(await blob.arrayBuffer()) : null);
          } catch {
            out.set(b, null);
          }
        }),
      );
    } finally {
      dispose(repo);
    }
    return out;
  };
}

/** Run the innate checks on a proposal (see the module comment). Never throws for repository problems. */
export async function runInnateChecks(p: Proposal, ctx: InnateContext): Promise<InnateResult> {
  const read = ctx.read ?? bindingReader(ctx.env);
  const failures: string[] = [];
  const checks: CheckResult[] = [];

  // 1. Blobs: new ones from the workspace, base ones from trunk.
  const t0 = Date.now();
  const readSet = new Map(p.readSet.map((f) => [f.path, f.blob]));
  const missing = p.writeSet.map((w) => w.path).filter((path) => !readSet.has(path));
  if (missing.length > 0 && ctx.baseBlobs) {
    try {
      for (const v of await ctx.baseBlobs(p.baseSha, missing)) readSet.set(v.path, v.blob ?? null);
    } catch {
      // unknown base: treated as new files
    }
  }
  const afterIds = p.writeSet.map((w) => w.blob).filter((b): b is Sha => typeof b === "string");
  const beforeIds = p.writeSet.map((w) => readSet.get(w.path) ?? null).filter((b): b is Sha => typeof b === "string");
  const [afterBytes, beforeBytes] = await Promise.all([
    read({ namespace: p.workspace.namespace, name: p.workspace.name }, afterIds).catch(() => new Map<Sha, Uint8Array | null>()),
    read({ namespace: ctx.colony.trunk.namespace, name: ctx.colony.trunk.name }, beforeIds).catch(() => new Map<Sha, Uint8Array | null>()),
  ]);
  const files: InnateFile[] = p.writeSet.map((w) => {
    const beforeBlob = readSet.get(w.path) ?? null;
    const a = w.blob ? textOf(afterBytes.get(w.blob) ?? null) : { text: null, binary: false };
    const b = beforeBlob ? textOf(beforeBytes.get(beforeBlob) ?? null) : { text: null, binary: false };
    const unreadable = w.blob !== null && !afterBytes.get(w.blob);
    return { path: w.path, beforeBlob, afterBlob: w.blob, before: b.text, after: a.text, binary: a.binary || b.binary, unreadable };
  });
  const unreadable = files.filter((f) => f.unreadable);
  if (unreadable.length > 0) {
    const what = unreadable.map((f) => `${f.path} (${f.afterBlob?.slice(0, 10)})`).join(", ");
    failures.push(`new blobs not readable from workspace ${p.workspace.name}: ${what}; push the commit first`);
  }
  checks.push({ name: "innate: blobs", ok: unreadable.length === 0, ms: Date.now() - t0, detail: `${files.length} file(s) read${unreadable.length > 0 ? `, ${unreadable.length} missing` : ""}` });

  // 2. Rule re-check: the intent's rule is satisfied in its footprint; no rule gains violations.
  const t1 = Date.now();
  const footprint = ctx.intent?.footprint ?? p.declared.footprint;
  const own = ctx.intent?.ruleId;
  for (const rule of ctx.rules.slice(0, MAX_RULES)) {
    const notes: string[] = [];
    let ok = true;
    for (const f of files) {
      if (f.after === null) continue;
      let after: number;
      let before: number;
      try {
        after = checkFile(rule, f.path, f.after).length;
        before = f.before === null ? 0 : checkFile(rule, f.path, f.before).length;
      } catch {
        continue; // an invalid rule never blocks a proposal
      }
      if (after === 0 && before === 0) continue;
      notes.push(`${f.path} ${before}→${after}`);
      const inFootprint = residualPaths(footprint, [{ path: f.path, blob: f.afterBlob }]).length === 0;
      if (rule.id === own && inFootprint && after > 0) {
        ok = false;
        failures.push(`${f.path} still has ${after} violation${after === 1 ? "" : "s"} of rule ${rule.id} (${rule.description})`);
      } else if (after > before) {
        ok = false;
        failures.push(`${f.path} adds ${after - before} violation${after - before === 1 ? "" : "s"} of rule ${rule.id} (${rule.description})`);
      }
    }
    if (rule.id === own || notes.length > 0) checks.push({ name: `innate: rule ${rule.id}`, ok, ms: Date.now() - t1, detail: notes.join("; ") || "no violations in the changed files" });
  }

  // 3. Residual against the intent's own footprint (declared before work started).
  const residual = residualPaths(footprint, p.writeSet);
  checks.push({
    name: "innate: footprint",
    ok: residual.length === 0,
    ms: 0,
    detail: residual.length === 0 ? "every write is inside the intent's footprint" : `outside the footprint (review signal): ${residual.slice(0, 10).join(", ")}${residual.length > 10 ? ` and ${residual.length - 10} more` : ""}`,
  });

  // 4. The honest gap statement.
  const nv = (p.evidence.notVerified ?? "").trim();
  const stated = nv !== "" && nv !== DEFAULT_NOT_VERIFIED;
  if (!stated) failures.push('no "Not verified:" statement from the agent: say what you did not check');
  checks.push({ name: "innate: not-verified", ok: stated, ms: 0, detail: stated ? nv.slice(0, 200) : "missing (platform default used)" });

  return { ok: failures.length === 0, failures, checks, files, residual };
}
