/**
 * The `node:test` module trunk certification gives test files (their `node:test` imports are
 * rewritten to it). It is plain JavaScript, kept as a string because it runs inside the Dynamic
 * Worker, never in this Worker. One instance per test file (each file gets its own copy of the
 * modules it imports, as `node --test` gives each file its own process), so the registry here is
 * one file's tests.
 *
 * Supported, with Node's semantics and counting: test / it / describe / suite with nesting;
 * (name), (name, fn), (name, options, fn), (options, fn) and (fn) forms; skip / todo / only
 * (as options or `.skip` / `.todo` / `.only`); async functions and done callbacks; `t.test`
 * subtests (and a global test() called inside a running test); before / after / beforeEach /
 * afterEach at file, suite and test level (and `t.before` and friends); `t.skip()`, `t.todo()`,
 * `t.plan()` with `t.assert`, `t.mock` (the runtime's own mock tracker) and per-test timeouts.
 * Not supported: concurrency (tests run one at a time), snapshots, `run()`, `--test-only`.
 *
 * Counting follows `node --test`: tests = pass + fail + cancelled + skipped + todo; a test whose
 * subtests fail fails too; tests of a suite whose body or `before` hook throws are cancelled; a
 * skipped suite contributes nothing; failures inside todo tests count as todo; a timed-out test is
 * cancelled. The harness (see plan.ts) calls `__ft.begin`, imports the file, then `__ft.finish`.
 */
