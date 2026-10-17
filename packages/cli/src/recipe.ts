import type { NoteRecipe, RecipeRecord } from "@fire_trident/core";
import type { ApiRequest } from "./api.ts";
import type { Colors } from "./format.ts";

/**
 * Recipes in the CLI (packages/worker/src/trunk/recipes.ts on the server): `ft recipe <colony> rename <old> <new> --scope
 * 'src/**'` declares a recipe, which the trunk writer lands in batches and applies to every change in flight built
 * before it; `ft recipe <colony>` lists the colony's recipes, `ft recipe <colony> <rcp_id>` shows one with what it would
 * still change on trunk, and `ft recipe <colony> approve <rcp_id>` lands a recipe held for a danger pattern in its output.
 * The server parses and pins the recipe (core/recipe.ts); the CLI carries no runtime code from the core package.
 */

/** One `ft recipe` invocation. */
export type RecipeCommand =
  | { name: "recipe"; colony: string; action: "list" }
  | { name: "recipe"; colony: string; action: "show"; id: string }
  | { name: "recipe"; colony: string; action: "approve"; id: string; by?: string }
  | {
      name: "recipe";
      colony: string;
      action: "declare";
      kind: "rename-identifier" | "replace-import" | "text-replace";
      args: Record<string, string | boolean>;
      scope: string[];
      why?: string;
      title?: string;
      by?: string;
    };

/** The options `ft recipe` takes. */
export const RECIPE_OPTIONS: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {
  scope: { type: "string", multiple: true },
  why: { type: "string" },
  title: { type: "string" },
  by: { type: "string" },
  prefix: { type: "boolean" },
  find: { type: "string" },
  pattern: { type: "string" },
  replace: { type: "string" },
  "ignore-case": { type: "boolean" },
};

/** How `ft recipe` is used. */
export const RECIPE_USAGE =
  "ft recipe <colony> rename <old> <new> --scope <glob>... [--why <text>] | ft recipe <colony> replace-import <from> <to> [--prefix] --scope <glob>... | " +
  "ft recipe <colony> text-replace (--find <text> | --pattern '^...$' [--ignore-case]) --replace <text> --scope <glob>... | ft recipe <colony> [<rcp_id> | approve <rcp_id>]";

const DECLARE_FLAGS = ["scope", "why", "title", "by"];

function text(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Flags given that the action does not take, as a usage error; null when there are none. */
function stray(v: Record<string, unknown>, allowed: readonly string[], context: string): string | null {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k) && Object.hasOwn(RECIPE_OPTIONS, k) && v[k] !== undefined);
  return extra.length > 0 ? `--${extra[0]} does not apply to ${context}. Usage: ${RECIPE_USAGE}` : null;
}

