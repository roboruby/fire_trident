/**
 * The `vitest` module trunk certification gives test files written for vitest (their `vitest` imports are rewritten to
 * it, and a file that uses vitest's globals imports VITEST_GLOBALS first). Like the node:test shim (shim.ts) it is plain
 * JavaScript kept as a string, because it runs inside the Dynamic Worker; it is a layer over that shim: tests and hooks
 * register in the node:test shim of the same file, so a file is one tree and the harness runs it unchanged.
 *
 * Supported, with vitest's semantics and counting: describe / suite / it / test with skip, only (within the file), todo,
 * fails, skipIf, runIf, each (arrays, objects and template tables, with vitest's title formatting) and for; concurrent
 * and sequential run one at a time; tests of a skipped suite count as skipped; options and timeouts as the second or
 * third argument (5 s per test and 10 s per hook unless set, within the certification's own limit); retry and repeats;
 * beforeAll / afterAll / beforeEach / afterEach (cleanup functions returned from before hooks included), onTestFinished,
 * onTestFailed and the test context (task, skip, signal). expect with the common matchers, .not, .resolves, .rejects,
 * soft, assertions / hasAssertions, extend, addEqualityTesters, the asymmetric matchers and inline snapshots of a single
 * line (strings, numbers, errors). expectTypeOf and assertType do nothing at run time, as in vitest. vi: fn, spyOn and
 * the mock API and matchers, clearAllMocks / resetAllMocks / restoreAllMocks, stubGlobal / stubEnv and their undo, fake
 * timers (setTimeout, setInterval, setImmediate and Date) with advance / run / setSystemTime, waitFor, waitUntil, hoisted.
 *
 * Not supported: module mocking (vi.mock and its relatives, vi.importActual, vi.resetModules), snapshots kept in files
 * and multi-line inline snapshots, test fixtures (test.extend), expect.poll, chai-style assertions, benchmarks, and any
 * matcher this file does not define (a setup file's or a plugin's). A test that uses one is counted as unsupported, apart
 * from failures, with the API's name ("not supported by trunk certification: toMatchSnapshot"); it never passes silently.
 * The vitest configuration file is not read: setup files and environments other than Node's are not applied.
 *
 * Each test file's spies, stubbed globals and environment variables, fake timers and globals are undone when the file
 * ends (vitest runs each file in its own context; here files share the Worker's global object).
 */
