import { checkFile, importsOf } from "@fire_trident/core";
import type { Path, Rule } from "@fire_trident/core";
import { cleanPath, oneLine } from "./change.ts";
import { resolveRelative } from "./context.ts";

/**
 * Writing files from a spec: the new-project flow. `ft new` (packages/cli/src/spec.ts,
 * intentWhy) writes each intent's `why` in this layout, and agents read it back here:
 *
 *   <why>
 *
 *   Scope: this intent writes <footprint>. It is one of <n> intents that build "<goal>"; ...
 *   Builds on: <path>, <path>
 *   Model: default                     (when the intent asks for a model class)
 *
 *   Spec context (<source>):
 *   <the spec's contracts, conventions, rules and acceptance scenarios>
 *
 * (A "Planned files: <path>, ..." line beside "Builds on:" is read too, when a spec tool writes one.)
 *
 * An agent waits until the files its intent builds on have landed, reads them, and writes
 * each file of its footprint with a model. Before a file is accepted it must pass the
 * checks below: it parses (a light lexer for scripts, a parser for JSON), it breaks no
 * colony rule, it uses only TypeScript that type stripping can run when the project asks
 * for that, every relative import names a file in trunk or in the same change, and every
 * imported name is one that module exports (a type imported as a value fails at load time
 * once Node strips the types).
 */

/** What an intent declared by a spec tells its agent beyond the title. */
export interface IntentSpec {
  /** The intent's own why (the text before the facts and the spec context). */
  why: string;
  /** Files other intents create that this one builds on. */
  buildsOn: Path[];
  /** Every file the spec plans (the colony's target shape). */
  planned: Path[];
  /** The model (or model class: "default", "bulk") the intent asks its files be written with, or null. */
  model: string | null;
  /** The spec context the intent carries, or null. */
  spec: string | null;
  /** Where the spec context came from (the label's parenthesis), or null. */
  source: string | null;
}

const CONTEXT_LINE = /\n\nSpec context(?: \(([^\n]*)\))?:\n/;
const BUILDS_ON = /^Builds on: (.+)$/m;
const PLANNED = /^Planned files: (.+)$/m;
const MODEL = /^Model: (\S+)\s*$/m;

function pathList(line: string | undefined): Path[] {
  if (!line) return [];
  return [...new Set(line.split(",").map((p) => cleanPath(p)).filter((p) => p !== ""))];
}

/** Parse an intent's `why` (see the layout above). Text without the layout is all `why`. */
export function parseIntentSpec(why: string): IntentSpec {
  const text = why ?? "";
  const m = CONTEXT_LINE.exec(text);
  const head = m ? text.slice(0, m.index) : text;
  const spec = m ? text.slice(m.index + m[0].length).trim() : null;
  const buildsOn = pathList(BUILDS_ON.exec(head)?.[1]);
  const planned = pathList(PLANNED.exec(head)?.[1]);
  const model = MODEL.exec(head)?.[1] ?? null;
  const own = head
    .split("\n")
    .filter((l) => !BUILDS_ON.test(l) && !PLANNED.test(l) && !MODEL.test(l))
    .join("\n")
    .trim();
  return { why: own, buildsOn, planned, model, spec: spec || null, source: m?.[1] ?? null };
}

/** Is this a test file (by directory or name)? */
export function isTestFile(path: Path): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** Write order within one change: sources and configuration before tests, so a test sees the code it tests. */
export function writeOrder<T extends { path: Path }>(files: T[]): T[] {
  return files.map((f, i) => ({ f, i, t: isTestFile(f.path) ? 1 : 0 })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.f);
}