/** `ft recipe ...`, parsed; a usage error as a string. */
export function parseRecipeCommand(v: Record<string, unknown>, p: string[]): RecipeCommand | string {
  const colony = p[0];
  if (!colony) return `missing <colony>. Usage: ${RECIPE_USAGE}`;
  const word = p[1];
  if (word === undefined) {
    return stray(v, [], "listing recipes") ?? { name: "recipe", colony, action: "list" };
  }
  if (word === "approve") {
    const id = p[2]?.trim();
    if (!id) return `name the recipe to approve (rcp_...). Usage: ${RECIPE_USAGE}`;
    if (p.length > 3) return `unexpected argument "${p[3]}". Usage: ${RECIPE_USAGE}`;
    const by = text(v.by)?.trim();
    return stray(v, ["by"], "approving a recipe") ?? { name: "recipe", colony, action: "approve", id, ...(by ? { by } : {}) };
  }
  if (word.startsWith("rcp_")) {
    if (p.length > 2) return `unexpected argument "${p[2]}". Usage: ${RECIPE_USAGE}`;
    return stray(v, [], "showing a recipe") ?? { name: "recipe", colony, action: "show", id: word };
  }
  if (!["rename", "rename-identifier", "replace-import", "text-replace"].includes(word)) {
    return `unknown recipe action "${word}": use rename, replace-import, text-replace, approve, or a recipe id. Usage: ${RECIPE_USAGE}`;
  }
  const scope = (Array.isArray(v.scope) ? v.scope : []).filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
  if (scope.length === 0) return `name the files the recipe covers with --scope, such as --scope 'src/**'. Usage: ${RECIPE_USAGE}`;
  const common = {
    name: "recipe" as const,
    colony,
    action: "declare" as const,
    scope,
    ...(text(v.why)?.trim() ? { why: text(v.why)!.trim() } : {}),
    ...(text(v.title)?.trim() ? { title: text(v.title)!.trim() } : {}),
    ...(text(v.by)?.trim() ? { by: text(v.by)!.trim() } : {}),
  };
  if (word === "rename" || word === "rename-identifier") {
    const [from, to] = [p[2], p[3]];
    if (!from || !to) return `rename takes the old name and the new one: ft recipe ${colony} rename <old> <new> --scope <glob>`;
    if (p.length > 4) return `unexpected argument "${p[4]}". Usage: ${RECIPE_USAGE}`;
    return stray(v, DECLARE_FLAGS, "rename") ?? { ...common, kind: "rename-identifier", args: { from, to } };
  }
  if (word === "replace-import") {
    const [from, to] = [p[2], p[3]];
    if (!from || !to) return `replace-import takes the old module specifier and the new one: ft recipe ${colony} replace-import <from> <to> --scope <glob>`;
    if (p.length > 4) return `unexpected argument "${p[4]}". Usage: ${RECIPE_USAGE}`;
    return stray(v, [...DECLARE_FLAGS, "prefix"], "replace-import") ?? { ...common, kind: "replace-import", args: { from, to, ...(v.prefix === true ? { prefix: true } : {}) } };
  }
  if (word === "text-replace") {
    if (p.length > 2) return `unexpected argument "${p[2]}". Usage: ${RECIPE_USAGE}`;
    const find = text(v.find);
    const pattern = text(v.pattern);
    const replace = text(v.replace);
    if ((find === undefined) === (pattern === undefined)) return `text-replace takes --find (an exact string) or --pattern (a regular expression from ^ to $), one of them`;
    if (replace === undefined) return `text-replace needs --replace <text>`;
    if (v["ignore-case"] === true && pattern === undefined) return `--ignore-case goes with --pattern only`;
    const args: Record<string, string | boolean> = find !== undefined ? { find, replace } : { pattern: pattern!, replace, ...(v["ignore-case"] === true ? { flags: "i" } : {}) };
    return stray(v, [...DECLARE_FLAGS, "find", "pattern", "replace", "ignore-case"], "text-replace") ?? { ...common, kind: "text-replace", args };
  }
  return `unknown recipe action "${word}". Usage: ${RECIPE_USAGE}`;
}

/** A rule's recipe as `ft rule ... --recipe` sends it (the server parses and pins it; its scope defaults to the rule's globs). */
export interface RuleRecipe {
  kind: "rename-identifier" | "replace-import" | "text-replace";
  args: Record<string, string | boolean>;
  scope?: string[];
}

/** How `--recipe` is written. */
export const RULE_RECIPE_USAGE = "--recipe 'rename <old> <new>' | --recipe 'replace-import <from> <to> [prefix]' | --recipe 'text-replace <find> <replace>' [--recipe-scope <glob>]...";

/**
 * A rule's `--recipe '<kind> <args>'`, parsed: `rename <old> <new>` (or rename-identifier), `replace-import <from> <to>`
 * with an optional `prefix`, or `text-replace <find> <replace>` (each one word). `scope`: the --recipe-scope globs, when
 * given. A usage error as a string.
 */
