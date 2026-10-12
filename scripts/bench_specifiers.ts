#!/usr/bin/env node
/**
 * Benchmark the agent's import-specifier edit (packages/worker/src/agents) against
 * Workers AI models on the same intents, outside the platform.
 *
 * For each sampled file that violates the rule, it runs exactly what an agent runs:
 * the read context from the tree, buildSpecifierMessages, one call, parse, apply,
 * re-check with the core checker, one retry with feedback. It reports, per model:
 * success rate (first try and after the retry), calls, input/output tokens, latency,
 * and cost (Workers AI neurons at USD 0.011 per 1,000).
 *
 * Written in TypeScript (not Ruby) because it imports the agent's own TypeScript
 * modules, so the prompt measured is the prompt shipped. Node 24 runs it directly.
 *
 * Usage:
 *   node scripts/bench_specifiers.ts --repo /path/to/a/hono/clone \
 *     --models @cf/moonshotai/kimi-k2.7-code,@cf/zai-org/glm-5.3-flash --n 20 [--seed 7] \
 *     [--concurrency 5] [--out results.jsonl] [--dry]
 *
 * Auth: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, else wrangler's OAuth login
 * (~/Library/Preferences/.wrangler/config/default.toml) and `wrangler whoami`'s account.
 * The repository clone is only read (git ls-files and file reads). Tokens are never printed.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkFile } from "@fire_trident/core";
import type { Rule } from "@fire_trident/core";
import { TreeIndex, applySpecifierEdits, parseSpecifierEdits, specifierFacts } from "../packages/worker/src/agents/context.ts";
import { modelOptions } from "../packages/worker/src/agents/llm.ts";
import { buildSpecifierMessages, extractFinishReason, extractModelText, extractUsage, specifierRetryMessages } from "../packages/worker/src/agents/prompt.ts";
import type { ChatMessage } from "../packages/worker/src/agents/prompt.ts";

const MAX_TOKENS = 8_192;
const USD_PER_NEURON = 0.011 / 1000;

/** The Hono video rule (demo/CANDIDATES.md), forbid-import form. */
export const HONO_RULE: Rule = {
  id: "rul_bench",
  colonyId: "bench",
  kind: "forbid-import",
  spec: {
    from: ["src/**/*.ts", "src/**/*.tsx"],
    module: "^\\.\\.?(?:/.*)?(?<!\\.ts|\\.tsx|\\.json)$",
    hint: 'Name the file in every relative import: ./x becomes ./x.ts when x.ts exists; a directory ./d becomes ./d/index.ts (".", ".." and "../.." are directories). Check the tree. Change nothing else.',
  },
  description: "Relative imports in src name their file, so Hono runs on Deno, JSR and Node built-in TypeScript without the unstable sloppy-imports flag.",
  approvedBy: "bench",
  createdAt: 0,
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
}

function auth(): { token: string; account: string } {
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (envToken && envAccount) return { token: envToken, account: envAccount };
  const cfg = join(homedir(), "Library/Preferences/.wrangler/config/default.toml");
  if (!existsSync(cfg)) throw new Error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or log in with wrangler");
  const m = /^oauth_token\s*=\s*"([^"]+)"/m.exec(readFileSync(cfg, "utf8"));
  if (!m) throw new Error("no oauth_token in the wrangler config; run `npx wrangler login`");
  const account = envAccount ?? (/([0-9a-f]{32})/.exec(execFileSync("npx", ["wrangler", "whoami"], { cwd: join(import.meta.dirname, "../packages/worker"), encoding: "utf8" }))?.[1] ?? "");
  if (!account) throw new Error("could not find the account id; set CLOUDFLARE_ACCOUNT_ID");
  // whoami refreshes the OAuth token if it expired; read it again.
  const fresh = /^oauth_token\s*=\s*"([^"]+)"/m.exec(readFileSync(cfg, "utf8"))?.[1] ?? m[1]!;
  return { token: fresh, account };
}

/** Seeded shuffle (mulberry32) so both models get the same sample. */
function shuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface CallResult {
  text: string;
  finish?: string;
  input: number;
  output: number;
  neurons: number;
  ms: number;
}