export const VITEST_SHIM = String.raw`// vitest for trunk certification (FireTrident): a layer over this file's node:test shim.
import { __ftLayer as L } from "./node-test.js";
import { inspect } from "node:util";

const UNSUPPORTED = "not supported by trunk certification: ";
const REAL = {
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate, clearImmediate: globalThis.clearImmediate,
  Date: globalThis.Date,
};
const realNow = () => REAL.Date.now();
const realSleep = (ms) => new Promise((resolve) => REAL.setTimeout.call(globalThis, resolve, ms));
L.timers({ setTimeout: (f, ms) => REAL.setTimeout.call(globalThis, f, ms), clearTimeout: (t) => REAL.clearTimeout.call(globalThis, t), now: realNow });

const config = { testTimeout: 5000, hookTimeout: 10000 };

class Unsupported extends Error {}
function unsupported(api) {
  L.unsupported(api);
  throw new Unsupported(UNSUPPORTED + api);
}

// What the test Worker's runtime refuses that Node, where vitest runs tests, allows: a test that fails on one of these
// counts as unsupported (the runtime's limit, not the code's fault). Only these exact refusals, never a test's own errors.
const RUNTIME_GAPS = [
  [/^Code generation from strings disallowed/, "code generation from strings (eval, new Function) in the test Worker"],
  [/^Subrequest integrity checking is not implemented/, "the Request integrity option in the test Worker"],
  [/^Unsupported cache mode/, "the Request cache option in the test Worker"],
  [/^Disallowed operation called within global scope/, "I/O, timers or random values while modules load, in the test Worker"],
];
function runtimeGap(e) {
  const message = e !== null && typeof e === "object" && typeof e.message === "string" ? e.message : "";
  for (const [re, api] of RUNTIME_GAPS) if (re.test(message)) return api;
  return null;
}
function noteGap(e) {
  const api = runtimeGap(e);
  if (api !== null) L.unsupported(api);
}

// vitest runs tests in Node: code that picks its runtime by navigator.userAgent sees Node's ("Node.js/22"), as there.
const NODE_AGENT = "Node.js/" + String((globalThis.process && globalThis.process.version) || "v22").replace(/^v/, "").split(".")[0];
let savedAgent = null;
function nodeIdentity() {
  const nav = globalThis.navigator;
  if (!nav || typeof nav !== "object" || savedAgent !== null) return;
  try {
    savedAgent = { own: Object.getOwnPropertyDescriptor(nav, "userAgent") };
    Object.defineProperty(nav, "userAgent", { value: NODE_AGENT, configurable: true, enumerable: true, writable: true });
  } catch (e) { savedAgent = null; }
}
function workerIdentity() {
  const nav = globalThis.navigator;
  if (savedAgent === null || !nav) return;
  try {
    if (savedAgent.own) Object.defineProperty(nav, "userAgent", savedAgent.own);
    else delete nav.userAgent;
  } catch (e) { /* left as Node's */ }
  savedAgent = null;
}

class AssertionError extends Error {
  constructor(message, info) {
    super(message);
    this.name = "AssertionError";
    if (info && "actual" in info) { this.actual = info.actual; this.expected = info.expected; }
  }
}

function brief(x) {
  if (typeof x === "function" && x._isMockFunction === true && typeof x.getMockName === "function") return '"' + x.getMockName() + '"';
  let s;
  try { s = inspect(x, { depth: 3, breakLength: Infinity, maxArrayLength: 12, maxStringLength: 120 }); } catch (e) { s = String(x); }
  return s.length > 160 ? s.slice(0, 157) + "..." : s;
}

// ---- per-file and per-test state ----

let file = null;
let globalsOn = false;
function resetFile() {
  file = { mocks: new Set(), spies: [], globals: new Map(), envs: new Map(), custom: Object.create(null), testers: [], savedGlobals: null };
}
resetFile();

const states = new WeakMap();
function stateOf(node) {
  let s = states.get(node);
  if (!s) {
    s = { assertions: 0, expected: null, has: false, soft: [], pending: [], finished: [], failed: [], ctx: null };
    states.set(node, s);
  }
  return s;
}

// ---- registration ----

function parseArgs(args) {
  let name = args[0];
  let fn = args[1];
  let options = args[2];
  if (fn !== null && typeof fn === "object") { const o = fn; fn = options; options = o; }
  if (typeof options === "number") options = { timeout: options };
  if (options === null || typeof options !== "object") options = {};
  if (typeof name === "function") name = name.name || "<anonymous>";
  return { name: name === undefined || name === null ? "" : String(name), fn: typeof fn === "function" ? fn : undefined, options };
}

function timeoutOf(o, fallback) {
  return typeof o.timeout === "number" && o.timeout > 0 ? o.timeout : fallback;
}

function addTest(mods, args) {
  const a = parseArgs(args);
  const o = Object.assign({}, a.options, mods);
  const todo = !!o.todo || !a.fn;
  const extra = { timeout: timeoutOf(o, config.testTimeout) };
  if (o.skip || todo) extra.skip = true;
  if (o.only) extra.only = true;
  L.register("test", [a.name, todo ? undefined : runner(a.fn, o)], extra, { todo });
}

function addSuite(mods, args) {
  const a = parseArgs(args);
  const o = Object.assign({}, a.options, mods);
  const todo = !!o.todo || !a.fn;
  const extra = {};
  if (o.skip || todo) extra.skip = true;
  if (o.only) extra.only = true;
  if (typeof o.timeout === "number" && o.timeout > 0) extra.timeout = o.timeout;
  const body = a.fn;
  L.register("suite", [a.name, body ? function () { return body(); } : undefined], extra, { collect: true, todo });
}

const SKIPPED = { skipped: true };

// The function the node:test shim runs for one vitest test: the test with its context, then what vitest checks after it.
function runner(fn, o) {
  return async function (t) {
    const node = L.current();
    const st = stateOf(node);
    const ctx = contextOf(node, t);
    const tries = 1 + (Number(o.retry) > 0 ? Math.floor(Number(o.retry)) : 0);
    const repeats = 1 + (Number(o.repeats) > 0 ? Math.floor(Number(o.repeats)) : 0);
    let failure = null;
    for (let r = 0; r < repeats && failure === null; r++) {
      for (let i = 0; i < tries; i++) {
        failure = await attempt(fn, ctx, st);
        if (failure === null || failure === SKIPPED) break;
      }
    }
    if (failure === SKIPPED) failure = null;
    if (o.fails) failure = failure === null ? { e: new AssertionError("expect test to fail (test.fails), but it passed") } : null;
    if (failure !== null) for (const f of st.failed) { try { await f(ctx); } catch (e) { /* the test failed already */ } }
    for (const f of st.finished) {
      try { await f(ctx); } catch (e) { if (failure === null) failure = { e }; }
    }
    if (failure !== null) throw failure.e;
  };
}

async function attempt(fn, ctx, st) {
  st.assertions = 0;
  st.expected = null;
  st.has = false;
  st.soft = [];
  st.pending = [];
  try {
    await fn(ctx);
    if (st.pending.length > 0) await Promise.all(st.pending);
    if (st.expected !== null && st.assertions !== st.expected) throw new AssertionError("expected number of assertions to be " + st.expected + ", but got " + st.assertions);
    if (st.has && st.assertions === 0) throw new AssertionError("expected any number of assertion, but got none");
    if (st.soft.length > 0) throw st.soft[0];
    return null;
  } catch (e) {
    if (st.pending.length > 0) await Promise.allSettled(st.pending);
    if (e === SKIPPED) return SKIPPED;
    noteGap(e);
    return { e };
  }
}

// vitest's task objects: a suite knows its parent suite; a suite or test at the top of the file has none.
const suiteTasks = new WeakMap();
function suiteTask(node) {
  if (!node || !node.parent || node.kind !== "suite") return undefined;
  let s = suiteTasks.get(node);
  if (!s) {
    s = { name: node.name, type: "suite", mode: node.opts && node.opts.skip ? "skip" : "run", meta: {}, suite: suiteTask(node.parent), file: { name: L.file(), filepath: L.file() }, tasks: [] };
    suiteTasks.set(node, s);
  }
  return s;
}

function contextOf(node, t) {
  const st = stateOf(node);
  if (st.ctx) return st.ctx;
  const name = node && typeof node.name === "string" ? node.name : "";
  const ctx = {
    task: { name, type: "test", mode: "run", meta: {}, suite: suiteTask(node && node.parent), file: { name: L.file(), filepath: L.file() } },
    signal: t && t.signal ? t.signal : new AbortController().signal,
    expect,
    skip(cond, note) {
      if (typeof cond === "boolean") { if (!cond) return; } else note = cond;
      if (t && typeof t.skip === "function") t.skip(note);
      throw SKIPPED;
    },
    onTestFinished(f) { if (typeof f === "function") st.finished.push(f); },
    onTestFailed(f) { if (typeof f === "function") st.failed.push(f); },
    annotate() { return Promise.resolve(); },
  };
  ctx.task.context = ctx;
  st.ctx = ctx;
  return ctx;
}

// ---- each ----

function tableOf(cases, values) {
  if (Array.isArray(cases) && values.length > 0) {
    const header = cases.join("").trim().replace(/ /g, "").split("\n").map((r) => r.split("|"))[0];
    const rows = [];
    for (let i = 0; i < Math.floor(values.length / header.length); i++) {
      const row = {};
      for (let j = 0; j < header.length; j++) row[header[j]] = values[i * header.length + j];
      rows.push(row);
    }
    return rows;
  }
  return Array.from(cases || []);
}

const FORMAT = /%[sdjifoOc%]/g;
function format(template, args) {
  let i = 0;
  let out = String(template).replace(FORMAT, (x) => {
    if (x === "%%") return "%";
    if (i >= args.length) return x;
    const v = args[i++];
    switch (x) {
      case "%s":
        if (typeof v === "bigint") return v.toString() + "n";
        if (typeof v === "number" && v === 0 && 1 / v < 0) return "-0";
        if (typeof v === "object" && v !== null) return typeof v.toString === "function" && v.toString !== Object.prototype.toString ? v.toString() : inspect(v, { depth: 0 });
        return String(v);
      case "%d": return typeof v === "bigint" ? v.toString() + "n" : Number(v).toString();
      case "%i": return typeof v === "bigint" ? v.toString() + "n" : Number.parseInt(String(v)).toString();
      case "%f": return Number.parseFloat(String(v)).toString();
      case "%o": return inspect(v, { showHidden: true, showProxy: true });
      case "%O": return inspect(v);
      case "%c": return "";
      case "%j": try { return JSON.stringify(v); } catch (e) { return "[Circular]"; }
      default: return x;
    }
  });
  for (; i < args.length; i++) out += " " + (args[i] === null || typeof args[i] !== "object" ? String(args[i]) : inspect(args[i]));
  return out;
}

function attr(source, path, fallback) {
  let r = source;
  for (const p of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    r = new Object(r)[p];
    if (r === undefined) return fallback;
  }
  return r;
}

function formatTitle(template, items, idx) {
  if (template.includes("%#") || template.includes("%$")) {
    template = template.replace(/%%/g, "__ft_escaped__").replace(/%#/g, String(idx)).replace(/%\$/g, String(idx + 1)).replace(/__ft_escaped__/g, "%%");
  }
  const count = template.split("%").length - 1;
  let out = format(template, items.slice(0, count));
  const objectItem = items[0] !== null && typeof items[0] === "object" && !Array.isArray(items[0]);
  out = out.replace(/\$([$\w.]+)/g, (all, key) => {
    const arrayKey = /^\d+$/.test(key);
    if (!objectItem && !arrayKey) return "$" + key;
    const element = arrayKey ? attr(items, key) : undefined;
    const value = objectItem ? attr(items[0], key, element) : element;
    return inspect(value, { depth: 1, breakLength: Infinity });
  });
  return out;
}

function eachOf(kind, mods, cases, values) {
  const rows = tableOf(cases, values);
  return (name, b, c) => {
    const a = parseArgs([name, b, c]);
    const arrayOnly = rows.every(Array.isArray);
    rows.forEach((row, idx) => {
      const items = Array.isArray(row) ? row : [row];
      const title = typeof name === "string" ? formatTitle(name, items, idx) : a.name;
      const f = a.fn;
      const handler = f ? (arrayOnly ? () => f(...items) : () => f(row)) : undefined;
      (kind === "suite" ? addSuite : addTest)(mods, [title, handler, a.options]);
    });
  };
}

function forOf(kind, mods, cases, values) {
  const rows = tableOf(cases, values);
  return (name, b, c) => {
    const a = parseArgs([name, b, c]);
    rows.forEach((row, idx) => {
      const title = typeof name === "string" ? formatTitle(name, Array.isArray(row) ? row : [row], idx) : a.name;
      const f = a.fn;
      const handler = f ? (ctx) => f(row, ctx) : undefined;
      (kind === "suite" ? addSuite : addTest)(mods, [title, handler, a.options]);
    });
  };
}

const MODIFIERS = ["skip", "only", "todo", "concurrent", "sequential", "fails", "shuffle"];
function chain(kind, mods) {
  const f = function (...args) { (kind === "suite" ? addSuite : addTest)(mods, args); };
  for (const m of MODIFIERS) Object.defineProperty(f, m, { get: () => chain(kind, Object.assign({}, mods, { [m]: true })), configurable: true });
  f.each = (cases, ...values) => eachOf(kind, mods, cases, values);
  f.for = (cases, ...values) => forOf(kind, mods, cases, values);
  f.skipIf = (cond) => chain(kind, cond ? Object.assign({}, mods, { skip: true }) : mods);
  f.runIf = (cond) => chain(kind, cond ? mods : Object.assign({}, mods, { skip: true }));
  f.extend = () => unsupported(kind === "suite" ? "describe.extend" : "test.extend (test fixtures)");
  f.scoped = () => unsupported("test.scoped (test fixtures)");
  return f;
}

export const test = chain("test", {});
export const it = test;
export const describe = chain("suite", {});
export const suite = describe;
export function bench() { unsupported("bench (benchmarks)"); }
bench.skip = bench;
bench.only = bench;
bench.todo = bench;

// ---- hooks ----

async function gapped(f) {
  try { return await f(); } catch (e) { noteGap(e); throw e; }
}
function hookOpts(timeout) {
  return { timeout: typeof timeout === "number" && timeout > 0 ? timeout : config.hookTimeout };
}
function suiteArg() {
  const n = L.current();
  const s = n && n.kind === "test" ? n.parent : n;
  return suiteTask(s) || { name: "", type: "suite", meta: {}, tasks: [] };
}

export function beforeAll(fn, timeout) {
  if (typeof fn !== "function") return;
  const cleanups = [];
  const opts = hookOpts(timeout);
  L.hook("before", async function () { const r = await gapped(() => fn(suiteArg())); if (typeof r === "function") cleanups.push(r); }, opts);
  L.hook("after", async function () { while (cleanups.length > 0) await cleanups.pop()(); }, opts, true);
}
export function afterAll(fn, timeout) {
  if (typeof fn !== "function") return;
  L.hook("after", async function () { await gapped(() => fn(suiteArg())); }, hookOpts(timeout), true);
}
export function beforeEach(fn, timeout) {
  if (typeof fn !== "function") return;
  const cleanups = new WeakMap();
  const opts = hookOpts(timeout);
  L.hook("beforeEach", async function (t) {
    const n = L.current();
    const r = await gapped(() => fn(contextOf(n, t), suiteArg()));
    if (typeof r === "function") cleanups.set(n, r);
  }, opts);
  L.hook("afterEach", async function () {
    const n = L.current();
    const c = cleanups.get(n);
    if (c) { cleanups.delete(n); await c(); }
  }, opts, true);
}
export function afterEach(fn, timeout) {
  if (typeof fn !== "function") return;
  L.hook("afterEach", async function (t) { await gapped(() => fn(contextOf(L.current(), t), suiteArg())); }, hookOpts(timeout), true);
}
export function onTestFinished(fn) { if (typeof fn === "function") stateOf(L.current()).finished.push(fn); }
export function onTestFailed(fn) { if (typeof fn === "function") stateOf(L.current()).failed.push(fn); }

// ---- equality (as vitest's expect compares) ----

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const hasDefinedKey = (o, k) => hasOwn(o, k) && o[k] !== undefined;
function isAsym(x) { return !!x && typeof x === "object" && typeof x.asymmetricMatch === "function"; }
function isError(v) {
  if (typeof Error.isError === "function") return Error.isError(v);
  const tag = Object.prototype.toString.call(v);
  return tag === "[object Error]" || tag === "[object Exception]" || tag === "[object DOMException]" || v instanceof Error;
}
function asymmetricMatch(a, b) {
  const aa = isAsym(a);
  const bb = isAsym(b);
  if (aa && bb) return undefined;
  if (aa) return a.asymmetricMatch(b);
  if (bb) return b.asymmetricMatch(a);
  return undefined;
}
function keysOf(o, has) {
  const out = [];
  for (const k in o) if (has(o, k)) out.push(k);
  for (const s of Object.getOwnPropertySymbols(o)) if (Object.getOwnPropertyDescriptor(o, s).enumerable) out.push(s);
  return out;
}
const testerThis = { equals: (a, b, t) => equals(a, b, t || []) };
function equals(a, b, testers, strict) {
  return eq(a, b, [], [], testers || [], strict ? hasOwn : hasDefinedKey);
}
function eq(a, b, aStack, bStack, testers, has) {
  const am = asymmetricMatch(a, b);
  if (am !== undefined) return am;
  for (const t of testers) {
    const r = t.call(testerThis, a, b, testers);
    if (r !== undefined) return r;
  }
  if (typeof URL === "function" && a instanceof URL && b instanceof URL) return a.href === b.href;
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return a === b;
  const cls = Object.prototype.toString.call(a);
  if (cls !== Object.prototype.toString.call(b)) return false;
  switch (cls) {
    case "[object Boolean]":
    case "[object String]":
    case "[object Number]":
      if (typeof a !== typeof b) return false;
      if (typeof a !== "object" && typeof b !== "object") return Object.is(a, b);
      return Object.is(a.valueOf(), b.valueOf());
    case "[object Date]": {
      const x = +a;
      const y = +b;
      return x === y || (Number.isNaN(x) && Number.isNaN(y));
    }
    case "[object RegExp]":
      return a.source === b.source && a.flags === b.flags;
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  let length = aStack.length;
  while (length--) {
    if (aStack[length] === a) return bStack[length] === b;
    if (bStack[length] === b) return false;
  }
  aStack.push(a);
  bStack.push(b);
  try {
    if (cls === "[object Array]" && a.length !== b.length) return false;
    if (isError(a) && isError(b)) {
      let r = Object.prototype.toString.call(a) === Object.prototype.toString.call(b) && a.name === b.name && a.message === b.message;
      if (r && typeof b.cause !== "undefined") r = eq(a.cause, b.cause, aStack, bStack, testers, has);
      if (r && typeof AggregateError === "function" && a instanceof AggregateError && b instanceof AggregateError) r = eq(a.errors, b.errors, aStack, bStack, testers, has);
      return r && eq(Object.assign({}, a), Object.assign({}, b), aStack, bStack, testers, has);
    }
    const ak = keysOf(a, has);
    let size = ak.length;
    if (keysOf(b, has).length !== size) return false;
    while (size--) {
      const k = ak[size];
      if (!(has(b, k) && eq(a[k], b[k], aStack, bStack, testers, has))) return false;
    }
    return true;
  } finally {
    aStack.pop();
    bStack.pop();
  }
}
function iterableEquality(a, b, testers, aStack, bStack) {
  testers = testers || [];
  aStack = aStack || [];
  bStack = bStack || [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) || Array.isArray(b) || ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return undefined;
  if (typeof a[Symbol.iterator] !== "function" || typeof b[Symbol.iterator] !== "function") return undefined;
  if (a.constructor !== b.constructor) return false;
  let length = aStack.length;
  while (length--) if (aStack[length] === a) return bStack[length] === b;
  aStack.push(a);
  bStack.push(b);
  const withStack = (x, y) => iterableEquality(x, y, testers.slice(), aStack.slice(), bStack.slice());
  const inner = testers.filter((t) => t !== iterableEquality).concat([withStack]);
  try {
    if (a.size !== undefined) {
      if (a.size !== b.size) return false;
      if (a instanceof Set) {
        for (const v of a) if (!b.has(v) && ![...b].some((w) => equals(v, w, inner))) return false;
        return true;
      }
      if (a instanceof Map) {
        for (const [k, v] of a) {
          if (b.has(k) && equals(v, b.get(k), inner)) continue;
          if (![...b].some(([k2, v2]) => equals(k, k2, inner) && equals(v, v2, inner))) return false;
        }
        return true;
      }
    }
    const it = b[Symbol.iterator]();
    for (const v of a) {
      const n = it.next();
      if (n.done || !equals(v, n.value, inner)) return false;
    }
    if (!it.next().done) return false;
    return equals(Object.entries(a), Object.entries(b), inner);
  } finally {
    aStack.pop();
    bStack.pop();
  }
}
function typeEquality(a, b) {
  if (a == null || b == null || a.constructor === b.constructor) return undefined;
  return false;
}
function sparseArrayEquality(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return undefined;
  return equals(a, b, [iterableEquality, typeEquality], true) && equals(Object.keys(a), Object.keys(b));
}
function arrayBufferEquality(a, b) {
  let x = a;
  let y = b;
  if (a instanceof DataView && b instanceof DataView) { x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  else if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) { x = new Uint8Array(a); y = new Uint8Array(b); }
  else return undefined;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
function hasProperty(o, k) {
  if (!o || (typeof o !== "object" && typeof o !== "function") || o === Object.prototype) return false;
  return hasOwn(o, k) || hasProperty(Object.getPrototypeOf(o), k);
}
function subsetEquality(object, subset, testers) {
  const inner = (testers || []).filter((t) => t !== subsetEquality);
  const withSeen = (seen) => function sub(obj, sbs) {
    if (sbs === null || typeof sbs !== "object" || isError(sbs) || Array.isArray(sbs) || sbs instanceof Date || sbs instanceof Set || sbs instanceof Map) return undefined;
    return Object.keys(sbs).every((k) => {
      const v = sbs[k];
      if (v !== null && typeof v === "object") {
        if (seen.has(v)) return equals(obj[k], v, inner);
        seen.set(v, true);
      }
      const r = obj != null && hasProperty(obj, k) && equals(obj[k], v, inner.concat([withSeen(seen)]));
      seen.delete(v);
      return r;
    });
  };
  return withSeen(new WeakMap())(object, subset);
}

// ---- asymmetric matchers ----

function asym(name, sample, inverse, match) {
  return {
    $$typeof: Symbol.for("jest.asymmetricMatcher"),
    sample,
    inverse,
    asymmetricMatch(other) { const r = match(other); return inverse ? !r : r; },
    toString() { return (inverse ? "Not" : "") + name; },
    toAsymmetricMatcher() { return (inverse ? "Not" : "") + name + " " + brief(sample); },
    [inspect.custom]() { return (inverse ? "Not" : "") + name + (sample === undefined ? "" : " " + brief(sample)); },
  };
}
function anyMatch(C, o) {
  if (C === String) return typeof o === "string" || o instanceof String;
  if (C === Number) return typeof o === "number" || o instanceof Number;
  if (C === Function) return typeof o === "function" || o instanceof Function;
  if (C === Boolean) return typeof o === "boolean" || o instanceof Boolean;
  if (C === BigInt) return typeof o === "bigint";
  if (C === Symbol) return typeof o === "symbol";
  if (C === Object) return typeof o === "object";
  return o instanceof C;
}
const containing = {
  objectContaining: (inverse) => (obj) => asym("ObjectContaining", obj, inverse, (o) => {
    if (typeof obj !== "object" || obj === null) throw new Error("You must provide an object to objectContaining, not '" + typeof obj + "'.");
    const props = Object.keys(obj).concat(Object.getOwnPropertySymbols(obj).filter((s) => Object.getOwnPropertyDescriptor(obj, s).enumerable));
    const has = (x, k) => { for (let p = x; p; p = Object.getPrototypeOf(p)) if (hasOwn(p, k)) return true; return false; };
    for (const k of props) if (!has(o, k) || !equals(obj[k], o[k], file.testers)) return false;
    return true;
  }),
  arrayContaining: (inverse) => (arr) => asym("ArrayContaining", arr, inverse, (o) => {
    if (!Array.isArray(arr)) throw new Error("You must provide an array to arrayContaining, not '" + typeof arr + "'.");
    return arr.length === 0 || (Array.isArray(o) && arr.every((x) => o.some((y) => equals(x, y, file.testers))));
  }),
  stringContaining: (inverse) => (s) => asym("StringContaining", s, inverse, (o) => typeof o === "string" && o.includes(s)),
  stringMatching: (inverse) => (re) => asym("StringMatching", re, inverse, (o) => typeof o === "string" && new RegExp(re).test(o)),
};

// ---- matchers ----

function isMock(f) { return typeof f === "function" && f._isMockFunction === true; }
function sameArgs(a, b) { return a.length === b.length && a.every((x, i) => equals(x, b[i], file.testers.concat([iterableEquality]))); }
function spyOf(received) {
  if (!isMock(received)) throw new TypeError(brief(received) + " is not a spy or a call to a spy!");
  return received.mock;
}
function numbers(a, e) {
  for (const [v, which] of [[a, "actual"], [e, "expected"]]) if (typeof v !== "number" && typeof v !== "bigint") throw new TypeError(which + " value must be number or bigint, received \"" + typeof v + "\"");
}
function says(ctx, actual, verb, expected) {
  return "expected " + brief(actual) + (ctx.isNot ? " not" : "") + " to " + verb + (arguments.length > 3 ? " " + brief(expected) : "");
}
// What the function threw (or the promise rejected with); a runtime refusal marks the test unsupported whatever the matcher expects.
function thrownBy(ctx, received) {
  if (ctx.promise === "rejects") { noteGap(received); return { thrown: true, value: received }; }
  if (typeof received !== "function") throw new TypeError(brief(received) + " is not a function");
  try { received(); } catch (e) { noteGap(e); return { thrown: true, value: e }; }
  return { thrown: false, value: undefined };
}
function messageOf(v) {
  return v !== null && typeof v === "object" && typeof v.message === "string" ? v.message : String(v);
}

function inlineSerialized(v) {
  if (typeof v === "string") return v.includes("\n") ? null : '"' + v + '"';
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "bigint") return v + "n";
  if (typeof v === "boolean" || v === null || v === undefined) return String(v);
  if (v instanceof Error && Object.keys(v).length === 0 && v.cause === undefined && !String(v.message).includes("\n")) return "[" + Error.prototype.toString.call(v) + "]";
  return null;
}
function stripSnapshot(s) {
  const lines = String(s).split("\n");
  if (lines.length <= 2 || lines[0].trim() !== "" || lines[lines.length - 1].trim() !== "") return String(s).trim();
  return lines.slice(1, -1).map((l) => l.trim()).join("\n");
}
function inlineSnapshot(ctx, api, value, snapshot) {
  if (ctx.isNot) throw new Error(api + " cannot be used with \"not\"");
  if (typeof snapshot !== "string") unsupported(api + " without a stored snapshot");
  const got = inlineSerialized(value);
  const want = stripSnapshot(snapshot);
  if (got === null || want.includes("\n")) unsupported(api + " of a value that does not fit on one line");
  return { pass: got === want, message: () => "Snapshot mismatched: expected " + want + ", received " + got };
}

const M = {
  toBe(a, e) {
    const pass = Object.is(a, e);
    return { pass, message: () => says(this, a, "be", e) + " // Object.is equality", actual: a, expected: e };
  },
  toEqual(a, e) { return { pass: equals(a, e, file.testers.concat([iterableEquality])), message: () => says(this, a, "deeply equal", e), actual: a, expected: e }; },
  toStrictEqual(a, e) { return { pass: equals(a, e, file.testers.concat([iterableEquality, typeEquality, sparseArrayEquality, arrayBufferEquality]), true), message: () => says(this, a, "strictly equal", e), actual: a, expected: e }; },
  toBeTruthy(a) { return { pass: !!a, message: () => says(this, a, "be truthy") }; },
  toBeFalsy(a) { return { pass: !a, message: () => says(this, a, "be falsy") }; },
  toBeNull(a) { return { pass: a === null, message: () => says(this, a, "be null") }; },
  toBeUndefined(a) { return { pass: a === undefined, message: () => says(this, a, "be undefined") }; },
  toBeDefined(a) { return { pass: a !== undefined, message: () => says(this, a, "be defined") }; },
  toBeNaN(a) { return { pass: Number.isNaN(a), message: () => says(this, a, "be NaN") }; },
  toBeTypeOf(a, t) { return { pass: typeof a === t, message: () => says(this, a, "be type of", t) }; },
  toBeInstanceOf(a, C) {
    if (typeof C !== "function") throw new TypeError("the expected value of toBeInstanceOf must be a class or function, received " + brief(C));
    return { pass: a instanceof C, message: () => says(this, a, "be an instance of", C) };
  },
  toBeGreaterThan(a, e) { numbers(a, e); return { pass: a > e, message: () => says(this, a, "be greater than", e) }; },
  toBeGreaterThanOrEqual(a, e) { numbers(a, e); return { pass: a >= e, message: () => says(this, a, "be greater than or equal to", e) }; },
  toBeLessThan(a, e) { numbers(a, e); return { pass: a < e, message: () => says(this, a, "be less than", e) }; },
  toBeLessThanOrEqual(a, e) { numbers(a, e); return { pass: a <= e, message: () => says(this, a, "be less than or equal to", e) }; },
  toBeCloseTo(a, e, digits) {
    const d = digits === undefined ? 2 : digits;
    const pass = (e === Infinity && a === Infinity) || (e === -Infinity && a === -Infinity) || Math.abs(e - a) < Math.pow(10, -d) / 2;
    return { pass, message: () => says(this, a, "be close to", e) + " (" + d + " digits)" };
  },
  toBeOneOf(a, list) {
    if (!Array.isArray(list)) throw new TypeError("toBeOneOf expects an array, received " + brief(list));
    return { pass: list.some((v) => equals(a, v, file.testers)), message: () => says(this, a, "be one of", list) };
  },
  toSatisfy(a, fn, m) { return { pass: !!fn(a), message: () => m || says(this, a, "satisfy", fn) }; },
  toContain(a, item) {
    if (typeof a === "string") return { pass: typeof item === "string" ? a.includes(item) : a.includes(String(item)), message: () => says(this, a, "contain", item) };
    return { pass: Array.from(a).includes(item), message: () => says(this, a, "contain", item) };
  },
  toContainEqual(a, item) { return { pass: Array.from(a).some((x) => equals(x, item, file.testers)), message: () => says(this, a, "contain an item equal to", item) }; },
  toHaveLength(a, n) {
    const has = a !== null && a !== undefined && typeof a.length === "number";
    return { pass: has && a.length === n, message: () => says(this, a, "have a length of", n) + (has ? " but got " + a.length : "") };
  },
  toHaveProperty(a, path, ...rest) {
    let found;
    if (!Array.isArray(path) && a !== null && a !== undefined && hasOwn(Object(a), path)) found = { exists: true, value: a[path] };
    else {
      const keys = Array.isArray(path) ? path.map(String) : String(path).replace(/\[([^\]]*)\]/g, ".$1").split(".").filter((k, i) => !(i === 0 && k === ""));
      found = { exists: true, value: a };
      for (const k of keys) {
        const cur = found.value;
        if (cur === null || cur === undefined || !(k in Object(cur))) { found = { exists: false }; break; }
        found = { exists: true, value: cur[k] };
      }
    }
    const pass = found.exists && (rest.length === 0 || equals(rest[0], found.value, file.testers));
    return { pass, message: () => says(this, a, "have property " + brief(path) + (rest.length ? " with value " + brief(rest[0]) : "")) };
  },
  toMatch(a, e) {
    if (typeof a !== "string") throw new TypeError(".toMatch() expects to receive a string, but got " + typeof a);
    return { pass: typeof e === "string" ? a.includes(e) : new RegExp(e).test(a), message: () => says(this, a, "match", e) };
  },
  toMatchObject(a, e) { return { pass: equals(a, e, file.testers.concat([iterableEquality, subsetEquality])), message: () => says(this, a, "match object", e), actual: a, expected: e }; },
  toThrow(received, expected) {
    if (expected === "") expected = /^$/;
    if (this.promise === "resolves" && typeof received !== "function") return { pass: false, message: () => "expected promise to throw an error, but it didn't" };
    const r = thrownBy(this, received);
    const what = expected === undefined ? "throw an error" : "throw an error matching " + brief(expected);
    const message = () => (r.thrown ? "expected the function to " + (this.isNot ? "not " : "") + what + ", it threw " + brief(r.value) : "expected the function to " + what + ", it did not throw");
    if (!r.thrown || expected === undefined) return { pass: r.thrown, message };
    let pass;
    if (typeof expected === "function") pass = r.value instanceof expected;
    else if (typeof expected === "string") pass = messageOf(r.value).includes(expected);
    else if (expected instanceof RegExp) pass = expected.test(messageOf(r.value));
    else if (isError(expected)) pass = equals(r.value, expected, file.testers.concat([iterableEquality]));
    else if (isAsym(expected)) pass = !!r.value && expected.asymmetricMatch(r.value);
    else pass = equals(r.value, expected, file.testers.concat([iterableEquality]));
    return { pass, message };
  },
  toMatchInlineSnapshot(a, ...args) {
    if (args.some((x) => x !== null && typeof x === "object")) unsupported("toMatchInlineSnapshot with property matchers");
    return inlineSnapshot(this, "toMatchInlineSnapshot", a, args.find((x) => typeof x === "string"));
  },
  toThrowErrorMatchingInlineSnapshot(received, snapshot) {
    const r = thrownBy(this, received);
    if (!r.thrown) return { pass: false, message: () => "expected the function to throw, it did not throw" };
    return inlineSnapshot(this, "toThrowErrorMatchingInlineSnapshot", r.value, snapshot);
  },
  toHaveBeenCalled(a) { const m = spyOf(a); return { pass: m.calls.length > 0, message: () => says(this, a, "be called") + ", it was called " + m.calls.length + " times" }; },
  toHaveBeenCalledTimes(a, n) { const m = spyOf(a); return { pass: m.calls.length === n, message: () => says(this, a, "be called " + n + " times") + ", it was called " + m.calls.length + " times" }; },
  toHaveBeenCalledOnce(a) { const m = spyOf(a); return { pass: m.calls.length === 1, message: () => says(this, a, "be called once") + ", it was called " + m.calls.length + " times" }; },
  toHaveBeenCalledWith(a, ...args) { const m = spyOf(a); return { pass: m.calls.some((c) => sameArgs(c, args)), message: () => says(this, a, "be called with", args) + ", calls: " + brief(m.calls) }; },
  toHaveBeenCalledExactlyOnceWith(a, ...args) { const m = spyOf(a); return { pass: m.calls.length === 1 && sameArgs(m.calls[0], args), message: () => says(this, a, "be called once with", args) + ", calls: " + brief(m.calls) }; },
  toHaveBeenLastCalledWith(a, ...args) { const m = spyOf(a); const last = m.calls[m.calls.length - 1]; return { pass: !!last && sameArgs(last, args), message: () => says(this, a, "be last called with", args) + ", last call: " + brief(last) }; },
  toHaveBeenNthCalledWith(a, n, ...args) { const m = spyOf(a); const c = m.calls[n - 1]; return { pass: !!c && sameArgs(c, args), message: () => says(this, a, "be called the " + n + "th time with", args) + ", that call: " + brief(c) }; },
  toHaveBeenCalledBefore(a, b) { const x = spyOf(a); const y = spyOf(b); return { pass: x.invocationCallOrder.length > 0 && (y.invocationCallOrder.length === 0 || x.invocationCallOrder[0] < y.invocationCallOrder[0]), message: () => says(this, a, "be called before", b) }; },
  toHaveBeenCalledAfter(a, b) { const x = spyOf(a); const y = spyOf(b); return { pass: x.invocationCallOrder.length > 0 && y.invocationCallOrder.length > 0 && x.invocationCallOrder[0] > y.invocationCallOrder[y.invocationCallOrder.length - 1], message: () => says(this, a, "be called after", b) }; },
  toHaveReturned(a) { const m = spyOf(a); return { pass: m.results.some((r) => r.type !== "throw"), message: () => says(this, a, "have returned") }; },
  toHaveReturnedTimes(a, n) { const m = spyOf(a); return { pass: m.results.filter((r) => r.type !== "throw").length === n, message: () => says(this, a, "have returned " + n + " times") }; },
  toHaveReturnedWith(a, v) { const m = spyOf(a); return { pass: m.results.some((r) => r.type === "return" && equals(r.value, v, file.testers.concat([iterableEquality]))), message: () => says(this, a, "have returned with", v) }; },
  toHaveLastReturnedWith(a, v) { const m = spyOf(a); const r = m.results[m.results.length - 1]; return { pass: !!r && r.type === "return" && equals(r.value, v, file.testers.concat([iterableEquality])), message: () => says(this, a, "have last returned with", v) }; },
  toHaveNthReturnedWith(a, n, v) { const m = spyOf(a); const r = m.results[n - 1]; return { pass: !!r && r.type === "return" && equals(r.value, v, file.testers.concat([iterableEquality])), message: () => says(this, a, "have returned the " + n + "th time with", v) }; },
  toHaveResolved(a) { const m = spyOf(a); return { pass: m.settledResults.some((r) => r.type === "fulfilled"), message: () => says(this, a, "have resolved") }; },
  toHaveResolvedTimes(a, n) { const m = spyOf(a); return { pass: m.settledResults.filter((r) => r.type === "fulfilled").length === n, message: () => says(this, a, "have resolved " + n + " times") }; },
  toHaveResolvedWith(a, v) { const m = spyOf(a); return { pass: m.settledResults.some((r) => r.type === "fulfilled" && equals(r.value, v, file.testers.concat([iterableEquality]))), message: () => says(this, a, "have resolved with", v) }; },
  toHaveLastResolvedWith(a, v) { const m = spyOf(a); const r = m.settledResults[m.settledResults.length - 1]; return { pass: !!r && r.type === "fulfilled" && equals(r.value, v, file.testers.concat([iterableEquality])), message: () => says(this, a, "have last resolved with", v) }; },
  toHaveNthResolvedWith(a, n, v) { const m = spyOf(a); const r = m.settledResults[n - 1]; return { pass: !!r && r.type === "fulfilled" && equals(r.value, v, file.testers.concat([iterableEquality])), message: () => says(this, a, "have resolved the " + n + "th time with", v) }; },
};
const ALIASES = {
  toThrowError: "toThrow", toBeCalled: "toHaveBeenCalled", toBeCalledTimes: "toHaveBeenCalledTimes", toBeCalledWith: "toHaveBeenCalledWith",
  lastCalledWith: "toHaveBeenLastCalledWith", toHaveBeenLastCalledWith: "toHaveBeenLastCalledWith", nthCalledWith: "toHaveBeenNthCalledWith",
  toReturn: "toHaveReturned", toReturnTimes: "toHaveReturnedTimes", toReturnWith: "toHaveReturnedWith", lastReturnedWith: "toHaveLastReturnedWith",
  nthReturnedWith: "toHaveNthReturnedWith", toBeCalledOnce: "toHaveBeenCalledOnce",
};
for (const [alias, name] of Object.entries(ALIASES)) M[alias] = M[name];
// vitest's expect is also chai's: the common chai assertions work as methods and properties of expect(value).
const CHAINS = new Set(["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "same", "but", "does", "still", "also"]);
function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const tag = Object.prototype.toString.call(v).slice(8, -1).toLowerCase();
  return typeof v === "object" || typeof v === "function" ? tag : typeof v;
}
const C = {
  instanceOf(a, K) { return M.toBeInstanceOf.call(this, a, K); },
  match(a, re) { return { pass: new RegExp(re).test(String(a)), message: () => says(this, a, "match", re) }; },
  equal(a, e) { return this.deep ? M.toEqual.call(this, a, e) : { pass: a === e, message: () => says(this, a, "equal", e), actual: a, expected: e }; },
  eql(a, e) { return M.toEqual.call(this, a, e); },
  include(a, item) {
    if (typeof a === "string") return { pass: a.includes(String(item)), message: () => says(this, a, "include", item) };
    if (a !== null && typeof a === "object" && !Array.isArray(a) && typeof a[Symbol.iterator] !== "function") return M.toMatchObject.call(this, a, item);
    return { pass: Array.from(a).some((x) => (this.deep ? equals(x, item, file.testers) : x === item)), message: () => says(this, a, "include", item) };
  },
  lengthOf(a, n) { return M.toHaveLength.call(this, a, n); },
  property(a, name, ...value) { return M.toHaveProperty.call(this, a, [name], ...value); },
  a(a, type) { return { pass: typeName(a) === String(type).toLowerCase(), message: () => says(this, a, "be a", type) }; },
  satisfy(a, fn) { return { pass: !!fn(a), message: () => says(this, a, "satisfy", fn) }; },
  closeTo(a, n, delta) { return { pass: Math.abs(a - n) <= delta, message: () => says(this, a, "be close to", n) + " +/- " + delta }; },
  oneOf(a, list) { return { pass: list.includes(a), message: () => says(this, a, "be one of", list) }; },
  throw(a, e) { return M.toThrow.call(this, a, e); },
  above(a, n) { return { pass: a > n, message: () => says(this, a, "be above", n) }; },
  below(a, n) { return { pass: a < n, message: () => says(this, a, "be below", n) }; },
  least(a, n) { return { pass: a >= n, message: () => says(this, a, "be at least", n) }; },
  most(a, n) { return { pass: a <= n, message: () => says(this, a, "be at most", n) }; },
};
const CHAI_METHODS = {
  instanceOf: C.instanceOf, instanceof: C.instanceOf, match: C.match, matches: C.match, equal: C.equal, equals: C.equal, eq: C.equal,
  eql: C.eql, eqls: C.eql, include: C.include, includes: C.include, contain: C.include, contains: C.include, lengthOf: C.lengthOf,
  property: C.property, a: C.a, an: C.a, satisfy: C.satisfy, satisfies: C.satisfy, closeTo: C.closeTo, approximately: C.closeTo,
  oneOf: C.oneOf, throw: C.throw, throws: C.throw, Throw: C.throw, above: C.above, gt: C.above, greaterThan: C.above,
  below: C.below, lt: C.below, lessThan: C.below, least: C.least, gte: C.least, most: C.most, lte: C.most,
};
const CHAI_PROPERTIES = {
  ok(a) { return { pass: !!a, message: () => says(this, a, "be truthy") }; },
  true(a) { return { pass: a === true, message: () => says(this, a, "be true") }; },
  false(a) { return { pass: a === false, message: () => says(this, a, "be false") }; },
  null(a) { return { pass: a === null, message: () => says(this, a, "be null") }; },
  undefined(a) { return { pass: a === undefined, message: () => says(this, a, "be undefined") }; },
  NaN(a) { return { pass: Number.isNaN(a), message: () => says(this, a, "be NaN") }; },
  exist(a) { return { pass: a !== null && a !== undefined, message: () => says(this, a, "exist") }; },
  exists(a) { return CHAI_PROPERTIES.exist.call(this, a); },
  finite(a) { return { pass: Number.isFinite(a), message: () => says(this, a, "be finite") }; },
  empty(a) {
    const n = typeof a === "string" || Array.isArray(a) ? a.length : a instanceof Map || a instanceof Set ? a.size : a !== null && typeof a === "object" ? Object.keys(a).length : -1;
    if (n < 0) throw new TypeError(".empty was passed non-string primitive " + brief(a));
    return { pass: n === 0, message: () => says(this, a, "be empty") };
  },
};

const utils = { stringify: brief, printReceived: brief, printExpected: brief, matcherHint: (name) => String(name), diff: () => "", iterableEquality, subsetEquality };

function thenable(x) { return x !== null && (typeof x === "object" || typeof x === "function") && typeof x.then === "function"; }

function assertion(received, flags) {
  return new Proxy({}, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (prop === "not") return assertion(received, Object.assign({}, flags, { not: !flags.not }));
      if (prop === "resolves" || prop === "rejects") return assertion(received, Object.assign({}, flags, { promise: prop }));
      const m = file.custom[prop] || M[prop];
      if (m) return (...args) => check(received, flags, m, args);
      if (CHAINS.has(prop)) return assertion(received, flags);
      if (prop === "deep") return assertion(received, Object.assign({}, flags, { deep: true }));
      if (Object.prototype.hasOwnProperty.call(CHAI_METHODS, prop)) return (...args) => check(received, flags, CHAI_METHODS[prop], args);
      if (Object.prototype.hasOwnProperty.call(CHAI_PROPERTIES, prop)) {
        check(received, flags, CHAI_PROPERTIES[prop], []);
        return assertion(received, flags);
      }
      if (prop === "poll") return undefined;
      if (/^to[A-Z]/.test(prop) || /^(last|nth)(Called|Returned)With$/.test(prop)) return () => unsupported(prop);
      if (/^(nested|own|ordered|any|all|keys|key|members|length|within|respondTo|itself|change|increase|decrease|by|extensible|sealed|frozen|fail|string|should)$/.test(prop)) return unsupported("the chai assertion ." + prop);
      return undefined;
    },
  });
}

function check(received, flags, matcher, args) {
  const st = stateOf(L.current());
  st.assertions++;
  const exec = (actual) => {
    const ctx = { isNot: !!flags.not, promise: flags.promise || "", deep: !!flags.deep, equals: (a, b, t, s) => equals(a, b, t || [], s), utils, customTesters: file.testers };
    const settle = (res) => {
      if (!res || typeof res !== "object") throw new TypeError("a matcher must return an object with pass and message");
      if (!!res.pass === !!flags.not) {
        const text = typeof res.message === "function" ? res.message() : String(res.message || "assertion failed");
        const err = new AssertionError((flags.message ? flags.message + ": " : "") + text, res);
        if (flags.soft) { st.soft.push(err); return; }
        throw err;
      }
    };
    const res = matcher.call(ctx, actual, ...args);
    return thenable(res) ? Promise.resolve(res).then(settle) : settle(res);
  };
  if (flags.promise === "resolves" || flags.promise === "rejects") {
    const value = typeof received === "function" && flags.promise === "rejects" ? received() : received;
    if (!thenable(value)) throw new TypeError("You must provide a Promise to expect() when using ." + flags.promise + ", not '" + typeof value + "'.");
    const p = flags.promise === "resolves"
      ? Promise.resolve(value).then(exec, (e) => { throw new AssertionError("promise rejected " + brief(e) + " instead of resolving"); })
      : Promise.resolve(value).then((v) => { throw new AssertionError("promise resolved " + brief(v) + " instead of rejecting"); }, exec);
    p.catch(() => undefined);
    st.pending.push(p);
    return p;
  }
  return exec(received);
}

export function expect(actual, message) {
  return assertion(actual, { not: false, promise: "", soft: false, message: typeof message === "string" ? message : "" });
}
expect.soft = (actual, message) => assertion(actual, { not: false, promise: "", soft: true, message: typeof message === "string" ? message : "" });
expect.any = (C) => {
  if (C === undefined) throw new TypeError("any() expects to be passed a constructor function. Please pass one or use anything() to match any object.");
  return asym("Any", C, false, (o) => anyMatch(C, o));
};
expect.anything = () => asym("Anything", undefined, false, (o) => o !== null && o !== undefined);
expect.closeTo = (n, digits) => asym("CloseTo", n, false, (o) => typeof o === "number" && Math.abs(n - o) < Math.pow(10, -(digits === undefined ? 2 : digits)) / 2);
for (const k of Object.keys(containing)) expect[k] = containing[k](false);
expect.not = {};
for (const k of Object.keys(containing)) expect.not[k] = containing[k](true);
expect.not.closeTo = (n, digits) => asym("CloseTo", n, true, (o) => typeof o === "number" && Math.abs(n - o) < Math.pow(10, -(digits === undefined ? 2 : digits)) / 2);
expect.assertions = (n) => { stateOf(L.current()).expected = Number(n); };
expect.hasAssertions = () => { stateOf(L.current()).has = true; };
expect.unreachable = (message) => { throw new AssertionError("expected" + (message ? ' "' + message + '" ' : " ") + "not to be reached"); };
expect.extend = (matchers) => { for (const [k, v] of Object.entries(matchers || {})) if (typeof v === "function") file.custom[k] = v; };
expect.addEqualityTesters = (testers) => { for (const t of testers || []) if (typeof t === "function") file.testers.push(t); };
expect.getState = () => { const st = stateOf(L.current()); return { assertionCalls: st.assertions, expectedAssertionsNumber: st.expected, isExpectingAssertions: st.has, currentTestName: L.current().name, testPath: L.file() }; };
expect.setState = () => {};
expect.poll = () => unsupported("expect.poll");
expect.element = () => unsupported("expect.element");
expect.addSnapshotSerializer = () => unsupported("expect.addSnapshotSerializer (snapshots)");
expect.schemaMatching = () => unsupported("expect.schemaMatching");

export function createExpect() { return expect; }

// expectTypeOf and assertType check types when the project type-checks; at run time they do nothing, as in vitest.
const typeChain = new Proxy(function () {}, {
  get(target, prop) { return typeof prop === "symbol" || prop === "then" ? undefined : typeChain; },
  apply() { return typeChain; },
});
export function expectTypeOf() { return typeChain; }
export function assertType() {}

function chaiOnly(name) {
  return new Proxy(function () {}, { get(target, prop) { return typeof prop === "symbol" || prop === "then" ? undefined : () => unsupported(name + "." + String(prop)); }, apply() { return unsupported(name); } });
}
export const assert = chaiOnly("assert (chai)");
export const chai = chaiOnly("chai");
export function should() { return unsupported("should (chai)"); }
export function inject() { return unsupported("inject (provide / inject from a global setup)"); }
export function recordArtifact() { return Promise.resolve(); }
export function getRunningMode() { return "run"; }
export function isWatchMode() { return false; }

// ---- mocks ----

let callOrder = 0;
function createMock(impl, spy) {
  let state;
  const fresh = () => { state = { calls: [], results: [], settledResults: [], instances: [], contexts: [], invocationCallOrder: [], lastCall: undefined }; };
  fresh();
  const original = impl;
  let implementation = impl;
  let onces = [];
  let name = spy ? "spy" : "vi.fn()";
  const mock = function (...args) {
    state.calls.push(args);
    state.lastCall = args;
    state.contexts.push(this);
    state.invocationCallOrder.push(++callOrder);
    const result = { type: "incomplete", value: undefined };
    const settled = { type: "incomplete", value: undefined };
    state.results.push(result);
    state.settledResults.push(settled);
    const fn = onces.length > 0 ? onces.shift() : implementation;
    try {
      let value;
      if (new.target) {
        value = fn ? Reflect.construct(fn, args, new.target) : this;
        if (value === undefined || value === null || (typeof value !== "object" && typeof value !== "function")) value = this;
        state.instances.push(value);
      } else {
        value = fn ? fn.apply(this, args) : undefined;
      }
      result.type = "return";
      result.value = value;
      if (thenable(value)) value.then((v) => { settled.type = "fulfilled"; settled.value = v; }, (e) => { settled.type = "rejected"; settled.value = e; });
      else { settled.type = "fulfilled"; settled.value = value; }
      return value;
    } catch (e) {
      result.type = "throw";
      result.value = e;
      settled.type = "rejected";
      settled.value = e;
      throw e;
    }
  };
  Object.defineProperty(mock, "mock", { get: () => state, configurable: true });
  mock._isMockFunction = true;
  mock.getMockName = () => name;
  mock.mockName = (n) => { name = String(n); return mock; };
  mock.getMockImplementation = () => implementation;
  mock.mockClear = () => { fresh(); return mock; };
  mock.mockReset = () => { fresh(); implementation = original; onces = []; return mock; };
  mock.mockRestore = () => { mock.mockReset(); if (spy) spy.restore(); return mock; };
  mock.mockImplementation = (fn) => { implementation = fn; return mock; };
  mock.mockImplementationOnce = (fn) => { onces.push(fn); return mock; };
  mock.mockReturnValue = (v) => mock.mockImplementation(() => v);
  mock.mockReturnValueOnce = (v) => mock.mockImplementationOnce(() => v);
  mock.mockResolvedValue = (v) => mock.mockImplementation(() => Promise.resolve(v));
  mock.mockResolvedValueOnce = (v) => mock.mockImplementationOnce(() => Promise.resolve(v));
  mock.mockRejectedValue = (e) => mock.mockImplementation(() => Promise.reject(e));
  mock.mockRejectedValueOnce = (e) => mock.mockImplementationOnce(() => Promise.reject(e));
  mock.mockReturnThis = () => mock.mockImplementation(function () { return this; });
  mock.withImplementation = (fn, cb) => {
    const saved = implementation;
    implementation = fn;
    const done = () => { implementation = saved; };
    const r = cb();
    if (thenable(r)) return Promise.resolve(r).finally(done).then(() => mock);
    done();
    return mock;
  };
  file.mocks.add(mock);
  return mock;
}

function descriptorOf(obj, key) {
  for (let o = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return { d, own: o === obj };
  }
  return null;
}

function spyOn(obj, key, access) {
  if (obj === null || obj === undefined || (typeof obj !== "object" && typeof obj !== "function")) throw new TypeError("vi.spyOn() needs an object, received " + brief(obj));
  const found = descriptorOf(obj, key);
  if (!found) throw new Error(String(key) + " does not exist");
  const d = found.d;
  const restore = () => {
    if (found.own) Object.defineProperty(obj, key, d);
    else delete obj[key];
  };
  if (access === "get" || access === "set") {
    const orig = d[access];
    if (typeof orig !== "function") throw new TypeError(String(key) + " has no " + access + "ter");
    const m = createMock(orig, { restore });
    Object.defineProperty(obj, key, Object.assign({}, d, { [access]: m, configurable: true }));
    file.spies.push({ restore });
    return m;
  }
  const current = "value" in d ? d.value : obj[key];
  if (isMock(current)) return current;
  if (typeof current !== "function") throw new TypeError("cannot spy on " + String(key) + ": it is not a function");
  const m = createMock(current, { restore });
  if (current.prototype) m.prototype = current.prototype;
  Object.defineProperty(obj, key, { value: m, writable: true, configurable: true, enumerable: d.enumerable !== false });
  file.spies.push({ restore });
  return m;
}

// ---- fake timers ----

const fake = { on: false, timersOn: false, now: 0, seq: 0, timers: new Map(), saved: null, limit: 10000 };
function handle(id) {
  return { id, ref() { return this; }, unref() { return this; }, hasRef() { return true; }, refresh() { return this; }, [Symbol.toPrimitive]() { return id; } };
}
function idOf(h) { return h !== null && typeof h === "object" ? h.id : Number(h); }
function addTimer(fn, ms, args, repeat) {
  const id = ++fake.seq;
  const delay = Math.max(0, Number(ms) || 0);
  if (typeof fn === "function") fake.timers.set(id, { id, fn, args, at: fake.now + delay, every: repeat ? Math.max(1, delay) : 0 });
  return handle(id);
}
function clearTimer(h) { fake.timers.delete(idOf(h)); }
function FakeDate(...args) {
  if (!new.target) return new REAL.Date(fake.now).toString();
  return Reflect.construct(REAL.Date, args.length === 0 ? [fake.now] : args, new.target);
}
FakeDate.prototype = REAL.Date.prototype;
FakeDate.now = () => fake.now;
FakeDate.parse = REAL.Date.parse;
FakeDate.UTC = REAL.Date.UTC;
Object.setPrototypeOf(FakeDate, REAL.Date);

function install(timers, opts) {
  if (!fake.on) {
    fake.saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setImmediate: globalThis.setImmediate, clearImmediate: globalThis.clearImmediate, Date: globalThis.Date };
    fake.now = realNow();
    fake.on = true;
  }
  if (opts && opts.now !== undefined) fake.now = opts.now instanceof REAL.Date ? opts.now.getTime() : Number(opts.now);
  if (opts && typeof opts.loopLimit === "number") fake.limit = opts.loopLimit;
  const only = opts && Array.isArray(opts.toFake) ? new Set(opts.toFake) : null;
  const want = (k) => (only ? only.has(k) : true);
  if (want("Date")) globalThis.Date = FakeDate;
  if (!timers) return;
  fake.timersOn = true;
  if (want("setTimeout")) globalThis.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
  if (want("clearTimeout")) globalThis.clearTimeout = clearTimer;
  if (want("setInterval")) globalThis.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
  if (want("clearInterval")) globalThis.clearInterval = clearTimer;
  if (want("setImmediate") && typeof fake.saved.setImmediate === "function") globalThis.setImmediate = (fn, ...args) => addTimer(fn, 0, args, false);
  if (want("clearImmediate") && typeof fake.saved.clearImmediate === "function") globalThis.clearImmediate = clearTimer;
}
function uninstall() {
  if (!fake.on) return;
  for (const [k, v] of Object.entries(fake.saved)) if (v !== undefined) globalThis[k] = v;
  fake.on = false;
  fake.timersOn = false;
  fake.timers.clear();
}
function fireNext(limit) {
  let next = null;
  for (const t of fake.timers.values()) if (t.at <= limit && (next === null || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
  if (!next) return false;
  if (next.at > fake.now) fake.now = next.at;
  if (next.every > 0) next.at += next.every;
  else fake.timers.delete(next.id);
  next.fn.apply(globalThis, next.args);
  return true;
}
function needTimers(api) { if (!fake.timersOn) throw new Error("Timers are not mocked. Try calling \"vi.useFakeTimers()\" first."); }
function tooMany() { return new Error("Aborting after running " + fake.limit + " timers, assuming an infinite loop!"); }
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await realSleep(0);
}
function earliest() {
  let at = Infinity;
  for (const t of fake.timers.values()) if (t.at < at) at = t.at;
  return at;
}

// ---- vi ----

export const vi = {
  fn: (impl) => createMock(impl),
  spyOn,
  isMockFunction: isMock,
  mocked: (x) => x,
  clearAllMocks() { for (const m of file.mocks) m.mockClear(); return vi; },
  resetAllMocks() { for (const m of file.mocks) m.mockReset(); return vi; },
  restoreAllMocks() { while (file.spies.length > 0) file.spies.pop().restore(); return vi; },
  stubGlobal(name, value) {
    if (!file.globals.has(name)) file.globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
    return vi;
  },
  unstubAllGlobals() {
    for (const [name, d] of file.globals) { if (d) Object.defineProperty(globalThis, name, d); else delete globalThis[name]; }
    file.globals.clear();
    return vi;
  },
  stubEnv(name, value) {
    const env = globalThis.process && globalThis.process.env;
    if (!env) unsupported("vi.stubEnv (the runtime has no process.env)");
    if (!file.envs.has(name)) file.envs.set(name, hasOwn(env, name) ? { had: true, value: env[name] } : { had: false });
    if (value === undefined) delete env[name];
    else env[name] = typeof value === "boolean" ? (value ? "1" : "") : String(value);
    return vi;
  },
  unstubAllEnvs() {
    const env = globalThis.process && globalThis.process.env;
    if (env) for (const [name, was] of file.envs) { if (was.had) env[name] = was.value; else delete env[name]; }
    file.envs.clear();
    return vi;
  },
  useFakeTimers(opts) {
    if (opts && opts.shouldAdvanceTime) unsupported("vi.useFakeTimers({ shouldAdvanceTime })");
    install(true, opts);
    return vi;
  },
  useRealTimers() { uninstall(); return vi; },
  isFakeTimers() { return fake.timersOn; },
  setSystemTime(t) {
    const ms = t instanceof REAL.Date ? t.getTime() : typeof t === "number" ? t : new REAL.Date(t).getTime();
    if (!fake.on) install(false);
    fake.now = ms;
    return vi;
  },
  getMockedSystemTime() { return fake.on ? new REAL.Date(fake.now) : null; },
  getRealSystemTime() { return realNow(); },
  advanceTimersByTime(ms) {
    needTimers();
    const target = fake.now + Math.max(0, Number(ms) || 0);
    let n = 0;
    while (fireNext(target)) if (++n > fake.limit) throw tooMany();
    fake.now = target;
    return vi;
  },
  async advanceTimersByTimeAsync(ms) {
    needTimers();
    const target = fake.now + Math.max(0, Number(ms) || 0);
    let n = 0;
    await flush();
    while (fireNext(target)) { if (++n > fake.limit) throw tooMany(); await flush(); }
    fake.now = target;
    return vi;
  },
  advanceTimersToNextTimer(steps) {
    needTimers();
    for (let i = 0; i < (steps === undefined ? 1 : steps); i++) { const at = earliest(); if (at === Infinity) break; fireNext(at); }
    return vi;
  },
  async advanceTimersToNextTimerAsync(steps) {
    needTimers();
    for (let i = 0; i < (steps === undefined ? 1 : steps); i++) { await flush(); const at = earliest(); if (at === Infinity) break; fireNext(at); }
    await flush();
    return vi;
  },
  runAllTimers() {
    needTimers();
    let n = 0;
    while (fireNext(Infinity)) if (++n > fake.limit) throw tooMany();
    return vi;
  },
  async runAllTimersAsync() {
    needTimers();
    let n = 0;
    await flush();
    while (fireNext(Infinity)) { if (++n > fake.limit) throw tooMany(); await flush(); }
    return vi;
  },
  runOnlyPendingTimers() {
    needTimers();
    const pending = [...fake.timers.values()].sort((a, b) => a.at - b.at || a.id - b.id);
    for (const t of pending) {
      if (!fake.timers.has(t.id)) continue;
      if (t.at > fake.now) fake.now = t.at;
      if (t.every > 0) t.at += t.every; else fake.timers.delete(t.id);
      t.fn.apply(globalThis, t.args);
    }
    return vi;
  },
  async runOnlyPendingTimersAsync() { await flush(); vi.runOnlyPendingTimers(); await flush(); return vi; },
  runAllTicks() { return vi; },
  getTimerCount() { return fake.timers.size; },
  clearAllTimers() { fake.timers.clear(); return vi; },
  async waitFor(cb, options) {
    const o = typeof options === "number" ? { timeout: options } : options || {};
    const timeout = typeof o.timeout === "number" ? o.timeout : 1000;
    const interval = typeof o.interval === "number" ? o.interval : 50;
    const start = realNow();
    let last;
    for (;;) {
      if (fake.timersOn) vi.advanceTimersByTime(interval);
      try { return await cb(); } catch (e) { last = e; }
      if (realNow() - start >= timeout) throw last || new Error("Timed out in waitFor!");
      await realSleep(interval);
    }
  },
  async waitUntil(cb, options) {
    const o = typeof options === "number" ? { timeout: options } : options || {};
    const timeout = typeof o.timeout === "number" ? o.timeout : 1000;
    const interval = typeof o.interval === "number" ? o.interval : 50;
    const start = realNow();
    for (;;) {
      if (fake.timersOn) vi.advanceTimersByTime(interval);
      const r = await cb();
      if (r) return r;
      if (realNow() - start >= timeout) throw new Error("Timed out in waitUntil!");
      await realSleep(interval);
    }
  },
  async dynamicImportSettled() { await flush(); },
  hoisted: (fn) => fn(),
  setConfig(c) { if (c && typeof c.testTimeout === "number") config.testTimeout = c.testTimeout; if (c && typeof c.hookTimeout === "number") config.hookTimeout = c.hookTimeout; },
  resetConfig() { config.testTimeout = 5000; config.hookTimeout = 10000; },
  mock: () => unsupported("vi.mock (module mocking)"),
  doMock: () => unsupported("vi.doMock (module mocking)"),
  unmock: () => unsupported("vi.unmock (module mocking)"),
  doUnmock: () => unsupported("vi.doUnmock (module mocking)"),
  importActual: () => unsupported("vi.importActual (module mocking)"),
  importMock: () => unsupported("vi.importMock (module mocking)"),
  mockObject: () => unsupported("vi.mockObject"),
  resetModules: () => unsupported("vi.resetModules"),
};
export const vitest = vi;

// ---- globals and the file's lifecycle ----

const GLOBALS = { suite, test, describe, it, bench, chai, expect, assert, expectTypeOf, assertType, vitest, vi, beforeAll, afterAll, beforeEach, afterEach, onTestFinished, onTestFailed };
function installGlobals() {
  if (!file.savedGlobals) {
    file.savedGlobals = new Map();
    for (const k of Object.keys(GLOBALS)) file.savedGlobals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
  }
  for (const [k, v] of Object.entries(GLOBALS)) Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true, enumerable: false });
}
// Called by the globals module a test file written for vitest's globals imports first.
export function __ftGlobals() {
  globalsOn = true;
  installGlobals();
}

function hasOnly(s) {
  for (const c of s.children) if (c.vt && (c.opts.only || (c.kind === "suite" && hasOnly(c)))) return true;
  return false;
}
// vitest's modes within one file: with an only anywhere, what is not only (or under one) is skipped; a suite whose tests are all skipped is skipped.
function applyModes(s, onlyMode, parentOnly) {
  const suiteOnly = parentOnly || !!(s.opts && s.opts.only);
  for (const c of s.children) {
    if (!c.vt) continue;
    const include = suiteOnly || !!c.opts.only;
    if (onlyMode && !c.opts.skip) {
      if (c.kind === "suite") { if (!include && !hasOnly(c)) c.opts.skip = true; }
      else if (!include) c.opts.skip = true;
    }
    if (c.kind === "suite" && !c.opts.skip) applyModes(c, onlyMode, include);
  }
  if (s.vt && s.kind === "suite" && !s.opts.skip && s.children.length > 0 && s.children.every((c) => c.opts.skip)) s.opts.skip = true;
}

function endFile() {
  workerIdentity();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  uninstall();
  if (file.savedGlobals) {
    for (const [k, d] of file.savedGlobals) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    file.savedGlobals = null;
  }
}

nodeIdentity();
L.attach({
  begin() {
    resetFile();
    nodeIdentity();
    config.testTimeout = 5000;
    config.hookTimeout = 10000;
    if (globalsOn) installGlobals();
  },
  beforeRun(root) { applyModes(root, hasOnly(root), false); },
  end() { endFile(); },
});
`;

/** The module a test file that uses vitest's globals imports first (plan.ts): it puts describe, it, expect, vi and the rest on the global object. */
export const VITEST_GLOBALS = String.raw`// vitest's globals for trunk certification (FireTrident).
import { __ftGlobals } from "./vitest.js";
__ftGlobals();
`;

/** The names the vitest shim exports: a module that imports another name from "vitest" cannot run here. */
export const VITEST_EXPORTS: ReadonlySet<string> = new Set([
  "test",
  "it",
  "describe",
  "suite",
  "bench",
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
  "onTestFinished",
  "onTestFailed",
  "expect",
  "createExpect",
  "expectTypeOf",
  "assertType",
  "assert",
  "chai",
  "should",
  "inject",
  "recordArtifact",
  "getRunningMode",
  "isWatchMode",
  "vi",
  "vitest",
]);