export const NODE_TEST_SHIM = String.raw`// node:test for trunk certification (FireTrident).
import { AsyncLocalStorage } from "node:async_hooks";
import nodeAssert from "node:assert";
import { inspect } from "node:util";
import * as builtin from "node:test";

const als = new AsyncLocalStorage();
const settings = { file: "", timeoutMs: 10000, deadline: Infinity, exhausted: false };
const CANCELLED_BY_PARENT = "test did not finish before its parent and was cancelled";
const GENERATED = /^(Expected values|Expected "actual"|Values are|Values have same|Values identical|Expected value|Input A expected|The expression)/;
const OPS = { strictEqual: "strictEqual", equal: "equal", notStrictEqual: "notStrictEqual", notEqual: "notEqual", deepStrictEqual: "deepStrictEqual", deepEqual: "deepEqual", notDeepStrictEqual: "notDeepStrictEqual", notDeepEqual: "notDeepEqual" };

function makeNode(kind, name, parent, opts, fn) {
  const n = {
    kind, name, parent, opts: opts || {}, fn: typeof fn === "function" ? fn : null,
    children: [], hooks: { before: [], after: [], beforeEach: [], afterEach: [] },
    status: "", error: null, ms: 0, ready: null, queue: [], pump: null, subsBefore: false,
    failedChildren: 0, assertions: 0, plan: null, skipMsg: undefined, todoMsg: undefined,
    done: null, resolve: null, settled: false, collected: false,
  };
  n.done = new Promise((r) => { n.resolve = r; });
  return n;
}

// One file's registry; __ft.begin starts a fresh one (a shim shared by several files serves them in turn).
let root = null;
let drain = null;
let nextTop = 0;
let rootBefore = null;
let closed = false;
let running = false;
let diagnostics = [];
function fresh() {
  root = makeNode("suite", "", null, {}, null);
  root.isRoot = true;
  drain = null;
  nextTop = 0;
  rootBefore = null;
  closed = false;
  running = false;
  diagnostics = [];
}
fresh();

function current() {
  return als.getStore() || root;
}

function normalize(args) {
  let name = args[0];
  let opts = args[1];
  let fn = args[2];
  if (typeof name === "function") { fn = name; opts = undefined; name = undefined; }
  else if (name !== null && typeof name === "object") { fn = opts; opts = name; name = undefined; }
  if (typeof opts === "function") { fn = opts; opts = undefined; }
  opts = opts !== null && typeof opts === "object" ? opts : {};
  if (name === undefined || name === null || name === "") name = (typeof fn === "function" && fn.name) || "<anonymous>";
  return { name: String(name), opts, fn: typeof fn === "function" ? fn : null };
}

function register(kind, args, extra, forced) {
  const a = normalize(args);
  const parent = forced || current();
  const opts = Object.assign({}, a.opts, extra);
  const n = makeNode(kind, a.name, parent, opts, a.fn);
  if (closed && parent === root) { n.resolve(); return n.done; }
  parent.children.push(n);
  if (kind === "suite" && !opts.skip) collect(n);
  if (parent.kind === "test") enqueueSub(parent, n);
  else if (parent === root && running) scheduleDrain();
  return n.done;
}

function collect(s) {
  s.collected = true;
  if (!s.fn) return;
  try {
    const ctx = suiteContext(s);
    const r = als.run(s, () => s.fn.call(ctx, ctx));
    if (r && typeof r.then === "function") s.ready = Promise.resolve(r).then(() => undefined, (e) => { s.error = { value: e }; });
  } catch (e) {
    s.error = { value: e };
  }
}

function addHook(kind, fn, opts) {
  if (typeof fn !== "function") return;
  current().hooks[kind].push({ fn, opts: opts || {} });
}

export function test(...a) { return register("test", a, {}); }
test.skip = (...a) => register("test", a, { skip: true });
test.todo = (...a) => register("test", a, { todo: true });
test.only = (...a) => register("test", a, { only: true });
export function describe(...a) { return register("suite", a, {}); }
describe.skip = (...a) => register("suite", a, { skip: true });
describe.todo = (...a) => register("suite", a, { todo: true });
describe.only = (...a) => register("suite", a, { only: true });
export const it = (...a) => register("test", a, {});
it.skip = (...a) => register("test", a, { skip: true });
it.todo = (...a) => register("test", a, { todo: true });
it.only = (...a) => register("test", a, { only: true });
export const suite = describe;
export function before(fn, opts) { addHook("before", fn, opts); }
export function after(fn, opts) { addHook("after", fn, opts); }
export function beforeEach(fn, opts) { addHook("beforeEach", fn, opts); }
export function afterEach(fn, opts) { addHook("afterEach", fn, opts); }
export const mock = builtin.mock;
const Tracker = typeof builtin.MockTracker === "function" ? builtin.MockTracker : builtin.mock && typeof builtin.mock.constructor === "function" && builtin.mock.constructor !== Object ? builtin.mock.constructor : null;
export const skip = test.skip;
export const todo = test.todo;
export const only = test.only;
export function run() { throw new Error("run() is not available in trunk certification"); }
Object.assign(test, { test, it, describe, suite, before, after, beforeEach, afterEach, mock, run });
export default test;

function scheduleDrain() {
  if (drain) return;
  drain = Promise.resolve().then(runTop).finally(() => { drain = null; });
}

async function runTop() {
  if (rootBefore === null) rootBefore = (await runHooks(root.hooks.before, root, suiteContext(root), true)) || false;
  while (nextTop < root.children.length) {
    const n = root.children[nextTop++];
    if (rootBefore) cancelTree(n, rootBefore);
    else await runItem(n);
  }
}

function runItem(n) {
  return n.kind === "suite" ? runSuite(n) : runTest(n);
}

function clock() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function inTodo(n) {
  for (let p = n; p; p = p.parent) if (p.opts && p.opts.todo) return true;
  return false;
}

function settle(n, status, error) {
  if (n.settled) return;
  n.settled = true;
  n.status = status;
  if (error) n.error = error;
  n.resolve();
}

function cancelTree(n, error) {
  if (n.kind === "test") settle(n, "cancelled", error || { value: CANCELLED_BY_PARENT });
  else {
    if (!n.settled) { n.status = "fail"; n.settled = true; n.resolve(); }
  }
  for (const c of n.children) cancelTree(c, { value: CANCELLED_BY_PARENT });
}

async function runSuite(s) {
  const t0 = clock();
  if (s.opts.skip) { s.ms = 0; settle(s, "skipped"); return; }
  if (s.ready) await s.ready;
  if (s.error) {
    for (const c of s.children) cancelTree(c, { value: CANCELLED_BY_PARENT });
    s.ms = clock() - t0;
    settle(s, "fail", s.error);
    return;
  }
  const ctx = suiteContext(s);
  const beforeErr = await runHooks(s.hooks.before, s, ctx, true);
  if (beforeErr) {
    s.error = beforeErr;
    for (const c of s.children) cancelTree(c, { value: CANCELLED_BY_PARENT });
  } else {
    for (let i = 0; i < s.children.length; i++) await runItem(s.children[i]);
  }
  const afterErr = await runHooks(s.hooks.after, s, ctx, false);
  if (afterErr && !s.error) s.error = afterErr;
  s.ms = clock() - t0;
  const childFailed = s.children.some((c) => c.status === "fail" || c.status === "cancelled");
  settle(s, s.error || childFailed ? "fail" : "pass");
}

function ancestors(n) {
  const out = [];
  for (let p = n.parent; p; p = p.parent) out.unshift(p);
  return out;
}

async function runTest(n) {
  const t0 = clock();
  if (n.opts.skip) { settle(n, "skipped"); return; }
  if (settings.exhausted || Date.now() >= settings.deadline) { settle(n, "cancelled", { value: "not run: the certification ran out of time" }); return; }
  const ctx = testContext(n);
  n.ctx = ctx;
  const chain = ancestors(n);
  let err = null;
  for (const a of chain) {
    err = await runHooks(a.hooks.beforeEach, n, ctx, true);
    if (err) break;
  }
  if (!err) err = await invoke(n, n.fn, ctx, timeoutFor(n), true);
  while (n.pump) await n.pump;
  if (!err && n.failedChildren > 0) err = { value: new Error(n.failedChildren + (n.failedChildren === 1 ? " subtest failed" : " subtests failed")) };
  const afterErr = await runHooks(n.hooks.after, n, ctx, false);
  if (!err && afterErr) err = afterErr;
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = await runHooks(chain[i].hooks.afterEach, n, ctx, false);
    if (!err && e) err = e;
  }
  if (!err && n.plan !== null && n.assertions !== n.plan) err = { value: new Error("plan expected " + n.plan + " assertions but received " + n.assertions) };
  try { if (ctx.mock && typeof ctx.mock.reset === "function") ctx.mock.reset(); } catch (e) { /* a mock that cannot be restored */ }
  try { ctx.__abort(); } catch (e) { /* already aborted */ }
  n.ms = clock() - t0;
  let status;
  if (n.skipMsg !== undefined) status = "skipped";
  else if (n.todoMsg !== undefined || inTodo(n)) status = "todo";
  else if (err) status = err.cancel ? "cancelled" : "fail";
  else status = "pass";
  settle(n, status, err);
}

function timeoutFor(n) {
  let ms = settings.timeoutMs;
  for (let p = n; p; p = p.parent) {
    const t = p.opts && p.opts.timeout;
    if (typeof t === "number" && t >= 0 && t < ms) ms = t;
  }
  return ms;
}

function invoke(owner, fn, ctx, ms, isTest) {
  if (typeof fn !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const done = (err) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      resolve(err);
    };
    const left = settings.deadline - Date.now();
    const budget = left < ms;
    const limit = Math.max(0, Math.min(ms, left));
    if (Number.isFinite(limit)) {
      timer = setTimeout(() => {
        if (budget) settings.exhausted = true;
        const e = budget ? new Error("the certification ran out of time while this " + (isTest ? "test" : "hook") + " ran") : new Error((isTest ? "test" : "hook") + " timed out after " + ms + "ms");
        try { if (ctx) ctx.__abort(e); } catch (x) { /* already aborted */ }
        done({ value: e, cancel: true });
      }, limit);
    }
    als.run(owner, () => {
      try {
        if (fn.length >= 2) {
          const cb = (e) => done(e === undefined || e === null ? null : { value: e });
          const r = fn.call(ctx, ctx, cb);
          if (r && typeof r.then === "function") {
            Promise.resolve(r).then(
              () => done({ value: new Error("passed a callback but also returned a Promise") }),
              (e) => done({ value: e }),
            );
          }
        } else {
          const r = fn.call(ctx, ctx);
          if (r && typeof r.then === "function") Promise.resolve(r).then(() => done(null), (e) => done({ value: e }));
          else done(null);
        }
      } catch (e) {
        done({ value: e });
      }
    });
  });
}

async function runHooks(list, owner, ctx, stopAtFirst) {
  let first = null;
  for (const h of list) {
    const t = h.opts && typeof h.opts.timeout === "number" ? Math.min(h.opts.timeout, settings.timeoutMs) : settings.timeoutMs;
    const err = await invoke(owner, h.fn, ctx, t, false);
    if (err && !first) {
      first = err;
      if (stopAtFirst) break;
    }
  }
  return first;
}

function enqueueSub(p, c) {
  if (p.settled) {
    cancelTree(c, { value: "subtest started after its parent finished" });
    return c.done;
  }
  p.queue.push(c);
  if (!p.pump) p.pump = pumpSubs(p).finally(() => { p.pump = null; });
  return c.done;
}

async function pumpSubs(p) {
  if (!p.subsBefore) {
    p.subsBefore = true;
    const err = await runHooks(p.hooks.before, p, p.ctx || null, true);
    if (err) p.subsBeforeError = err;
  }
  while (p.queue.length > 0) {
    const c = p.queue.shift();
    if (p.subsBeforeError) cancelTree(c, { value: CANCELLED_BY_PARENT });
    else await runItem(c);
    if (c.status === "fail" || c.status === "cancelled") p.failedChildren++;
  }
}

function fullName(n) {
  const parts = [];
  for (let p = n; p && !p.isRoot; p = p.parent) parts.unshift(p.name);
  return parts.join(" > ");
}

function suiteContext(s) {
  return { name: s.name, fullName: fullName(s), filePath: settings.file, signal: new AbortController().signal };
}

function testContext(n) {
  const ac = new AbortController();
  const assert = {};
  for (const k of Object.keys(nodeAssert)) {
    const f = nodeAssert[k];
    if (typeof f === "function" && !/^[A-Z]/.test(k)) assert[k] = (...args) => { n.assertions++; return f.apply(nodeAssert, args); };
  }
  let tracker;
  try { tracker = Tracker ? new Tracker() : undefined; } catch (e) { tracker = undefined; }
  return {
    name: n.name,
    fullName: fullName(n),
    filePath: settings.file,
    signal: ac.signal,
    assert,
    mock: tracker,
    test: (...a) => register("test", a, {}, n),
    skip: (msg) => { n.skipMsg = msg === undefined ? "" : String(msg); },
    todo: (msg) => { n.todoMsg = msg === undefined ? "" : String(msg); },
    plan: (count) => { n.plan = Number(count); },
    diagnostic: (msg) => { if (diagnostics.length < 50) diagnostics.push(String(msg)); },
    runOnly: () => {},
    before: (fn, o) => { if (typeof fn === "function") n.hooks.before.push({ fn, opts: o || {} }); },
    after: (fn, o) => { if (typeof fn === "function") n.hooks.after.push({ fn, opts: o || {} }); },
    beforeEach: (fn, o) => { if (typeof fn === "function") n.hooks.beforeEach.push({ fn, opts: o || {} }); },
    afterEach: (fn, o) => { if (typeof fn === "function") n.hooks.afterEach.push({ fn, opts: o || {} }); },
    __abort: (reason) => { if (!ac.signal.aborted) ac.abort(reason); },
  };
}

function brief(x) {
  let s;
  try { s = inspect(x, { depth: 3, breakLength: Infinity, maxArrayLength: 12, maxStringLength: 120 }); } catch (e) { s = String(x); }
  return s.length > 160 ? s.slice(0, 157) + "..." : s;
}

function where(v) {
  const stack = v && typeof v.stack === "string" ? v.stack : "";
  const re = /(?:^|[\s(\/])t\d+\/([^\s:()]+?):(\d+)(?::\d+)?/g;
  for (let m = re.exec(stack); m; m = re.exec(stack)) if (!m[1].startsWith("__ft_certify__/")) return m[1] + ":" + m[2];
  return "";
}

function errorText(err) {
  if (!err) return undefined;
  const v = err.value;
  try {
    let text;
    if (typeof v === "string") text = v;
    else if (v && typeof v === "object" && typeof v.message === "string") {
      const name = v.name || "Error";
      if (v.code === "ERR_ASSERTION" && "actual" in v && "expected" in v && OPS[v.operator]) {
        // Runtimes word (and flag) generated messages differently: show the values, plus the test's own message.
        text = name + " (" + OPS[v.operator] + "): actual " + brief(v.actual) + ", expected " + brief(v.expected);
        const own = !v.generatedMessage && !GENERATED.test(v.message) ? v.message.split("\n")[0].trim() : "";
        if (own) text += ": " + own;
      } else {
        const lines = v.message.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^\[Diff\]|^\+ actual|^- expected/i.test(l));
        text = name + ": " + lines.slice(0, 4).join(" ");
      }
      const at = where(v);
      if (at) text += " (at " + at + ")";
    } else text = "thrown: " + brief(v);
    return text.length > 400 ? text.slice(0, 397) + "..." : text;
  } catch (e) {
    return "thrown: (unprintable)";
  }
}

function report() {
  const tests = [];
  const suites = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.kind === "test") {
        const status = c.settled ? c.status : "cancelled";
        const entry = { name: fullName(c), file: settings.file, status, ms: Math.round(c.ms * 10) / 10 };
        const err = c.settled ? c.error : { value: "not finished when the file ended" };
        if (status === "fail" || status === "cancelled" || status === "todo") { const t = errorText(err); if (t) entry.error = t; }
        tests.push(entry);
      } else if (!c.opts.skip) {
        const entry = { name: fullName(c), file: settings.file, status: c.settled ? c.status : "fail" };
        if (c.error) entry.error = errorText(c.error);
        suites.push(entry);
      } else {
        suites.push({ name: fullName(c), file: settings.file, status: "skipped" });
      }
      walk(c);
    }
  };
  walk(root);
  return { tests, suites };
}

function race(p, ms, message) {
  if (!Number.isFinite(ms)) return p;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms));
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export const __ft = {
  begin(opts) {
    fresh();
    settings.exhausted = false;
    settings.file = String(opts.file || "");
    if (typeof opts.timeoutMs === "number") settings.timeoutMs = opts.timeoutMs;
    if (typeof opts.deadline === "number") settings.deadline = opts.deadline;
  },
  async finish(loadError) {
    if (loadError !== null && loadError !== undefined) {
      closed = true;
      const text = errorText({ value: loadError }) || "the test file failed to load";
      return { file: settings.file, loadError: text, tests: [{ name: settings.file, file: settings.file, status: "fail", error: text }], suites: [], diagnostics };
    }
    // Tests start here, in the request: the runtime evaluates modules outside any request, where
    // timers are not allowed. (So a file that awaits its own tests at top level never finishes loading.)
    running = true;
    scheduleDrain();
    let timedOut = false;
    try {
      // A little past the deadline, so a test's own budget timer settles it first.
      while (drain) await race(drain, settings.deadline - Date.now() + 100, "the certification ran out of time");
    } catch (e) {
      timedOut = true;
      settings.exhausted = true;
    }
    closed = true;
    for (let i = nextTop; i < root.children.length; i++) cancelTree(root.children[i], { value: "not run: the certification ran out of time" });
    const rootError = timedOut ? null : await runHooks(root.hooks.after, root, suiteContext(root), false);
    const out = report();
    if (rootBefore) out.suites.push({ name: "(file before hook)", file: settings.file, status: "fail", error: errorText(rootBefore) });
    if (rootError) out.suites.push({ name: "(file after hook)", file: settings.file, status: "fail", error: errorText(rootError) });
    return { file: settings.file, loadError: null, tests: out.tests, suites: out.suites, diagnostics, exhausted: settings.exhausted };
  },
};
`;