async function callModel(a: { token: string; account: string }, model: string, messages: ChatMessage[]): Promise<CallResult> {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${a.account}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messages, max_tokens: MAX_TOKENS, ...modelOptions(model) }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown; errors?: unknown } | null;
    if (res.ok && body?.success) {
      const r = body.result;
      const u = extractUsage(r);
      const finish = extractFinishReason(r);
      return { text: extractModelText(r) ?? "", ...(finish ? { finish } : {}), input: u?.input ?? 0, output: u?.output ?? 0, neurons: u?.neurons ?? 0, ms: Date.now() - t0 };
    }
    if (attempt >= 2 || (res.status !== 429 && res.status < 500)) throw new Error(`model ${model}: HTTP ${res.status} ${JSON.stringify(body?.errors ?? "").slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
  }
}

interface Sample {
  path: string;
  content: string;
  violations: number;
  directoryImports: number;
}

interface Outcome {
  model: string;
  path: string;
  violations: number;
  directoryImports: number;
  ok: boolean;
  firstTry: boolean;
  calls: number;
  input: number;
  output: number;
  neurons: number;
  ms: number;
  problem?: string;
}

async function runOne(a: { token: string; account: string }, model: string, s: Sample, tree: TreeIndex): Promise<Outcome> {
  const rule = HONO_RULE;
  const facts = specifierFacts(rule, s.path, s.content, tree);
  const first = buildSpecifierMessages({ intent: { id: "int_bench", title: `${rule.description} in ${s.path}`, why: "", acceptance: [] }, rule, path: s.path, content: s.content, facts, tree });
  let messages = first;
  const out: Outcome = { model, path: s.path, violations: s.violations, directoryImports: s.directoryImports, ok: false, firstTry: false, calls: 0, input: 0, output: 0, neurons: 0, ms: 0 };
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: CallResult;
    try {
      r = await callModel(a, model, messages);
    } catch (e) {
      out.problem = (e as Error).message;
      return out;
    }
    out.calls++;
    out.input += r.input;
    out.output += r.output;
    out.neurons += r.neurons;
    out.ms += r.ms;
    const parsed = parseSpecifierEdits(r.text);
    if (!parsed.ok) {
      problems = [r.finish === "length" ? "the reply was cut off before </edits>; reply with only the <edits> block" : parsed.reason];
    } else {
      const applied = applySpecifierEdits(rule, s.path, s.content, facts, parsed.edits, tree);
      if (applied.problems.length === 0 && checkFile(rule, s.path, applied.content).length === 0) {
        out.ok = true;
        out.firstTry = attempt === 0;
        return out;
      }
      problems = applied.problems;
    }
    messages = specifierRetryMessages(first, r.text, problems);
  }
  out.problem = problems.join("; ").slice(0, 400);
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function main(): Promise<void> {
  const repo = (arg("repo") ?? "").replace(/^~/, homedir());
  if (!repo || !existsSync(join(repo, ".git"))) throw new Error("--repo must point at a git clone");
  const models = (arg("models", "@cf/moonshotai/kimi-k2.7-code,@cf/zai-org/glm-5.3-flash") ?? "").split(",").filter(Boolean);
  const n = Number(arg("n", "20"));
  const seed = Number(arg("seed", "7"));
  const conc = Number(arg("concurrency", "5"));
  const outFile = arg("out");
  const dry = arg("dry") === "true";

  const files = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  const tree = new TreeIndex(files);
  const violating: Sample[] = [];
  for (const path of files) {
    if (!/\.(ts|tsx)$/.test(path) || !path.startsWith("src/")) continue;
    const content = readFileSync(join(repo, path), "utf8");
    const v = checkFile(HONO_RULE, path, content);
    if (v.length === 0) continue;
    const facts = specifierFacts(HONO_RULE, path, content, tree);
    violating.push({ path, content, violations: v.length, directoryImports: facts.filter((f) => f.directory).length });
  }
  // Half the sample from files with a directory import (the hard case), half from the rest.
  const hard = shuffle(violating.filter((s) => s.directoryImports > 0), seed);
  const easy = shuffle(violating.filter((s) => s.directoryImports === 0), seed);
  const sample = [...hard.slice(0, Math.ceil(n / 2)), ...easy.slice(0, n - Math.min(hard.length, Math.ceil(n / 2)))].slice(0, n);
  const totalViolations = violating.reduce((x, s) => x + s.violations, 0);
  console.log(`repo: ${violating.length} violating files, ${totalViolations} violations; ${hard.length} files with directory imports`);
  console.log(`sample: ${sample.length} files, ${sample.reduce((x, s) => x + s.violations, 0)} violations, ${sample.filter((s) => s.directoryImports > 0).length} with directory imports`);
  if (dry) {
    const s = sample[0]!;
    const facts = specifierFacts(HONO_RULE, s.path, s.content, tree);
    const msgs = buildSpecifierMessages({ intent: { id: "int", title: `${HONO_RULE.description} in ${s.path}`, why: "", acceptance: [] }, rule: HONO_RULE, path: s.path, content: s.content, facts, tree });
    for (const m of msgs) console.log(`--- ${m.role}\n${m.content}`);
    return;
  }
  const a = auth();
  for (const model of models) {
    const t0 = Date.now();
    const results = await pool(sample, conc, (s) => runOne(a, model, s, tree));
    if (outFile) for (const r of results) appendFileSync(outFile, `${JSON.stringify(r)}\n`);
    const ok = results.filter((r) => r.ok);
    const usd = results.reduce((x, r) => x + r.neurons, 0) * USD_PER_NEURON;
    const ms = results.map((r) => r.ms);
    console.log(
      `\n${model}: ${ok.length}/${results.length} succeeded (${results.filter((r) => r.firstTry).length} on the first try), ` +
        `${(results.reduce((x, r) => x + r.calls, 0) / results.length).toFixed(2)} calls/intent, ` +
        `tokens/intent ${Math.round(results.reduce((x, r) => x + r.input, 0) / results.length)} in / ${Math.round(results.reduce((x, r) => x + r.output, 0) / results.length)} out, ` +
        `latency/intent p50 ${(pct(ms, 50) / 1000).toFixed(1)} s, p90 ${(pct(ms, 90) / 1000).toFixed(1)} s, ` +
        `cost $${usd.toFixed(4)} total ($${(usd / results.length).toFixed(5)}/intent), wall ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
    for (const r of results.filter((x) => !x.ok)) console.log(`  failed ${r.path}: ${r.problem}`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String((e as Error).message ?? e).replace(/art_v\d+_[A-Za-z0-9._~+/=-]+/g, "<redacted>"));
    process.exitCode = 1;
  });
}
