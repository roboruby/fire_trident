import type { Path } from "@fire_trident/core";
import { normalizeType, pair, parseMembers, parseParams, readModule, readType, readableSource, sameType, type TsDecl, type TsMember, type TsModule, type TsParam, type TsSignature, type TypeMatch } from "./tsexports.ts";

/**
 * Acceptance and keep lines FireTrident checks itself (FT_REVIEW_VIEW, decide/reviewview.ts). A line that names a file and
 * what it exports ("src/core/money.ts exports isZero(m: Money): boolean", "src/x.ts exports interface Options { a?: boolean }
 * and LIMIT = 2", "src/x.ts exists") is read into claims, and each claim is checked in the file's text after the change
 * (decide/tsexports.ts), so no model has to find it in a diff. A line whose claims are the whole line and all hold is met;
 * one with a claim that does not hold is not met, with the exact mismatch; anything else (a line that says more than its
 * claims, or a claim the reader cannot settle) is left to the model. A keep line counts as broken only when its claim held
 * before the change and does not after it: one that did not hold before either is not this change's doing. Pure.
 */

/** One thing a line says of its file. */
export type Claim =
  | { kind: "exists"; text: string }
  | { kind: "export"; name: string; text: string }
  | { kind: "function"; name: string; typeParams: string; params: TsParam[]; returns: string | null; text: string }
  | { kind: "interface"; name: string; members: TsMember[] | null; text: string }
  | { kind: "type"; name: string; type: string; text: string }
  | { kind: "value"; name: string; value: string; text: string }
  | { kind: "typed"; name: string; type: string; text: string }
  | { kind: "class"; name: string; text: string };

/** A line read into claims about one file; `rest` is what it says beyond them ("" when the claims are the whole line). */
export interface LineClaims {
  path: Path;
  claims: Claim[];
  rest: string;
}

/** A file's text for the check: its content, null when the file does not exist, undefined when it could not be read. */
export type FileText = string | null | undefined;

/** How one claim came out, with what the file has (or why it does not hold) in words. */
export interface ClaimResult {
  match: TypeMatch;
  found: string;
}

/** What FireTrident makes of a line: met, broken (not met), stale (a keep line that did not hold before either) or open (for the model). */
export interface LineCheck {
  state: "met" | "broken" | "stale" | "open";
  path: Path;
  /** Met: what it read; broken or stale: the mismatch; open: "". */
  found: string;
  /** Open: the claims that hold, in words (FireTrident checked that part of the line). */
  held: string[];
}

const PATH = /^\s*(?:the file\s+)?[`"']?((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]+)[`"']?\s+/;
const IDENT = /^[A-Za-z_$][\w$]*/;
/** Words a sentence may put where a name could be: never read as an export's name. */
const NOT_NAMES: ReadonlySet<string> = new Set(["a", "an", "the", "it", "its", "them", "this", "that", "these", "those", "nothing", "none", "no", "only", "all", "both", "each", "every", "everything", "one", "two", "some", "any", "more", "less", "also", "still", "and", "or", "not", "with", "without", "from", "to", "of"]);

/** The index of the first character at or after `i` that is not white space. */
function ws(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

/** Does a name read as code, so its absence from a file is sure to be a mismatch? camelCase, CONSTANT_CASE, digits, _ or $. */
function codeLike(name: string): boolean {
  return /[A-Z_$\d]/.test(name.slice(1)) || /^[A-Z_$]/.test(name);
}

/** The end of a literal value at `i` (a number, a string, true, false, null, an array or an object), or -1. */
function literalEnd(s: string, i: number): number {
  const c = s[i];
  if (c === "[" || c === "{") return pair(s, i);
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "\\") j++;
      else if (s[j] === c) return j + 1;
    }
    return -1;
  }
  const m = /^(?:-?\d[\d_]*(?:\.\d+)?|true\b|false\b|null\b)/.exec(s.slice(i, i + 60));
  return m ? i + m[0].length : -1;
}

