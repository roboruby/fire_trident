/**
 * Results of contention-scale runs: one JSON file and one run log per run, both through the evidence redaction
 * (evidence.ts), and a README.md labeled MEASURED rebuilt from every run's JSON in the directory, so a day's 200-agent
 * and 1,000-agent runs share one page.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactDeep, redactEvidence } from "../evidence.ts";
import type { ContentionReport, ReturnCause } from "./run.ts";
import { hotPath, modulePath } from "./workload.ts";

/** The repository root, so paths under it are written relative to it. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The default results directory for a run started on `date` (YYYY-MM-DD). */
export function resultsDir(date: string): string {
  return join(REPO_ROOT, "packages", "bench", "results", `${date}-contention-scale`);
}

/** Arrays written one element a line: a long run has thousands of tasks and seconds. */
const LINE_ARRAYS: ReadonlySet<string> = new Set(["tasks", "timeline", "perCounter", "peakPerHot"]);

/** JSON indented by two spaces, except that the arrays under `keys` keep each element on one line. */
export function compactJson(value: unknown, keys: ReadonlySet<string>): string {
  const walk = (v: unknown, pad: string, key: string | null): string => {
    const inner = `${pad}  `;
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const items = key !== null && keys.has(key) ? v.map((x) => JSON.stringify(x)) : v.map((x) => walk(x, inner, null));
      return `[\n${items.map((s) => `${inner}${s}`).join(",\n")}\n${pad}]`;
    }
    if (v && typeof v === "object") {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (entries.length === 0) return "{}";
      return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${walk(x, inner, k)}`).join(",\n")}\n${pad}}`;
    }
    return JSON.stringify(v) ?? "null";
  };
  return walk(value, "", null);
}

/** A report as written: the command that made it, beside the numbers. */
export type WrittenReport = ContentionReport & { command: string; runNote?: string };

/** Write one run's JSON and log (redacted), then rebuild the directory's README from every run in it. Returns the paths written. */
export function writeResults(dir: string, report: WrittenReport, log: string, secrets: readonly string[] = []): string[] {
  mkdirSync(dir, { recursive: true });
  const scrub = (text: string): string => redactEvidence(secrets.reduce((s, x) => (x.length >= 4 ? s.split(x).join("<redacted>") : s), text), { repoRoot: REPO_ROOT });
  const n = report.options.agents;
  const json = join(dir, `contention-scale-n${n}.json`);
  const logPath = join(dir, `run-n${n}.log`);
  writeFileSync(json, `${scrub(compactJson(redactDeep(report, { repoRoot: REPO_ROOT }), LINE_ARRAYS))}\n`);
  writeFileSync(logPath, scrub(log));
  const reports = readdirSync(dir)
    .filter((f) => /^contention-scale-n\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as WrittenReport)
    .sort((a, b) => a.options.agents - b.options.agents);
  const readme = join(dir, "README.md");
  writeFileSync(readme, scrub(readmeText(reports)));
  return [readme, json, logPath];
}

const num = (n: number | null | undefined, digits = 0): string => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "n/a");
const secs = (ms: number | null | undefined): string => (typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "n/a");
const CAUSES: Array<[ReturnCause, string]> = [
  ["stale-read", "… for a stale read (a file it read had moved)"],
  ["merge-conflict", "… for a text-merge conflict"],
  ["review", "… sent back by review"],
  ["megafile-hold", "… for a megafile hold"],
  ["other", "… for any other reason"],
];

