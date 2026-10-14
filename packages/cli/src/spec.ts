import type { Intent, RuleKind } from "@fire_trident/core";
import { colonyPath, ruleBody } from "./api.ts";
import type { ApiRequest } from "./api.ts";

/** A rule declared in a spec. */
export interface SpecRule {
  kind: RuleKind;
  description: string;
  spec: Record<string, unknown>;
}

/** One unit of work declared in a spec: becomes an intent with a predicted footprint. */
export interface SpecIntent {
  title: string;
  why: string;
  footprint: string[];
  acceptance?: string[];
  priority?: number;
  /**
   * Files this intent builds on, each created by another intent of the spec. They order the
   * work (a dependency keeps at least its dependents' priority and becomes the intent's parent),
   * and the intent's agent waits for them to land on trunk and reads them before it writes.
   */
  uses?: string[];
  /**
   * The model its files are written with, whichever agent takes it: "default" or "bulk" (the
   * server's models) or a model id. Integration-heavy intents ask for "default"; the rest suit bulk agents.
   */
  model?: string;
  /**
   * Contest mode: 2 to 4 agents each build this intent at once and the colony lands one change, the
   * best by evidence and then by a pairwise comparison. 1 or absent: one agent, as usual.
   */
  contest?: number;
}

/**
 * Governance a spec declares up front: the colony's decide policy, set before any rule or intent
 * exists (POST /decide/policy), so no agent can change a protected path before the policy holds.
 */
export interface SpecPolicy {
  /**
   * Paths only a person may change: globs as rules write them (at most 50), kept as the server keeps
   * them. A change that writes, deletes or renames a path one covers goes to a person, even with
   * review off; a glob naming a directory covers everything under it.
   */
  protectedPaths?: string[];
  /**
   * Whether a change to existing script files that only edits comments and whitespace lands on the
   * deterministic proof, without a model (the server's default: true).
   */
  commentProof?: boolean;
}

/** The machine-readable part of a project spec (`spec/v1`). */
export interface ProjectSpec {
  firetrident: "spec/v1";
  name: string;
  /** Directory depth of a region on the colony map (default: the server default). */
  regionDepth?: number;
  goal: { title: string; why: string };
  /**
   * The `##` headings of the Markdown sections every intent carries as its spec context
   * (default: every `##` section except the one holding this block).
   */
  context?: string[];
  /** Governance set before the rules and intents (absent, or setting nothing: the server's defaults). */
  policy?: SpecPolicy;
  rules: SpecRule[];
  intents: SpecIntent[];
}

/**
 * Body for POST /intents (ColonyDO.addIntent input). `force`: declare it even when the colony finds it a twin of an
 * intent it has (FT_TWINS); a server that predates twins ignores it.
 */
export type IntentBody = Omit<Intent, "id" | "status" | "createdAt"> & { force?: boolean };

/** One planned intent: its request, plus which planned intent becomes its parent once created. */
export interface PlannedIntent extends ApiRequest {
  /** Position in `intents` of the intent whose id becomes this one's `parentId`. */
  parentIndex?: number;
}

/**
 * The server caps an intent's `why` at 20,000 characters; the spec context fills what the
 * intent's own text leaves of this budget.
 */
export const WHY_MAX = 19_000;

/** Line that opens the spec context inside an intent's `why` (agents split on it). */
export const SPEC_CONTEXT_LABEL = "Spec context";