/** Does the text at `end` close a bare name: the line's end, a separator, punctuation or a parenthesis? */
function closesBare(s: string, end: number): boolean {
  const rest = s.slice(end);
  return /^\s*$/.test(rest) || /^\s*[,;:.]/.test(rest) || /^\s+(?:and\s|\()/.test(rest);
}

/** The declaration a line names at `i`, or null. */
function parseDecl(s: string, i: number): { claim: Claim; end: number } | null {
  const start = ws(s, i);
  let j = start;
  const kw = /^(interface|type|function|const|class)\s+/.exec(s.slice(j));
  if (kw) j += kw[0].length;
  const name = IDENT.exec(s.slice(j, j + 200))?.[0];
  if (!name || (!kw && NOT_NAMES.has(name))) return null;
  j += name.length;
  const text = (end: number): string => s.slice(start, end).replace(/\s+/g, " ").trim();
  if (kw?.[1] === "interface") {
    let k = ws(s, j);
    if (s[k] === "<") {
      const e = pair(s, k);
      if (e < 0) return null;
      k = ws(s, e);
    }
    if (s[k] !== "{") return { claim: { kind: "interface", name, members: null, text: text(j) }, end: j };
    const e = pair(s, k);
    if (e < 0) return null;
    return { claim: { kind: "interface", name, members: parseMembers(s.slice(k + 1, e - 1)), text: text(e) }, end: e };
  }
  if (kw?.[1] === "type") {
    let k = ws(s, j);
    if (s[k] === "<") {
      const e = pair(s, k);
      if (e < 0) return null;
      k = ws(s, e);
    }
    if (s[k] !== "=" || s[k + 1] === "=") return null;
    const ts = ws(s, k + 1);
    const te = readType(s, ts);
    if (te < 0) return null;
    return { claim: { kind: "type", name, type: s.slice(ts, te).trim(), text: text(te) }, end: te };
  }
  if (kw?.[1] === "class") return { claim: { kind: "class", name, text: text(j) }, end: j };
  let typeParams = "";
  if (s[j] === "<") {
    const e = pair(s, j);
    if (e > 0 && s[e] === "(") {
      typeParams = s.slice(j, e);
      j = e;
    }
  }
  if (s[j] === "(") {
    const e = pair(s, j);
    if (e < 0) return null;
    const params = parseParams(s.slice(j + 1, e - 1));
    if (!params) return null;
    let end = e;
    let returns: string | null = null;
    const c = ws(s, e);
    if (s[c] === ":") {
      const ts = ws(s, c + 1);
      const te = readType(s, ts);
      if (te > 0) {
        returns = s.slice(ts, te).trim();
        end = te;
      }
    }
    return { claim: { kind: "function", name, typeParams, params, returns, text: text(end) }, end };
  }
  const c = ws(s, j);
  if (s[c] === "=" && s[c + 1] !== "=" && s[c + 1] !== ">") {
    const vs = ws(s, c + 1);
    const ve = literalEnd(s, vs);
    if (ve < 0) return null;
    return { claim: { kind: "value", name, value: s.slice(vs, ve), text: text(ve) }, end: ve };
  }
  if (s[j] === ":") {
    const ts = ws(s, j + 1);
    const te = readType(s, ts);
    if (te < 0) return null;
    return { claim: { kind: "typed", name, type: s.slice(ts, te).trim(), text: text(te) }, end: te };
  }
  if (!closesBare(s, j)) return null;
  return { claim: { kind: "export", name, text: text(j) }, end: j };
}

/**
 * A line read into claims about one file (see the module comment): "<path> exports <declaration>[ and <declaration>]…"
 * (a declaration is `name(params): type`, `interface Name { members }`, `type Name = type`, `NAME = literal`,
 * `NAME: type`, `class Name`, or a bare name), "<path> exists", or "<name(params): type> in <path>"; "still", "also" and
 * "now" may come before the verb. Null when the line is not one of these.
 */
export function parseLine(line: string): LineClaims | null {
  const m = PATH.exec(line);
  if (!m) return signatureIn(line);
  const path = m[1]!;
  const s = line.slice(m[0].length);
  const verb = /^(?:(?:still|also|now)\s+)?(exists|exports?)\b:?\s*/.exec(s);
  if (!verb) return null;
  if (verb[1] === "exists") return { path, claims: [{ kind: "exists", text: `${path} exists` }], rest: tidy(s.slice(verb[0].length)) };
  const claims: Claim[] = [];
  const asides: string[] = [];
  let j = verb[0].length;
  for (;;) {
    const d = parseDecl(s, j);
    if (!d) break;
    claims.push(d.claim);
    j = d.end;
    // A parenthesis after a declaration, then another one: "negate(m: Money): Money (never -0) and isNegative(…)".
    let k = ws(s, j);
    let aside = "";
    if (s[k] === "(") {
      const e = pair(s, k, false);
      if (e > 0) {
        aside = s.slice(k, e);
        k = e;
      }
    }
    const sep = /^\s*(?:,\s*and\s+|and\s+|,\s*)/.exec(s.slice(k));
    if (!sep) break;
    const next = parseDecl(s, k + sep[0].length);
    if (!next) break;
    if (aside) asides.push(aside);
    j = k + sep[0].length;
  }
  if (claims.length === 0) return null;
  return { path, claims, rest: tidy([...asides, s.slice(j)].join(" ")) };
}

/** "percentOf(m: Money, basisPoints: number): Money in src/core/money.ts: …": a signature, then the file it is in. */
function signatureIn(line: string): LineClaims | null {
  const d = parseDecl(line, 0);
  if (!d || d.claim.kind !== "function") return null;
  const m = /^\s+in\s+[`"']?((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]+)[`"']?(?=[\s,;:.]|$)/.exec(line.slice(d.end));
  if (!m) return null;
  return { path: m[1]!, claims: [d.claim], rest: tidy(line.slice(d.end + m[0].length)) };
}

/** What a line says beyond its claims, without the punctuation that joins it to them. */
function tidy(text: string): string {
  return text
    .replace(/^[\s.,;:]+/, "")
    .replace(/[\s.]+$/, "")
    .trim();
}

/** A declaration's kind in words. */
function kindWord(d: TsDecl): string {
  if (d.kind === "function") return "a function";
  if (d.kind === "const") return d.signatures.length > 0 ? "a function" : "a constant";
  if (d.kind === "interface") return "an interface";
  if (d.kind === "type") return "a type alias";
  if (d.kind === "class") return "a class";
  if (d.kind === "enum") return "an enum";
  if (d.kind === "namespace") return "a namespace";
  return "an export from another file";
}

/** Is the name on a line of the module that says `export`, in a form the reader may not have followed? */
function mentioned(mod: TsModule, name: string): boolean {
  const word = new RegExp(`(?:^|[^\\w$])${name.replace(/\$/g, "\\$")}(?:[^\\w$]|$)`);
  return mod.clean.split("\n").some((l) => /\bexport\b/.test(l) && word.test(l));
}

/** The worst of several matches: differs over unknown over same. */
function worst(ms: readonly TypeMatch[]): TypeMatch {
  return ms.includes("differs") ? "differs" : ms.includes("unknown") ? "unknown" : "same";
}

/** A signature against the one a line states. */
function compareSignature(c: Extract<Claim, { kind: "function" }>, sig: TsSignature, mod: TsModule): TypeMatch {
  if (sig.returns === "?") return "unknown";
  if ((c.typeParams || sig.typeParams) && normalizeType(c.typeParams) !== normalizeType(sig.typeParams)) return "unknown";
  const a = c.params;
  const b = sig.params;
  const rest = a.some((p) => p.rest) || b.some((p) => p.rest);
  if (a.length !== b.length) return rest ? "unknown" : "differs";
  const out: TypeMatch[] = [];
  for (let k = 0; k < a.length; k++) {
    const x = a[k]!;
    const y = b[k]!;
    if (x.rest !== y.rest || x.optional !== y.optional) {
      out.push("differs");
      continue;
    }
    if (x.type === null) continue;
    out.push(y.type === null ? "unknown" : sameType(x.type, y.type, mod));
  }
  if (c.returns !== null) out.push(sig.returns === null ? "unknown" : sameType(c.returns, sig.returns, mod));
  return worst(out);
}

/** A literal value in one form: `as const` and `satisfies` dropped, white space only inside strings, strings in double quotes, no trailing comma. */
function normalizeValue(v: string): string {
  return v
    .trim()
    .replace(/;$/, "")
    .replace(/\s+(?:as\s+const|satisfies\s+[\s\S]+)$/, "")
    .replace(/'((?:\\.|[^'\\])*)'/g, (_, body: string) => JSON.stringify(body.replace(/\\'/g, "'")))
    .replace(/\s*([[\]{}(),:])\s*/g, "$1")
    .replace(/,([\]}])/g, "$1");
}