const SCRIPT = /\.(?:[cm]?[jt]s)$/i;
const JSX = /\.[jt]sx$/i;
const TS = /\.(?:[cm]?ts|tsx)$/i;
const JSONC = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*)\.json$|\.jsonc$|(^|\/)\.vscode\/[^/]+\.json$/i;
const JSON_FILE = /\.json$/i;
/** Placeholder lines models write instead of code. */
const ELISION = /^\s*(?:\/\/|#|\/\*|<!--|--|;)?\s*(?:\.\.\.|…)\s*(?:rest|remaining|existing|unchanged|other|more|implementation|code)\b/i;

/** Remove // and /* *\/ comments outside strings, and trailing commas, so JSONC parses as JSON. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
/** Words after which a "/" starts a regular expression, not a division. */
const REGEX_AFTER = new Set(["return", "typeof", "case", "do", "else", "in", "instanceof", "new", "void", "delete", "throw", "yield", "await", "of"]);

/**
 * Lexical sanity of a script: strings, template literals (with nested substitutions),
 * comments and regular expressions end; brackets balance and match. Not a parser: it
 * catches the truncated or garbled files a model can return, not type errors.
 */
export function scriptProblems(src: string): string[] {
  const problems: string[] = [];
  const stack: Array<{ ch: string; line: number }> = [];
  let line = 1;
  let i = 0;
  let prev = ""; // last significant token: "id:<word>", "num", "str", or a punctuator
  const n = src.length;
  const add = (p: string): void => {
    if (problems.length < 6) problems.push(p);
  };

  // Scan template text from i (just after "`" or a substitution's "}") to the closing "`" or the next "${".
  const template = (startLine: number): boolean => {
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") line++;
      if (c === "`") {
        i++;
        prev = "str";
        return true;
      }
      if (c === "$" && src[i + 1] === "{") {
        stack.push({ ch: "${", line });
        i += 2;
        prev = "(";
        return true;
      }
      i++;
    }
    add(`a template literal opened on line ${startLine} never ends`);
    return false;
  };

  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) {
        add(`a block comment opened on line ${line} never ends`);
        break;
      }
      for (let j = i; j < end; j++) if (src[j] === "\n") line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = line;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = src[j]!;
        if (d === "\\") {
          if (src[j + 1] === "\n") line++;
          j += 2;
          continue;
        }
        if (d === c) {
          closed = true;
          break;
        }
        if (d === "\n") break;
        j++;
      }
      if (!closed) add(`a string opened on line ${start} is not closed on that line`);
      i = j + 1;
      prev = "str";
      continue;
    }
    if (c === "`") {
      i++;
      if (!template(line)) break;
      continue;
    }
    if (c === "/") {
      const regex = prev === "" || (prev.startsWith("id:") ? REGEX_AFTER.has(prev.slice(3)) : prev !== "num" && prev !== "str" && prev !== ")" && prev !== "]" && prev !== "}");
      if (regex) {
        let j = i + 1;
        let inClass = false;
        let end = -1;
        while (j < n && src[j] !== "\n") {
          const d = src[j]!;
          if (d === "\\") j++;
          else if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) {
            end = j;
            break;
          }
          j++;
        }
        // A "/" that does not close on its line was a division after all.
        if (end !== -1) {
          i = end + 1;
          while (i < n && /[A-Za-z]/.test(src[i]!)) i++;
          prev = "str";
          continue;
        }
      }
      i++;
      prev = "/";
      continue;
    }
    if (OPEN[c]) {
      stack.push({ ch: c, line });
      i++;
      prev = c;
      continue;
    }
    if (CLOSE[c]) {
      const top = stack[stack.length - 1];
      if (c === "}" && top?.ch === "${") {
        stack.pop();
        i++;
        if (!template(top.line)) break;
        continue;
      }
      if (!top) add(`line ${line}: "${c}" closes nothing`);
      else if (top.ch !== CLOSE[c]) {
        add(`line ${line}: "${c}" closes the "${top.ch}" opened on line ${top.line}`);
        stack.pop();
      } else stack.pop();
      i++;
      prev = c;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j]!)) j++;
      prev = `id:${src.slice(i, j)}`;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j]!)) j++;
      prev = "num";
      i = j;
      continue;
    }
    prev = c;
    i++;
  }
  for (const open of stack.reverse()) add(open.ch === "${" ? `a template substitution opened on line ${open.line} never closes` : `the "${open.ch}" opened on line ${open.line} is never closed`);
  return problems;
}