function bad(message: string): never {
  throw new Error(`spec: ${message}`);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function text(v: unknown, where: string): string {
  if (typeof v !== "string" || !v.trim()) bad(`${where} must be a non-empty string`);
  return v;
}

/** A repository path as specs write it: trimmed, forward slashes, no leading "./" or "/". */
export function specPath(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

const MACHINE_FENCE = /^(`{3,}|~{3,})[ \t]*json[ \t]+firetrident[ \t]*$/;

/**
 * Find the fenced block whose info string is `json firetrident` in a Markdown
 * spec, parse it, and validate it. Throws with the offending field on error.
 * A `context` list must name `##` sections that exist in the Markdown.
 */
export function extractSpec(markdown: string): ProjectSpec {
  const blocks = [...markdown.matchAll(/^(`{3,}|~{3,})[ \t]*json[ \t]+firetrident[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm)];
  if (blocks.length === 0) bad("no ```json firetrident block found");
  if (blocks.length > 1) bad("more than one ```json firetrident block");
  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0]?.[2] ?? "");
  } catch (e) {
    bad(`block is not valid JSON: ${(e as Error).message}`);
  }
  const spec = validateSpec(raw);
  if (spec.context) {
    const headings = new Set(specSections(markdown).map((s) => s.h2.toLowerCase()));
    spec.context.forEach((h, i) => {
      if (!headings.has(h.trim().toLowerCase())) bad(`context[${i}] names no "## ${h}" section of the spec`);
    });
  }
  return spec;
}

/** Check a parsed spec object field by field (including the dependency graph `uses` draws). */
export function validateSpec(raw: unknown): ProjectSpec {
  if (!raw || typeof raw !== "object") bad("block must be a JSON object");
  const o = raw as Record<string, unknown>;
  if (o.firetrident !== "spec/v1") bad(`"firetrident" must be "spec/v1"`);
  const name = text(o.name, "name");
  const goal = o.goal as Record<string, unknown> | undefined;
  if (!goal || typeof goal !== "object") bad("goal must be an object with title and why");
  const spec: ProjectSpec = { firetrident: "spec/v1", name, goal: { title: text(goal.title, "goal.title"), why: text(goal.why, "goal.why") }, rules: [], intents: [] };
  if (o.regionDepth !== undefined) {
    if (typeof o.regionDepth !== "number" || !Number.isInteger(o.regionDepth) || o.regionDepth < 1 || o.regionDepth > 6) bad("regionDepth must be an integer from 1 to 6");
    spec.regionDepth = o.regionDepth;
  }
  if (o.context !== undefined) {
    if (!isStringArray(o.context) || o.context.some((h) => !h.trim())) bad("context must be an array of section headings");
    spec.context = o.context.map((h) => h.trim());
  }
  if (o.policy !== undefined) {
    const policy = specPolicy(o.policy);
    if (Object.keys(policy).length > 0) spec.policy = policy;
  }

  if (!Array.isArray(o.rules)) bad("rules must be an array");
  o.rules.forEach((r: unknown, i: number) => {
    const at = `rules[${i}]`;
    if (!r || typeof r !== "object") bad(`${at} must be an object`);
    const rr = r as Record<string, unknown>;
    if (rr.kind !== "forbid-pattern" && rr.kind !== "forbid-import") bad(`${at}.kind must be forbid-pattern or forbid-import`);
    const s = rr.spec as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object") bad(`${at}.spec must be an object`);
    text(s.hint, `${at}.spec.hint`);
    if (rr.kind === "forbid-pattern") {
      const flags = s.flags === undefined ? undefined : text(s.flags, `${at}.spec.flags`);
      try {
        new RegExp(text(s.pattern, `${at}.spec.pattern`), flags);
      } catch (e) {
        bad(`${at}.spec.pattern is not a valid RegExp: ${(e as Error).message}`);
      }
      for (const k of ["include", "exclude"]) if (s[k] !== undefined && !isStringArray(s[k])) bad(`${at}.spec.${k} must be an array of globs`);
      if (s.replacement !== undefined && typeof s.replacement !== "string") bad(`${at}.spec.replacement must be a string`);
    } else {
      if (!isStringArray(s.from) || s.from.length === 0) bad(`${at}.spec.from must be a non-empty array of globs`);
      try {
        new RegExp(text(s.module, `${at}.spec.module`));
      } catch (e) {
        bad(`${at}.spec.module is not a valid RegExp: ${(e as Error).message}`);
      }
    }
    spec.rules.push({ kind: rr.kind, description: text(rr.description, `${at}.description`), spec: s });
  });

  if (!Array.isArray(o.intents) || o.intents.length === 0) bad("intents must be a non-empty array");
  o.intents.forEach((it: unknown, i: number) => {
    const at = `intents[${i}]`;
    if (!it || typeof it !== "object") bad(`${at} must be an object`);
    const x = it as Record<string, unknown>;
    if (!isStringArray(x.footprint) || x.footprint.length === 0) bad(`${at}.footprint must be a non-empty array of paths`);
    if (x.acceptance !== undefined && !isStringArray(x.acceptance)) bad(`${at}.acceptance must be an array of strings`);
    if (x.priority !== undefined && (typeof x.priority !== "number" || !Number.isFinite(x.priority))) bad(`${at}.priority must be a number`);
    if (x.uses !== undefined && (!isStringArray(x.uses) || x.uses.some((u) => !specPath(u)))) bad(`${at}.uses must be an array of paths`);
    if (x.model !== undefined && (typeof x.model !== "string" || !/^\S+$/.test(x.model))) bad(`${at}.model must be a model id, "default" or "bulk"`);
    if (x.contest !== undefined && (typeof x.contest !== "number" || !Number.isInteger(x.contest) || x.contest < 1 || x.contest > 4)) bad(`${at}.contest must be 2 to 4 agents (1: one agent)`);
    const intent: SpecIntent = { title: text(x.title, `${at}.title`), why: text(x.why, `${at}.why`), footprint: x.footprint };
    if (x.acceptance !== undefined) intent.acceptance = x.acceptance as string[];
    if (typeof x.priority === "number") intent.priority = x.priority;
    if (x.uses !== undefined) intent.uses = [...new Set((x.uses as string[]).map(specPath))];
    if (typeof x.model === "string") intent.model = x.model;
    if (typeof x.contest === "number" && x.contest > 1) intent.contest = x.contest;
    spec.intents.push(intent);
  });
  dependencyPlan(spec.intents);
  return spec;
}

/** The fields a spec's `policy` block may set. */
const POLICY_FIELDS = ["protectedPaths", "commentProof"];
/** The most protected paths a colony keeps (POST /decide/policy refuses more). */
const MAX_PROTECTED_PATHS = 50;
/** The longest protected path the server keeps. */
const MAX_GLOB_CHARS = 300;
/** {a,b} alternatives the server's glob matcher expands one glob into; past this the glob matches nothing. */
const MAX_EXPANSIONS = 256;

/**
 * Check a spec's `policy` block as POST /decide/policy checks it (policyProblems in
 * packages/worker/src/decide/policy.ts), so `ft new` does not stop at the policy after creating
 * the colony. Globs come back as the server keeps them: normalized, each once. A field the block
 * does not take is refused rather than dropped: a misspelled one would leave paths unprotected
 * while the spec's author believes them protected.
 */
function specPolicy(v: unknown): SpecPolicy {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(`policy must be an object with ${POLICY_FIELDS.join(" and/or ")}`);
  const p = v as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!POLICY_FIELDS.includes(k)) bad(`policy.${k} is not a policy field (${POLICY_FIELDS.join(", ")})`);
  const policy: SpecPolicy = {};
  if (p.protectedPaths !== undefined) {
    const globs = p.protectedPaths;
    if (!Array.isArray(globs)) bad("policy.protectedPaths must be an array of globs");
    if (globs.length > MAX_PROTECTED_PATHS) bad(`policy.protectedPaths has ${globs.length} globs; a colony keeps at most ${MAX_PROTECTED_PATHS}`);
    globs.forEach((g: unknown, k: number) => {
      if (typeof g !== "string") bad(`policy.protectedPaths[${k}] must be a string`);
      const why = protectedGlobProblem(g);
      if (why) bad(`policy.protectedPaths[${k}]: ${why}`);
    });
    policy.protectedPaths = [...new Set((globs as string[]).map(protectedGlob))];
  }
  if (p.commentProof !== undefined) {
    if (typeof p.commentProof !== "boolean") bad("policy.commentProof must be true or false");
    policy.commentProof = p.commentProof;
  }
  return policy;
}

/** A protected-path glob as the server keeps it: trimmed, without a leading "./" or "/" or a trailing "/". */
function protectedGlob(glob: string): string {
  return glob.trim().replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "");
}

/**
 * Why the server would refuse `glob` as a protected path, in its words, or null: it is empty, longer
 * than 300 characters, not one line, or the glob matcher would not match even the path built from
 * its first {a,b} alternative (it gives up past 256 alternatives). The published CLI runs without
 * @fire_trident/core, so this repeats globProblem (packages/worker/src/decide/policy.ts) and the
 * parts of globMatch (packages/core/src/morph.ts) it relies on; test/spec-policy.test.ts holds the
 * two in step.
 */
function protectedGlobProblem(glob: string): string | null {
  const g = protectedGlob(glob);
  if (g === "") return "a protected path cannot be empty";
  if (g.length > MAX_GLOB_CHARS) return `a protected path has at most ${MAX_GLOB_CHARS} characters`;
  if (/[\x00-\x1f\x7f]/.test(g)) return "a protected path is one line of text";
  const alternatives = expandBraces(g);
  const sample = (alternatives?.[0] ?? "").replace(/[*?]/g, "a").split("/");
  const matched = alternatives?.some((alt) => segmentsMatch(alt.replace(/^(?:\.\/|\/)+/, "").split("/"), sample)) ?? false;
  return matched ? null : "a protected path with this many {a,b} alternatives would match nothing";
}

/** A glob's {a,b} alternatives as the server's matcher expands them (nested; a group without a comma is literal), or null past 256. */
function expandBraces(glob: string): string[] | null {
  for (let open = glob.indexOf("{"); open !== -1; open = glob.indexOf("{", open + 1)) {
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let i = open; i < glob.length && close === -1; i++) {
      const c = glob[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) close = i;
      else if (c === "," && depth === 1) commas.push(i);
    }
    if (close === -1 || commas.length === 0) continue;
    const tails = expandBraces(glob.slice(close + 1));
    if (tails === null) return null;
    const cuts = [open, ...commas, close];
    const out: string[] = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const options = expandBraces(glob.slice(cuts[k]! + 1, cuts[k + 1]!));
      if (options === null) return null;
      for (const option of options) {
        for (const tail of tails) if (out.push(glob.slice(0, open) + option + tail) > MAX_EXPANSIONS) return null;
      }
    }
    return out;
  }
  return [glob];
}