/** A constant's value against the one a line states. */
function compareValue(want: string, got: string): TypeMatch {
  const a = normalizeValue(want);
  const b = normalizeValue(got);
  const num = /^-?\d[\d_]*(?:\.\d+)?$/;
  if (num.test(a) && num.test(b)) return Number(a.replace(/_/g, "")) === Number(b.replace(/_/g, "")) ? "same" : "differs";
  if (a === b) return "same";
  const simple = /^(?:-?\d[\d_]*(?:\.\d+)?|"(?:\\.|[^"\\])*"|true|false|null)$/;
  return simple.test(a) && simple.test(b) ? "differs" : "unknown";
}

/** An interface's (or object type's) members against the ones a line states. */
function compareMembers(want: readonly TsMember[], decl: TsDecl, mod: TsModule): { match: TypeMatch; why: string } {
  const got = decl.members;
  if (!got) return { match: "unknown", why: "" };
  const out: TypeMatch[] = [];
  for (const w of want) {
    const g = got.find((m) => m.name === w.name);
    if (!g) {
      if (decl.inherits) out.push("unknown");
      else return { match: "differs", why: `has no member ${w.name}` };
      continue;
    }
    if (g.optional !== w.optional) return { match: "differs", why: `has ${g.name}${g.optional ? "?" : ""}: ${g.type ?? "?"}, not ${w.name}${w.optional ? "?" : ""}: ${w.type ?? "?"}` };
    if (w.type === null) continue;
    const t = g.type === null ? "unknown" : sameType(w.type, g.type, mod);
    if (t === "differs") return { match: "differs", why: `has ${g.name}${g.optional ? "?" : ""}: ${g.type}, not ${w.name}${w.optional ? "?" : ""}: ${w.type}` };
    out.push(t);
  }
  // Members the line does not name: the line may not list them all.
  if (got.some((g) => !want.some((w) => w.name === g.name))) out.push("unknown");
  return { match: worst(out), why: "" };
}