/** Leftovers of the reply format inside a file: tags, fences, placeholders. */
function wrapperProblems(path: Path, content: string, isNew: boolean): string[] {
  const out: string[] = [];
  const lines = content.split(/\r\n|\r|\n/);
  if (/<\/?file>/.test(content)) out.push("the file still contains a <file> or </file> tag; return only the file's content between the tags");
  const markdown = /\.(md|mdx|markdown|txt)$/i.test(path);
  if (!markdown) {
    const fence = lines.findIndex((l) => /^\s*(`{3,}|~{3,})/.test(l));
    if (fence !== -1) out.push(`line ${fence + 1} is a markdown fence; return the file itself, not a fenced block`);
  }
  if (isNew) {
    const elided = lines.findIndex((l) => ELISION.test(l));
    if (elided !== -1) out.push(`line ${elided + 1} is a placeholder ("${oneLine(lines[elided]!).slice(0, 60)}"); write every line of the file`);
  }
  return out;
}

/** Does the file parse? Scripts get the lexical check, JSON files a parser (JSONC for tsconfig-style files). */
export function syntaxProblems(path: Path, content: string, isNew = true): string[] {
  const out = wrapperProblems(path, content, isNew);
  if (content.trim() === "" && (SCRIPT.test(path) || JSX.test(path) || JSON_FILE.test(path) || /\.jsonc$/i.test(path))) {
    return [...out, "the file is empty"];
  }
  if (SCRIPT.test(path) && !JSX.test(path)) out.push(...scriptProblems(content));
  else if (JSONC.test(path)) {
    try {
      JSON.parse(stripJsonc(content));
    } catch (e) {
      out.push(`it is not valid JSON (comments allowed): ${(e as Error).message}`);
    }
  } else if (JSON_FILE.test(path)) {
    try {
      JSON.parse(content);
    } catch (e) {
      out.push(`it is not valid JSON: ${(e as Error).message}`);
    }
  }
  return out;
}

/** The parameter list of each `constructor(...)` in a source, balanced. */
function constructorParams(src: string): string[] {
  const out: string[] = [];
  const re = /\bconstructor\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    const start = j;
    while (j < src.length && depth > 0) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") depth--;
      j++;
    }
    out.push(src.slice(start, j - 1));
  }
  return out;
}

/** Split a parameter list at top-level commas. */
function topLevelParts(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let last = "";
  for (const ch of list) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}".includes(ch) || (ch === ">" && last !== "=")) depth = Math.max(0, depth - 1);
    last = ch;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * TypeScript that type stripping cannot run (Node runs .ts files by erasing types):
 * enums, namespaces with a body, constructor parameter properties, `import x = require()`
 * and `export =`. Ambient (`declare`) forms are fine.
 */
export function erasableProblems(path: Path, content: string): string[] {
  if (!TS.test(path) || /\.d\.[cm]?ts$/i.test(path)) return [];
  const out: string[] = [];
  const lineOf = (index: number): number => content.slice(0, index).split("\n").length;
  const enumAt = /^[ \t]*(?:export[ \t]+)?(?:const[ \t]+)?enum[ \t]+[A-Za-z_$]/m.exec(content);
  if (enumAt) out.push(`line ${lineOf(enumAt.index)} declares an enum; use a union of string literals or a const object`);
  const nsAt = /^[ \t]*(?:export[ \t]+)?(?:namespace|module)[ \t]+[A-Za-z_$][\w$.]*[ \t]*\{/m.exec(content);
  if (nsAt) out.push(`line ${lineOf(nsAt.index)} declares a namespace; use plain module exports`);
  for (const params of constructorParams(content)) {
    const prop = topLevelParts(params).find((p) => /^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:public|private|protected|readonly|override)\s+[A-Za-z_$]/.test(p));
    if (prop) out.push(`the constructor parameter "${oneLine(prop).slice(0, 60)}" is a parameter property; declare the field and assign it in the constructor body`);
  }
  const req = /^[ \t]*(?:export[ \t]+)?import[ \t]+[A-Za-z_$][\w$]*[ \t]*=[ \t]*require[ \t]*\(/m.exec(content);
  if (req) out.push(`line ${lineOf(req.index)} uses import = require(); use an ES import`);
  const eq = /^[ \t]*export[ \t]*=[ \t]*[^=]/m.exec(content);
  if (eq) out.push(`line ${lineOf(eq.index)} uses export =; use an ES export`);
  return out;
}

/** Extensions a TypeScript-style resolver tries, in order. */
const RESOLVE_EXTS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const TS_TWINS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

/** The file a relative import resolves to, TypeScript-style (the path, the path plus an extension, a .js name's .ts twin, the index file), or null. */
export function resolveImport(fromFile: Path, specifier: string, exists: (p: Path) => boolean): Path | null {
  const target = resolveRelative(fromFile, specifier);
  if (target === null) return null;
  const candidates: Path[] = [];
  if (target !== "") {
    candidates.push(target, ...RESOLVE_EXTS.map((e) => target + e));
    for (const [js, twins] of Object.entries(TS_TWINS)) if (target.endsWith(js)) candidates.push(...twins.map((t) => target.slice(0, -js.length) + t));
  }
  const base = target === "" ? "index" : `${target}/index`;
  candidates.push(...RESOLVE_EXTS.map((e) => base + e));
  return candidates.find(exists) ?? null;
}

/**
 * Relative imports that name no file in `exists` (trunk at the base plus the files of this
 * change). Imports of files that are planned but have not landed are reported too: the
 * colony checks every new import against trunk, so the agent builds only on what is there.
 */
export function importProblems(path: Path, content: string, exists: (p: Path) => boolean, planned: ReadonlySet<Path> = new Set()): string[] {
  if (!SCRIPT.test(path) && !JSX.test(path)) return [];
  const out: string[] = [];
  for (const imp of importsOf(content)) {
    const s = imp.specifier;
    if (!(s === "." || s === ".." || s.startsWith("./") || s.startsWith("../"))) continue;
    if (resolveImport(path, s, exists) !== null) continue;
    const target = resolveRelative(path, s);
    const later = target !== null && resolveImport(path, s, (p) => planned.has(p)) !== null;
    out.push(
      later
        ? `line ${imp.line}: "${s}" names a planned file that is not in trunk yet; import only files listed in the project tree or written by this change`
        : `line ${imp.line}: "${s}" names no file in the project tree or in this change`,
    );
  }
  return out;
}

/** What a module exports, read from its source (TypeScript or JavaScript). */
export interface ModuleExports {
  values: Set<string>;
  types: Set<string>;
  /** Names re-exported from elsewhere (kind unknown). */
  other: Set<string>;
  default: boolean;
  /** True when `export * from` makes the list incomplete. */
  open: boolean;
}

/** The names a module exports, by kind (a light reader of export declarations). */
export function moduleExports(src: string): ModuleExports {
  const out: ModuleExports = { values: new Set(), types: new Set(), other: new Set(), default: false, open: false };
  const text = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const decl = /^[ \t]*export[ \t]+(default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(async[ \t]+)?(function\*?|class|const|let|var|enum|interface|type|namespace)[ \t]+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(text)) !== null) {
    const kind = m[3]!;
    const name = m[4]!;
    if (m[1]) out.default = true;
    if (kind === "enum" && /const[ \t]+enum/.test(m[0])) continue;
    if (kind === "interface" || kind === "type") out.types.add(name);
    else out.values.add(name);
  }
  if (/^[ \t]*export[ \t]+default\b/m.test(text)) out.default = true;
  if (/^[ \t]*export[ \t]*\*[ \t]*from\b/m.test(text)) out.open = true;
  const list = /^[ \t]*export[ \t]+(type[ \t]+)?\{([^}]*)\}([ \t]*from[ \t]*["'][^"']+["'])?/gm;
  while ((m = list.exec(text)) !== null) {
    const typeOnly = Boolean(m[1]);
    for (const part of m[2]!.split(",").map((p) => p.trim()).filter(Boolean)) {
      const t = /^(type[ \t]+)?([\w$]+)(?:[ \t]+as[ \t]+([\w$]+))?$/.exec(part);
      if (!t) continue;
      const name = t[3] ?? t[2]!;
      if (name === "default") out.default = true;
      else if (typeOnly || t[1]) out.types.add(name);
      else if (m[3]) out.other.add(name);
      else out.values.add(name);
    }
  }
  return out;
}

/** One import declaration: the bindings it takes from a module. */
interface ImportDecl {
  line: number;
  specifier: string;
  typeOnly: boolean;
  defaultName: string | null;
  named: Array<{ name: string; type: boolean }>;
}

/** Import declarations with a `from` clause (side-effect and dynamic imports carry no bindings). */
function importDecls(src: string): ImportDecl[] {
  const out: ImportDecl[] = [];
  const re = /^[ \t]*import[ \t]+(type[ \t]+)?([^;'"]*?)[ \t]*from[ \t]*["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[2]!.trim();
    const decl: ImportDecl = { line: src.slice(0, m.index).split("\n").length, specifier: m[3]!, typeOnly: Boolean(m[1]), defaultName: null, named: [] };
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def && def[1] !== "type") decl.defaultName = def[1]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1]!.split(",").map((p) => p.trim()).filter(Boolean)) {
        const t = /^(type\s+)?([\w$]+)(?:\s+as\s+[\w$]+)?$/.exec(part);
        if (t) decl.named.push({ name: t[2]!, type: Boolean(t[1]) });
      }
    }
    out.push(decl);
  }
  return out;
}

/**
 * Imports that would fail when Node loads the file by stripping its types: a type-only export
 * imported as a value (the import survives stripping and the module has no such export), a
 * name the module does not export, or a default import of a module without a default export.
 * `source` returns the text of a module the import resolves to (trunk or this change), or null.
 */
export function bindingProblems(path: Path, content: string, exists: (p: Path) => boolean, source: (p: Path) => string | null): string[] {
  if (!SCRIPT.test(path) && !JSX.test(path)) return [];
  const out: string[] = [];
  for (const d of importDecls(content)) {
    if (d.typeOnly || !(d.specifier.startsWith("./") || d.specifier.startsWith("../"))) continue;
    const target = resolveImport(path, d.specifier, exists);
    const text = target === null ? null : source(target);
    if (target === null || text === null) continue;
    const ex = moduleExports(text);
    for (const n of d.named) {
      if (n.type || ex.values.has(n.name) || ex.other.has(n.name)) continue;
      if (ex.types.has(n.name)) {
        out.push(`line ${d.line} imports the type "${n.name}" from "${d.specifier}" as a value; Node strips types, so this import fails when the file loads. Write import type { ${n.name} } (or { type ${n.name} })`);
      } else if (!ex.open) {
        out.push(`line ${d.line} imports "${n.name}" from "${d.specifier}", which ${target} does not export`);
      }
    }
    if (d.defaultName && !ex.default && !ex.open) out.push(`line ${d.line} imports a default export from "${d.specifier}", but ${target} has none`);
  }
  return out;
}

/**
 * Colony rules the file breaks. A new file must break none; an existing file must not
 * break any rule more often than before. Each problem carries the rule's hint.
 */
export function ruleProblems(rules: readonly Rule[], path: Path, before: string | null, after: string): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    let now: number[];
    let was = 0;
    try {
      now = checkFile(rule, path, after).map((v) => v.line);
      if (before !== null) was = checkFile(rule, path, before).length;
    } catch {
      continue; // an invalid rule never blocks a file
    }
    if (now.length === 0 || (before !== null && now.length <= was)) continue;
    const hint = typeof rule.spec?.hint === "string" ? ` ${oneLine(rule.spec.hint)}` : "";
    const lines = [...new Set(now)].slice(0, 8).join(", ");
    out.push(`${now.length === 1 ? "line" : "lines"} ${lines} ${now.length === 1 ? "breaks" : "break"} the rule "${oneLine(rule.description)}".${hint}`);
  }
  return out;
}

/** Does the project ask for TypeScript that type stripping can run? */
export function wantsErasable(intentText: string, tsconfig: string | null): boolean {
  if (/erasable/i.test(intentText)) return true;
  return tsconfig !== null && /"erasableSyntaxOnly"\s*:\s*true/.test(tsconfig);
}

/** Everything one written file is checked against. */
export interface FileCheckInput {
  path: Path;
  /** The file at the base (null when it is new). */
  before: string | null;
  after: string;
  rules: readonly Rule[];
  /** Files in trunk at the base plus the files of this change. */
  exists: (p: Path) => boolean;
  planned?: ReadonlySet<Path>;
  erasable: boolean;
  /** Text of a module a relative import resolves to (for the binding check), or null when unknown. */
  source?: (p: Path) => string | null;
}

/** The result of checking one written file. */
export interface FileCheck {
  problems: string[];
  /** One line for the evidence: what was checked. */
  detail: string;
}

/** Run every check on a written file (see the module comment). */
export function checkWrittenFile(x: FileCheckInput): FileCheck {
  const syntax = syntaxProblems(x.path, x.after, x.before === null);
  const rules = ruleProblems(x.rules, x.path, x.before, x.after);
  const erasable = x.erasable ? erasableProblems(x.path, x.after) : [];
  const imports = importProblems(x.path, x.after, x.exists, x.planned);
  const bindings = x.source ? bindingProblems(x.path, x.after, x.exists, x.source) : [];
  const relative = SCRIPT.test(x.path) || JSX.test(x.path) ? importsOf(x.after).filter((i) => i.specifier.startsWith(".")).length : 0;
  const parts = [
    syntax.length === 0 ? "syntax ok" : `${syntax.length} syntax problem(s)`,
    `${x.rules.length} rule(s), ${rules.length === 0 ? "0 violations" : `${rules.length} broken`}`,
  ];
  if (x.erasable && TS.test(x.path)) parts.push(erasable.length === 0 ? "erasable TypeScript" : "non-erasable TypeScript");
  if (relative > 0) parts.push(imports.length === 0 ? `${relative} relative import(s) resolve` : `${imports.length} unresolved import(s)`);
  if (relative > 0 && x.source) parts.push(bindings.length === 0 ? "imported names match the modules' exports" : `${bindings.length} import binding problem(s)`);
  return { problems: [...syntax, ...rules, ...erasable, ...imports, ...bindings], detail: parts.join(", ") };
}