/** Match path segments against glob segments as the server's matcher does; a "**" segment takes zero or more path segments. */
function segmentsMatch(glob: string[], path: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (gi: number, pi: number): boolean => {
    const key = gi * (path.length + 1) + pi;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const g = glob[gi];
    let result: boolean;
    if (g === undefined) result = pi === path.length;
    else if (g === "**") result = go(gi + 1, pi) || (pi < path.length && go(gi, pi + 1));
    else result = pi < path.length && segmentMatch(g, path[pi]!) && go(gi + 1, pi + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** Wildcard match inside one segment (`*` any run, `?` one character), backtracking to the last `*`. */
function segmentMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    const c = pattern[p];
    if (c === "*") {
      star = p++;
      resume = t;
    } else if (c !== undefined && (c === "?" || c === text[t])) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** How `ft new` orders and links a spec's intents (see dependencyPlan). */
export interface DependencyPlan {
  /** Intent indexes in creation order: every intent comes after the intents it uses. */
  order: number[];
  /** Effective priority per intent: declared, or one above the highest intent that uses it (1 for leaves). */
  priority: number[];
  /** Per intent, the dependency in the latest wave (lowest priority), which becomes its parent. */
  parent: Array<number | undefined>;
  /** Per intent, the intents it depends on, in `uses` order. */
  dependsOn: number[][];
}

/**
 * The dependency graph `uses` draws over a spec's intents. An intent depends on every other
 * intent whose footprint names a path it uses. Throws when a used path is created by no other
 * intent, when intents depend on each other in a cycle, or when a dependency would run in a
 * later wave than an intent that uses it (lower priority).
 */
export function dependencyPlan(intents: SpecIntent[]): DependencyPlan {
  const n = intents.length;
  const producers = new Map<string, number[]>();
  intents.forEach((it, i) => {
    for (const p of it.footprint.map(specPath)) producers.set(p, [...(producers.get(p) ?? []), i]);
  });
  const dependsOn: number[][] = intents.map((it, i) => {
    const out: number[] = [];
    for (const u of it.uses ?? []) {
      const own = it.footprint.map(specPath).includes(u);
      const from = (producers.get(u) ?? []).filter((j) => j !== i);
      if (own) bad(`intents[${i}].uses names ${u}, which is in its own footprint`);
      if (from.length === 0) bad(`intents[${i}].uses names ${u}, which no other intent's footprint creates`);
      for (const j of from) if (!out.includes(j)) out.push(j);
    }
    return out;
  });

  // Kahn's algorithm, always taking the earliest ready intent, so the spec's order is kept where it can be.
  const remaining = dependsOn.map((d) => d.length);
  const dependents: number[][] = intents.map(() => []);
  dependsOn.forEach((ds, i) => ds.forEach((d) => dependents[d]!.push(i)));
  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (remaining[i] === 0) ready.push(i);
  const order: number[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const i = ready.shift()!;
    order.push(i);
    for (const j of dependents[i]!) {
      const left = (remaining[j] ?? 0) - 1;
      remaining[j] = left;
      if (left === 0) ready.push(j);
    }
  }
  if (order.length < n) {
    const stuck = intents.map((it, i) => ({ it, i })).filter(({ i }) => !order.includes(i));
    bad(`these intents use each other's files in a cycle: ${stuck.map(({ it, i }) => `intents[${i}] "${it.title}"`).join(", ")}`);
  }

  const priority: number[] = new Array<number>(n).fill(1);
  for (const i of [...order].reverse()) {
    const declared = intents[i]!.priority;
    priority[i] = declared ?? Math.max(1, ...dependents[i]!.map((j) => priority[j]! + 1));
  }
  dependsOn.forEach((ds, j) => {
    for (const d of ds) {
      if (priority[d]! < priority[j]!) {
        bad(
          `intents[${j}] "${intents[j]!.title}" has priority ${priority[j]} but builds on intents[${d}] "${intents[d]!.title}" at priority ${priority[d]}; a dependency needs at least the priority of the intents that use it`,
        );
      }
    }
  });
  const parent = dependsOn.map((ds) => {
    let best: number | undefined;
    for (const d of ds) if (best === undefined || priority[d]! < priority[best]!) best = d;
    return best;
  });
  return { order, priority, parent, dependsOn };
}

/** One `##` or `###` chunk of a Markdown spec. */
export interface SpecSection {
  /** The `##` heading this chunk sits under ("" before the first one). */
  h2: string;
  /** Its own heading text (the `##` or `###` line without the hashes). */
  heading: string;
  level: 2 | 3;
  /** The chunk, heading line included, without trailing blank lines. */
  text: string;
  /** True when the chunk holds the ```json firetrident block. */
  machine: boolean;
}

/**
 * Split a Markdown spec into `##` and `###` chunks (headings inside fenced code do not count).
 * Text before the first `##` heading is the preamble, with `h2` "".
 */
export function specSections(markdown: string): SpecSection[] {
  const out: SpecSection[] = [];
  let cur: SpecSection = { h2: "", heading: "", level: 2, text: "", machine: false };
  let lines: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    cur.text = lines.join("\n").replace(/\s+$/, "");
    if (cur.text.trim() !== "") out.push(cur);
  };
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (fence === null && f) {
      fence = f[1]!;
      if (MACHINE_FENCE.test(line.trim())) cur.machine = true;
    } else if (fence !== null && f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) {
      fence = null;
    } else if (fence === null) {
      const h = /^(#{2,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
      if (h) {
        flush();
        const level = h[1]!.length === 2 ? 2 : 3;
        const heading = h[2]!.trim();
        cur = { h2: level === 2 ? heading : cur.h2, heading, level, text: "", machine: false };
        lines = [line];
        continue;
      }
    }
    lines.push(line);
  }
  flush();
  return out;
}

/**
 * The spec context one intent carries: the sections named in `spec.context` (or every `##`
 * section but the machine-readable one), in document order. When they exceed `budget`
 * characters, the chunks that name the intent's own files come first, then the files it uses,
 * then the rest, each in document order, until the budget is spent.
 */
export function specContext(markdown: string, spec: Pick<ProjectSpec, "context">, intent: Pick<SpecIntent, "footprint" | "uses">, budget: number): string {
  const wanted = spec.context ? new Set(spec.context.map((h) => h.toLowerCase())) : null;
  const machineH2 = new Set(specSections(markdown).filter((s) => s.machine).map((s) => s.h2));
  const chunks = specSections(markdown).filter((s) => s.h2 !== "" && !s.machine && (wanted ? wanted.has(s.h2.toLowerCase()) : !machineH2.has(s.h2)));
  const join = (list: SpecSection[]): string => list.map((s) => s.text).join("\n\n");
  if (join(chunks).length <= budget) return join(chunks);
  const own = intent.footprint.map(specPath);
  const used = (intent.uses ?? []).map(specPath);
  const score = (s: SpecSection): number => (own.some((p) => s.text.includes(p)) ? 2 : used.some((p) => s.text.includes(p)) ? 1 : 0);
  const ranked = chunks.map((s, i) => ({ s, i, score: score(s) })).sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = new Set<number>();
  let spent = 0;
  for (const r of ranked) {
    const cost = r.s.text.length + 2;
    if (spent + cost > budget) continue;
    picked.add(r.i);
    spent += cost;
  }
  return join(chunks.filter((_, i) => picked.has(i)));
}

/**
 * An intent's `why` as `ft new` writes it. In-platform agents parse this layout
 * (packages/worker/src/agents/create.ts), so keep the two in step:
 *
 *   <why>
 *
 *   Scope: this intent writes <footprint>. It is one of <n> intents that build "<goal>"; ...
 *   Builds on: <path>, <path>          (only when the intent uses other intents' files)
 *   Model: <model>                     (only when the intent asks for one)
 *
 *   Spec context (<source>):            (only when the spec's Markdown is given)
 *   <the context sections>
 *
 * Reviewers in the decide layer read the first 800 characters, so the head is short, says
 * the intent is one part of the spec (a reviewer once returned a correct module for
 * "omitting" another intent's module), and the spec's conventions follow it directly.
 */
export function intentWhy(spec: ProjectSpec, intent: SpecIntent, opts: { markdown?: string; source?: string } = {}): string {
  // Reviewers judge a change against this text: say plainly that the intent is one part of the spec.
  const files = intent.footprint.map(specPath);
  const n = spec.intents.length;
  let why = `${intent.why.trim()}\n\nScope: this intent writes ${files.join(", ")}${
    n > 1 ? `. It is one of ${n} intents that build "${spec.goal.title}"; the other files are other intents' work.` : ` for "${spec.goal.title}".`
  }`;
  if (intent.uses && intent.uses.length > 0) why += `\nBuilds on: ${intent.uses.join(", ")}`;
  if (intent.model) why += `\nModel: ${intent.model}`;
  if (opts.markdown !== undefined) {
    const label = `${SPEC_CONTEXT_LABEL} (${opts.source ?? "the spec"}):`;
    const context = specContext(opts.markdown, spec, intent, WHY_MAX - why.length - label.length - 4);
    if (context) why += `\n\n${label}\n${context}`;
  }
  return why.length > WHY_MAX ? why.slice(0, WHY_MAX) : why;
}

/** The first paragraph of an intent's `why` (what a person wrote, without the spec context `ft new` adds). */
export function whySummary(why: string): string {
  return (why.split(/\r?\n[ \t]*\r?\n/)[0] ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Plan `ft new`: create an empty colony, set the spec's policy when it declares one, then one POST
 * per rule and per intent. The policy goes first, so a protected path needs a person before any
 * agent has work to take; rules go next so the morphology check is live before any code lands.
 * Intents follow in dependency order (each after the intents it uses), so a parent exists before
 * its child. With `markdown`, every intent carries the spec's context sections in its `why`.
 */
export function planNew(
  spec: ProjectSpec,
  colony: string,
  by: string,
  name?: string,
  opts: { markdown?: string; source?: string } = {},
): { create: ApiRequest; policy?: ApiRequest; rules: ApiRequest[]; intents: PlannedIntent[] } {
  const deps = dependencyPlan(spec.intents);
  const position = new Map<number, number>(deps.order.map((idx, pos) => [idx, pos]));
  // A spec without a policy plans the same calls as before policies existed.
  const policy = spec.policy ? { policy: { method: "POST" as const, path: colonyPath(colony, "/decide/policy"), body: { ...spec.policy } } } : {};
  return {
    create: { method: "POST", path: "/api/colonies", body: spec.regionDepth ? { name: name ?? spec.name, regionDepth: spec.regionDepth } : { name: name ?? spec.name } },
    ...policy,
    rules: spec.rules.map((r) => ({ method: "POST", path: colonyPath(colony, "/rules"), body: ruleBody(colony, r.kind, r.spec, r.description, by) })),
    intents: deps.order.map((idx) => {
      const i = spec.intents[idx]!;
      const body: IntentBody = {
        colonyId: colony,
        title: i.title,
        why: intentWhy(spec, i, opts),
        source: "human",
        footprint: i.footprint,
        priority: deps.priority[idx]!,
        createdBy: by,
        // A spec's intents are one plan a person wrote, never twins of each other: the twin check skips them.
        force: true,
      };
      if (i.acceptance) body.acceptance = i.acceptance;
      if (i.contest) body.contest = i.contest;
      const planned: PlannedIntent = { method: "POST", path: colonyPath(colony, "/intents"), body };
      const parent = deps.parent[idx];
      if (parent !== undefined) planned.parentIndex = position.get(parent)!;
      return planned;
    }),
  };
}