/** Modules read once per text. */
export type ModuleCache = Map<string, TsModule>;

/** The module of a text, read once. */
function moduleOf(text: string, cache: ModuleCache): TsModule {
  let mod = cache.get(text);
  if (!mod) {
    mod = readModule(text);
    cache.set(text, mod);
  }
  return mod;
}

/** One claim checked in a file's text (undefined: unreadable; null: absent). */
export function checkClaim(c: Claim, path: Path, text: FileText, cache: ModuleCache = new Map()): ClaimResult {
  const unknown = (found = ""): ClaimResult => ({ match: "unknown", found });
  if (text === undefined) return unknown();
  if (text === null) return { match: "differs", found: `${path} does not exist` };
  if (c.kind === "exists") return { match: "same", found: `${path} exists` };
  if (!readableSource(path)) return unknown();
  const mod = moduleOf(text, cache);
  const decls = mod.exported.get(c.name);
  if (!decls || decls.length === 0) {
    const sure = mod.complete && !mentioned(mod, c.name) && (c.kind !== "export" || codeLike(c.name));
    return sure ? { match: "differs", found: `${path} does not export ${c.name}` } : unknown();
  }
  if (decls.some((d) => d.kind === "reexport")) return unknown();
  const d0 = decls[0]!;
  const is = (d: TsDecl): string => `${c.name} in ${path} is ${kindWord(d)}`;
  switch (c.kind) {
    case "export":
      return { match: "same", found: `${path} exports ${c.name}` };
    case "class":
      if (decls.some((d) => d.kind === "class")) return { match: "same", found: `${path} exports class ${c.name}` };
      return decls.every((d) => d.kind === "function" || d.kind === "interface" || d.kind === "type" || d.kind === "enum") ? { match: "differs", found: `${is(d0)}, not a class` } : unknown();
    case "function": {
      const sigs = decls.flatMap((d) => d.signatures);
      if (sigs.length === 0) return decls.every((d) => d.kind === "interface" || d.kind === "type" || d.kind === "enum") ? { match: "differs", found: `${is(d0)}, not a function` } : unknown();
      const results = sigs.map((s) => compareSignature(c, s, mod));
      const hit = results.indexOf("same");
      if (hit >= 0) return { match: "same", found: sigs[hit]!.text };
      if (results.every((r) => r === "differs")) return { match: "differs", found: `${path} has ${sigs.map((s) => s.text).join(" and ")}, not ${c.text}` };
      return unknown();
    }
    case "interface": {
      const d = decls.find((x) => x.kind === "interface") ?? decls.find((x) => x.kind === "type" && x.members !== null);
      if (!d) return decls.every((x) => x.kind === "function" || x.kind === "const" || x.kind === "enum") ? { match: "differs", found: `${is(d0)}, not an interface` } : unknown();
      if (c.members === null) return { match: "same", found: `${path} exports ${d.kind === "interface" ? "interface" : "type"} ${c.name}` };
      const r = compareMembers(c.members, d, mod);
      if (r.match === "differs") return { match: "differs", found: `${c.name} in ${path} ${r.why}` };
      return r.match === "same" ? { match: "same", found: `${path} exports ${d.kind === "interface" ? "interface" : "type"} ${c.name} with ${c.members.map((m) => m.name).join(", ")}` } : unknown();
    }
    case "type": {
      const d = decls.find((x) => x.kind === "type");
      if (!d) return decls.every((x) => x.kind === "function" || x.kind === "const") ? { match: "differs", found: `${is(d0)}, not a type` } : unknown();
      if (d.type === null) return unknown();
      const t = sameType(c.type, d.type, mod);
      if (t === "same") return { match: "same", found: `${path} exports type ${c.name} = ${d.type.replace(/\s+/g, " ")}` };
      return t === "differs" ? { match: "differs", found: `type ${c.name} in ${path} is ${d.type.replace(/\s+/g, " ")}, not ${c.type}` } : unknown();
    }
    case "value": {
      const d = decls.find((x) => x.kind === "const");
      if (!d) return decls.every((x) => x.kind === "function" || x.kind === "interface" || x.kind === "type") ? { match: "differs", found: `${is(d0)}, not a constant` } : unknown();
      if (d.value === null) return unknown();
      const t = compareValue(c.value, d.value);
      const got = d.value.replace(/\s+/g, " ").slice(0, 200);
      if (t === "same") return { match: "same", found: `${path} exports ${c.name} = ${got}` };
      return t === "differs" ? { match: "differs", found: `${c.name} in ${path} is ${got}, not ${c.value}` } : unknown();
    }
    case "typed": {
      // "exports name: …" may be a sentence about it rather than its type: only a constant's annotation is compared.
      const d = decls.find((x) => x.kind === "const" && x.type !== null);
      if (!d?.type) return unknown();
      const t = sameType(c.type, d.type, mod);
      if (t === "same") return { match: "same", found: `${path} exports ${c.name}: ${d.type.replace(/\s+/g, " ")}` };
      return t === "differs" ? { match: "differs", found: `${c.name} in ${path} is typed ${d.type.replace(/\s+/g, " ")}, not ${c.type}` } : unknown();
    }
  }
}