/** The README for these runs (fewest agents first). */
export function readmeText(runs: readonly WrittenReport[]): string {
  if (runs.length === 0) return "# Contention at scale\n\nNo runs.\n";
  const first = runs[0]!;
  const date = first.startedAt.slice(0, 10);
  const host = (() => {
    try {
      return new URL(first.url).host;
    } catch {
      return first.url;
    }
  })();
  const o = first.options;
  const head = runs.map((r) => `${num(r.options.agents)} agents`);
  const row = (label: string, f: (r: WrittenReport) => string): string => `| ${label} | ${runs.map(f).join(" | ")} |`;
  const table = (rows: string[]): string[] => [`| Measure | ${head.join(" | ")} |`, `| --- | ${runs.map(() => "---").join(" | ")} |`, ...rows];
  const out: string[] = [
    `# Contention at scale (${date})`,
    "",
    "<!-- measured -->",
    `MEASURED on ${host} (build ${first.build ?? "unknown"}), ${date}: what happens when hundreds of agents edit the same files at the same time, with every result checked against the final trunk afterwards.`,
    "",
    first.note.replace(/^MEASURED, real landings: /, "Real landings: "),
    "",
    "## The workload",
    "",
    `A generated TypeScript repository seeded into a fresh colony per run: ${num(o.hot)} hot files (\`${hotPath(0)}\` and so on: a registry of ${num(o.registry)} names, one a line, ${num(o.counters)} counters and three functions each) and ${num(o.modules)} modules (\`${modulePath(0, o.modules)}\` and so on, one constant per hot file each)${o.certTest ? ", with a `node:test` file that imports every file and asserts no registry holds a name twice" : ""}. Seed ${o.seed}. The tasks, mixed and shuffled:`,
    "",
    "- **register**: insert one new name into a hot file's registry where it sorts, so concurrent inserts land on nearby lines. Correct: every landed name appears exactly once.",
    "- **increment**: add exactly 1 to one counter of a hot file (read the value, write it plus one). Two increments of one counter cannot both apply to the same base. Correct: each counter equals the increments that landed on it; a lost update (two landed, the value rose by one) fails the run.",
    "- **read-own**: read a hot file and write only the task's own module, copying the registry's length into a constant. Such a change may land only if what it read is still current. Correct: the constant equals the registry's length on the trunk its landing was built on.",
    "",
    "Each intent is declared already claimed by the agent that does it (`assignedTo`), so hundreds of agents hold intents on the same hot file at once. The agent takes it (a lease on the current trunk), reads the files at the lease's base with stock git, makes the edit and proposes it as an inline change whose read set is what it read. When the change comes back it declares the same work again with itself, takes it on a fresh lease of the current trunk, reads again and redoes the edit. A change closed as already on trunk is not redone, as the agent guides say. Review is off (no model is called).",
    "",
    "## Commands",
    "",
    ...runs.flatMap((r) => ["```", r.command, "```", ""]),
    "## Flags the deployment had",
    "",
    ...runs.map((r) => `- ${num(r.options.agents)} agents (build ${r.build ?? "unknown"}): ${r.flags.length > 0 ? r.flags.map((f) => `\`${f}\``).join(", ") : "none"}`),
    "",
    "`/api/about` lists a flag that is on for every colony or for some listed colonies, without saying which; the run's own numbers below (merges by the insertion rule, returns by cause) show what applied to its colony.",
    ...runs.filter((r) => r.runNote).map((r) => `\nNote for the ${num(r.options.agents)}-agent run: ${r.runNote}`),
    "",
    "## Results",
    "",
    ...table([
      row("Tasks (register / increment / read-own)", (r) => `${num(r.run.tasks)} (${num(r.run.byKind.register)} / ${num(r.run.byKind.increment)} / ${num(r.run.byKind["read-own"])})`),
      row("Agents joined", (r) => num(r.run.agentsJoined)),
      row("Tasks landed", (r) => `${num(r.run.landedTasks)} of ${num(r.run.tasks)}`),
      row("How the rest ended", (r) => Object.entries(r.run.ends).filter(([k]) => k !== "landed").map(([k, v]) => `${k} ${num(v)}`).join(", ") || "none"),
      row("Proposals (landed)", (r) => `${num(r.run.proposals)} (${num(r.run.landedProposals)})`),
      row("Trunk commits whose lineage note names them", (r) => num(r.run.commits)),
      row("Landings a minute (trunk commits), first to last landing", (r) => `${num(r.run.landingsPerMin, 1)}${r.run.timesFrom.git > 0 && r.run.timesFrom.feed === 0 ? " (git commit times)" : ""}`),
      row("Changes landed a minute", (r) => num(r.run.changesPerMin, 1)),
      row("Propose to landed, p50 / p95", (r) => `${secs(r.timeToLandMs.p50)} / ${secs(r.timeToLandP95Ms)}`),
      row("A task's first proposal to landed, rounds included, p50 / p95", (r) => `${secs(r.taskTimeToLandMs.p50)} / ${secs(r.taskTimeToLandP95Ms)}`),
      row("Changes that came back", (r) => num(r.returns.total)),
      ...CAUSES.map(([k, label]) => row(label, (r) => num(r.returns.byCause[k]))),
      row("… register / increment / read-own", (r) => (["register", "increment", "read-own"] as const).map((k) => num(Object.values(r.returns.byKind[k]).reduce((s, n) => s + n, 0))).join(" / ")),
      row("Rounds to land, median / p95 / max", (r) => `${num(r.rounds.median)} / ${num(r.rounds.p95)} / ${num(r.rounds.max)}`),
      row("Changes merged line by line (files; by the insertion rule)", (r) => (r.check ? `${num(r.check.merges.proposals)} (${num(r.check.merges.files)}; ${num(r.check.merges.insertions)})` : "n/a")),
      row("Agents holding an intent at once, peak", (r) => num(r.holders.peak)),
      row("Intents on one hot file held at once, peak", (r) => num(r.holders.peakOneHot)),
      row("Takes that lost their assignment (declared again)", (r) => num(r.takes.lostAssignments)),
      row("Wall time of the agents", (r) => secs(r.run.wallS * 1000)),
    ]),
    "",
    "## Correctness, from the final trunk",
    "",
    "Read with stock git from the colony's trunk after the run: the final tree, main's first-parent history and the lineage notes under `refs/notes/firetrident`, which name the proposals each commit landed.",
    "",
    `| Check | ${head.join(" | ")} |`,
    `| --- | ${runs.map(() => "---").join(" | ")} |`,
    ...checkNames(runs).map((name) => `| ${name} | ${runs.map((r) => cell(r, name)).join(" | ")} |`),
    "",
  ];
  for (const r of runs) {
    out.push(`### ${num(r.options.agents)} agents`, "");
    if (!r.check) {
      out.push(`The check did not run: ${r.checkError ?? "no final trunk"}.`, "");
      continue;
    }
    for (const c of r.check.checks) {
      out.push(`- **${c.ok ? "PASS" : "FAIL"}** ${c.name}: ${c.summary}`);
      for (const f of c.failures) out.push(`  - ${f}`);
    }
    const byFile = new Map<string, string[]>();
    for (const c of r.check.counters.perCounter) byFile.set(c.path, [...(byFile.get(c.path) ?? []), `${c.value ?? "?"}/${c.landed}`]);
    out.push(`- Counters, value/landed increments: ${[...byFile].map(([path, v]) => `\`${path}\` ${v.join(" ")}`).join("; ")}`, "");
  }
  out.push(
    "## Honest limits",
    "",
    "- Synthetic agents make scripted edits with no model and run no tests: this measures the platform's landing path under contention (read-set validation, text merge, group commit, the lineage record), not agents' judgment or review.",
    "- Every intent is placed with its agent (`assignedTo`), which goes past admission and the claim-lease exclusion that normally keep agents from holding intents on the same file at once. The run measures what happens when changes collide, not how often they would collide in normal operation.",
    "- A change that comes back reopens its intent; the agent declares the same work again as a new intent with itself, and the reopened intent is left open with no agent taking it (the colony's intent counts include those).",
    "- Agents read the hot files at their lease's base from a stock git mirror, fetched as the trunk moves; the fetch time adds to the time between take and propose.",
    "- One generated repository shape, one deployment, and every agent run from one machine. Review was off; certification ran as the deployment has it.",
    "- Inside one landing commit, the order the trunk writer applied its proposals is taken from the order of the lineage note.",
    "",
  );
  return `${out.join("\n")}\n`;
}

function checkNames(runs: readonly WrittenReport[]): string[] {
  return [...new Set(runs.flatMap((r) => r.check?.checks.map((c) => c.name) ?? []))];
}

function cell(r: WrittenReport, name: string): string {
  const c = r.check?.checks.find((x) => x.name === name);
  return c ? (c.ok ? "PASS" : "FAIL") : "not run";
}