export function parseRuleRecipe(text: string, scope: readonly string[]): RuleRecipe | string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const [kind, ...rest] = words;
  const scoped = scope.length > 0 ? { scope: [...scope] } : {};
  if (kind === "rename" || kind === "rename-identifier") {
    if (rest.length !== 2) return `--recipe rename takes the old name and the new one: --recipe 'rename <old> <new>'`;
    return { kind: "rename-identifier", args: { from: rest[0]!, to: rest[1]! }, ...scoped };
  }
  if (kind === "replace-import") {
    const prefix = rest.length === 3 && rest[2] === "prefix";
    if (rest.length !== 2 && !prefix) return `--recipe replace-import takes the old module specifier and the new one, then optionally prefix: --recipe 'replace-import <from> <to> [prefix]'`;
    return { kind: "replace-import", args: { from: rest[0]!, to: rest[1]!, ...(prefix ? { prefix: true } : {}) }, ...scoped };
  }
  if (kind === "text-replace") {
    if (rest.length !== 2) return `--recipe text-replace takes the exact text to find and its replacement, one word each (use ft recipe for longer text): --recipe 'text-replace <find> <replace>'`;
    return { kind: "text-replace", args: { find: rest[0]!, replace: rest[1]! }, ...scoped };
  }
  return `unknown recipe "${kind ?? ""}": ${RULE_RECIPE_USAGE}`;
}

/** What `ft rule` prints of the rule's recipe from the server's answer (`recipe` on POST /rules), or nothing. */
export function ruleRecipeLines(res: unknown, colony: string, c: Colors): string[] {
  const r = res && typeof res === "object" ? (res as { recipe?: { id?: unknown; recipe?: { kind?: unknown; args?: Record<string, unknown> }; files?: unknown; violations?: unknown; skipped?: unknown } }).recipe : undefined;
  if (!r || typeof r !== "object") return [];
  const words = recipeWords(r.recipe);
  if (typeof r.skipped === "string" && r.skipped !== "") return [`  ${c.yellow("recipe")} ${words}: ${plain(r.skipped)}`];
  const v = typeof r.violations === "number" ? r.violations : 0;
  const f = typeof r.files === "number" ? r.files : 0;
  return [
    `  ${c.cyan("recipe")} ${c.bold(plain(r.id))} ${words} takes ${v} violation${v === 1 ? "" : "s"} in ${f} file${f === 1 ? "" : "s"}: no agent intent for those, only for what it leaves`,
    c.dim(`  Follow it: ft recipe ${colony} ${plain(r.id)}`),
  ];
}

/** The recipe in a few words, as the server's core/recipe.ts recipeText says it. */
export function recipeWords(r: { kind?: unknown; args?: Record<string, unknown> } | undefined): string {
  const a = r?.args ?? {};
  if (r?.kind === "rename-identifier") return `rename-identifier ${String(a.from)} to ${String(a.to)}`;
  if (r?.kind === "replace-import") return `replace-import ${String(a.from)} with ${String(a.to)}${a.prefix === true ? " (prefix)" : ""}`;
  if (r?.kind === "text-replace") return typeof a.find === "string" ? "text-replace of an exact string" : "text-replace of an anchored pattern";
  return r?.kind === "module" ? "module recipe" : "recipe";
}

/** The request of `ft recipe`. */
export function recipeRequest(cmd: RecipeCommand, by: string, colonyPath: (colony: string, suffix: string) => string): ApiRequest {
  if (cmd.action === "list") return { method: "GET", path: colonyPath(cmd.colony, "/recipes") };
  if (cmd.action === "show") return { method: "GET", path: colonyPath(cmd.colony, `/recipes/${encodeURIComponent(cmd.id)}`) };
  if (cmd.action === "approve") return { method: "POST", path: colonyPath(cmd.colony, `/recipes/${encodeURIComponent(cmd.id)}/approve`), body: { by: cmd.by ?? by } };
  const why = cmd.why ?? `${recipeWords({ kind: cmd.kind, args: cmd.args })} across ${cmd.scope.join(", ")}, declared from the CLI`;
  return {
    method: "POST",
    path: colonyPath(cmd.colony, "/recipes"),
    body: { kind: cmd.kind, args: cmd.args, scope: cmd.scope, why, by: cmd.by ?? by, ...(cmd.title ? { title: cmd.title } : {}) },
  };
}