/** Findings in one sentence, each said once (two claims on a missing file find the same thing). */
function words(found: readonly string[]): string {
  return [...new Set(found)].join("; ");
}

/**
 * What FireTrident makes of one parsed line (see the module comment). `after` and `before` are the named file's text after
 * and before the change (the same text for a file the change does not write).
 */
export function checkLine(parsed: LineClaims, kind: "intent" | "keep", after: FileText, before: FileText, cache: ModuleCache = new Map()): LineCheck {
  const path = parsed.path;
  const now = parsed.claims.map((c) => checkClaim(c, path, after, cache));
  const held = now.filter((r) => r.match === "same").map((r) => r.found);
  const failing = parsed.claims.flatMap((c, i) => (now[i]!.match === "differs" ? [{ c, r: now[i]! }] : []));
  const open: LineCheck = { state: "open", path, found: "", held };
  if (failing.length > 0) {
    if (kind === "intent") return { state: "broken", path, found: words(failing.map((f) => f.r.found)), held: [] };
    // A keep line: broken only by a claim that held before this change.
    const then = failing.map((f) => checkClaim(f.c, path, before, cache));
    const broke = failing.filter((_, i) => then[i]!.match === "same");
    if (broke.length > 0) return { state: "broken", path, found: words(broke.map((f) => `${f.r.found}, though it held before this change`)), held: [] };
    if (then.every((t) => t.match === "differs")) return { state: "stale", path, found: words(failing.map((f) => f.r.found)), held: [] };
    return open;
  }
  if (now.every((r) => r.match === "same") && parsed.rest === "") return { state: "met", path, found: words(held), held: [] };
  return open;
}
