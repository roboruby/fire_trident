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
}

/** The machine-readable part of a project spec (`spec/v1`). */
export interface ProjectSpec {
  firetrident: "spec/v1";
  name: string;
  /** Directory depth of a region on the colony map (default: the server default). */
  regionDepth?: number;
  goal: { title: string; why: string };
  rules: SpecRule[];
  intents: SpecIntent[];
}

/** Body for POST /intents (ColonyDO.addIntent input). */
export type IntentBody = Omit<Intent, "id" | "status" | "createdAt">;

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

/**
 * Find the fenced block whose info string is `json firetrident` in a Markdown
 * spec, parse it, and validate it. Throws with the offending field on error.
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
  return validateSpec(raw);
}

/** Check a parsed spec object field by field. */
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
    const intent: SpecIntent = { title: text(x.title, `${at}.title`), why: text(x.why, `${at}.why`), footprint: x.footprint };
    if (x.acceptance !== undefined) intent.acceptance = x.acceptance as string[];
    if (typeof x.priority === "number") intent.priority = x.priority;
    spec.intents.push(intent);
  });
  return spec;
}

/**
 * Plan `ft new`: create an empty colony, then one POST per rule and per intent.
 * Rules go first so the morphology check is live before any code lands.
 */
export function planNew(spec: ProjectSpec, colony: string, by: string, name?: string): { create: ApiRequest; rules: ApiRequest[]; intents: ApiRequest[] } {
  return {
    create: { method: "POST", path: "/api/colonies", body: spec.regionDepth ? { name: name ?? spec.name, regionDepth: spec.regionDepth } : { name: name ?? spec.name } },
    rules: spec.rules.map((r) => ({ method: "POST", path: colonyPath(colony, "/rules"), body: ruleBody(colony, r.kind, r.spec, r.description, by) })),
    intents: spec.intents.map((i) => {
      const body: IntentBody = {
        colonyId: colony,
        title: i.title,
        why: `${i.why} (Goal: ${spec.goal.title})`,
        source: "human",
        footprint: i.footprint,
        priority: i.priority ?? 1,
        createdBy: by,
      };
      if (i.acceptance) body.acceptance = i.acceptance;
      return { method: "POST", path: colonyPath(colony, "/intents"), body };
    }),
  };
}