/** Server text on one terminal line: no control characters. */
function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

function short(sha: unknown): string {
  return typeof sha === "string" ? sha.slice(0, 7) : "";
}

const STATE_WORDS: Record<string, string> = {
  running: "landing batches",
  held: "held for a person",
  landed: "landed",
  failed: "stopped",
};

/** One recipe in a few lines: what it is, where it stands, its batches, the files it left as they were, and what to do next. */
export function recipeLines(r: Partial<RecipeRecord>, colony: string, c: Colors): string[] {
  const state = typeof r.state === "string" ? r.state : "unknown";
  const color = state === "landed" ? c.green : state === "held" ? c.yellow : state === "failed" ? c.red : c.cyan;
  const batches = Array.isArray(r.batches) ? r.batches : [];
  const scope = Array.isArray(r.recipe?.scope) ? r.recipe!.scope.map(plain).join(", ") : "";
  const out = [
    `${c.bold(plain(r.id))}  ${color(STATE_WORDS[state] ?? state)}  ${recipeWords(r.recipe)} over ${scope}${r.intentId ? c.dim(`  (intent ${plain(r.intentId)})`) : ""}`,
    `  ${batches.length} batch${batches.length === 1 ? "" : "es"} landed: ${r.changed ?? 0} file${r.changed === 1 ? "" : "s"} rewritten of ${r.examined ?? 0} read`,
  ];
  for (const b of batches.slice(-5)) {
    out.push(c.dim(`    ${plain(b.landingId)}  ${short(b.trunkSha)}  ${b.changed} of ${b.files} files, through ${plain(b.through)}${b.reverted ? " (reverted)" : ""}`));
  }
  const left = Array.isArray(r.untransformed) ? r.untransformed : [];
  if (left.length > 0) {
    const named = left.slice(0, 5).map((u) => `${plain(u.path)} (${plain(u.reason)})`);
    const more = left.length - named.length + (typeof r.untransformedMore === "number" ? r.untransformedMore : 0);
    out.push(`  left as they were: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
  }
  if (r.reason) out.push(`  ${color(plain(r.reason))}`);
  if (state === "held" && r.held) {
    for (const h of (Array.isArray(r.held.hits) ? r.held.hits : []).slice(0, 5)) out.push(`    ${c.yellow("!")} ${plain(h)}`);
    out.push(`  ${c.dim("→")} approve exactly this output: ${c.cyan(`ft recipe ${colony} approve ${plain(r.id)}`)}`);
  } else if (state === "running") {
    out.push(c.dim(`  The trunk writer lands the rest between landing cycles; follow it: ft recipe ${colony} ${plain(r.id)}`));
  }
  if (state === "running" || state === "landed") out.push(c.dim("  Changes in flight built before it land with it applied; a file it cannot rewrite sends its change back as stale."));
  return out;
}

/** The answer of `ft recipe`, in words. */
export function formatRecipe(cmd: RecipeCommand, res: unknown, c: Colors): string {
  if (cmd.action === "list") {
    const list = Array.isArray(res) ? (res as Array<Partial<RecipeRecord>>) : [];
    if (list.length === 0) return `${c.dim("No recipes")} in ${cmd.colony}. Declare one: ft recipe ${cmd.colony} rename <old> <new> --scope 'src/**'`;
    return list
      .map((r) => {
        const batches = Array.isArray(r.batches) ? r.batches.length : 0;
        return `${plain(r.id).padEnd(26)} ${(STATE_WORDS[String(r.state)] ?? String(r.state)).padEnd(18)} ${recipeWords(r.recipe)}  ${c.dim(`${batches} batch${batches === 1 ? "" : "es"}, ${r.changed ?? 0} files`)}`;
      })
      .join("\n");
  }
  if (cmd.action === "show") {
    const r = (res ?? {}) as { record?: Partial<RecipeRecord>; residue?: { examined?: number; rewrite?: string[]; untransformed?: Array<{ path: string; reason: string }>; truncated?: boolean; grep?: string[] } };
    const lines = recipeLines(r.record ?? {}, cmd.colony, c);
    const rest = r.residue;
    if (rest) {
      const rewrite = Array.isArray(rest.rewrite) ? rest.rewrite : [];
      const left = Array.isArray(rest.untransformed) ? rest.untransformed : [];
      const head = rewrite.length === 0 ? c.green("nothing left to rewrite") : c.yellow(`${rewrite.length} file${rewrite.length === 1 ? "" : "s"} it would still rewrite`);
      lines.push(`  on trunk now: ${head} in ${rest.examined ?? 0} scope files read${rest.truncated ? " (the first ones)" : ""}${left.length > 0 ? `, ${left.length} it leaves as they are` : ""}`);
      if (rewrite.length > 0) lines.push(c.dim(`    ${rewrite.slice(0, 8).map(plain).join(", ")}${rewrite.length > 8 ? ` and ${rewrite.length - 8} more` : ""}`));
      if (Array.isArray(rest.grep)) {
        const old = plain(r.record?.recipe?.args?.from);
        lines.push(`  grep for ${old} as a word: ${rest.grep.length === 0 ? c.green("none left") : `${rest.grep.length} file${rest.grep.length === 1 ? "" : "s"} (comments and strings count; the rename leaves those)`}`);
      }
    }
    return lines.join("\n");
  }
  if (cmd.action === "approve") return [`${c.green("Approved")} ${plain(cmd.id)}.`, ...recipeLines((res ?? {}) as Partial<RecipeRecord>, cmd.colony, c)].join("\n");
  const r = (res ?? {}) as { intent?: { id?: string; title?: string }; recipe?: Partial<RecipeRecord> };
  return [`${c.green("Declared")} ${c.bold(plain(r.intent?.title) || "the recipe")}`, ...recipeLines(r.recipe ?? {}, cmd.colony, c)].join("\n");
}

/**
 * `ft why` rows for recipes: a recipe's batch names the recipe, who declared it and what it rewrote; a change that landed
 * with a recipe applied names each recipe, its landing and the files it rewrote.
 */
export function recipeWhyRows(
  note: { recipe?: Partial<NoteRecipe> } | null | undefined,
  proposal: { recipes?: Array<{ recipe: string; landing: string; paths: string[] }> } | null,
): Array<{ k: string; v: string }> {
  const out: Array<{ k: string; v: string }> = [];
  const r = note?.recipe;
  if (r && proposal === null) {
    const outputs = Array.isArray(r.outputs) ? r.outputs.length : 0;
    const left = (Array.isArray(r.untransformed) ? r.untransformed.length : 0) + (typeof r.untransformedMore === "number" ? r.untransformedMore : 0);
    out.push({ k: "recipe", v: `${plain(r.id)} ${recipeWords({ kind: r.kind, args: r.args })}, declared by ${plain(r.by) || "a person"}` });
    out.push({ k: "batch", v: `${r.batch ?? "?"}: ${outputs} file${outputs === 1 ? "" : "s"} rewritten through ${plain(r.through)}${left > 0 ? `, ${left} left as they were` : ""}` });
    if (r.why) out.push({ k: "why", v: plain(r.why).slice(0, 160) });
  }
  for (const a of Array.isArray(proposal?.recipes) ? proposal!.recipes! : []) {
    out.push({ k: "recipe", v: `${plain(a.recipe)} (landing ${plain(a.landing)}) rewrote ${(Array.isArray(a.paths) ? a.paths : []).slice(0, 4).map(plain).join(", ")} as it landed: built before the recipe, it landed with it applied` });
  }
  return out;
}
