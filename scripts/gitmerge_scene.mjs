#!/usr/bin/env node
// "Git would have merged this": the data of the fifth scene of the landing page's Try panel
// (packages/web/src/landing/gitmerge.ts), computed rather than written by hand.
//
// Two agents start from one trunk. Agent A renames formatPrice to formatAmount in src/price.ts and updates its two
// callers. Agent B, from the same trunk, reads src/price.ts and adds src/receipt.ts, which calls formatPrice (the
// catch); in its twin, B reads src/date.ts and calls formatDate, which nobody touched (the control). For each twin the
// script builds a git repository in a temporary directory with stock git, merges A and then B into trunk (git merge),
// records whether the merge was clean and runs the merged program (node src/main.ts). Then it decides the same two
// changes in landing order as the trunk writer does, with the core's read-set validation (packages/core/src/occ.ts
// validateProposal) over git's own blob ids, lands what passes on a second branch, and runs the program there too. A
// change that goes back names the landing that moved a file it read (the newest commit on that branch to change the
// file since the change's base) and quotes that landing's diff of the file, rendered and cut by the trunk writer's own
// code (decide/diff.ts as trunk/quote.ts calls it, colony/hunks.ts).
//
//   node scripts/gitmerge_scene.mjs           write packages/web/src/landing/gitmerge.json
//   node scripts/gitmerge_scene.mjs --check   exit 1 when that file is not what the script computes now
//
// Needs git and a Node that runs TypeScript files (type stripping, Node 22.18 or later). Nothing it writes names the
// temporary directory. packages/web/test/try-gitmerge.test.ts fails when the JSON is stale.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const main = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!process.features?.typescript) {
  const why = "this Node does not run TypeScript files (type stripping): use Node 22.18 or later";
  if (main) {
    console.error(why);
    process.exit(2);
  }
  throw new Error(why);
}
const { blobId, textMergeCandidate, validateProposal } = await import("../packages/core/src/index.ts");
const { HUNK_LINES, HUNK_PATHS, cutDiff, firstLines } = await import("../packages/worker/src/colony/hunks.ts");
const { diffLines, renderHunks, splitLines } = await import("../packages/worker/src/decide/diff.ts");

/** Where the scene reads its data. */
export const OUT = fileURLToPath(new URL("../packages/web/src/landing/gitmerge.json", import.meta.url));

/** A file's text from its lines. */
const text = (...lines) => `${lines.join("\n")}\n`;

/** src/price.ts with its one function named `name`. */
const price = (name) => text("/** Cents as the shop prints them: 450 is $4.50. */", `export function ${name}(cents: number): string {`, "  return `$${(cents / 100).toFixed(2)}`;", "}");

/** The two callers of the price function, calling it by `name`. */
const cart = (name) =>
  text(`import { ${name} } from "./price.ts";`, "", "/** One line of the cart: the item and its price. */", "export function cartLine(item: string, cents: number): string {", `  return \`\${item}: \${${name}(cents)}\`;`, "}");
const invoice = (name) => text(`import { ${name} } from "./price.ts";`, "", "/** The last line of an invoice. */", "export function invoiceTotal(cents: number): string {", `  return \`Total due: \${${name}(cents)}\`;`, "}");

/** src/main.ts, the program: the base's two lines, then B's receipt line when it has one (its import and its call). */
const program = (receipt) =>
  text(
    'import { cartLine } from "./cart.ts";',
    'import { invoiceTotal } from "./invoice.ts";',
    ...(receipt ? ['import { receipt } from "./receipt.ts";'] : []),
    "",
    'console.log(cartLine("Tea", 450));',
    "console.log(invoiceTotal(1250));",
    ...(receipt ? [`console.log(receipt(${receipt}));`] : []),
  );

/** The trunk both agents start from. */
const BASE = {
  "package.json": text("{", '  "name": "shop",', '  "private": true,', '  "type": "module",', '  "scripts": { "start": "node src/main.ts" }', "}"),
  "src/cart.ts": cart("formatPrice"),
  "src/date.ts": text("/** A date as the shop prints it: 2026-10-21. */", "export function formatDate(date: Date): string {", "  return date.toISOString().slice(0, 10);", "}"),
  "src/invoice.ts": invoice("formatPrice"),
  "src/main.ts": program(null),
  "src/price.ts": price("formatPrice"),
};

/** Agent A: the rename, with both callers updated. It read the three files it rewrites. The file that matters comes first. */
const A = {
  branch: "agent-a",
  title: "Rename formatPrice to formatAmount",
  read: ["src/cart.ts", "src/invoice.ts", "src/price.ts"],
  writes: { "src/price.ts": price("formatAmount"), "src/cart.ts": cart("formatAmount"), "src/invoice.ts": invoice("formatAmount") },
};

/**
 * Agent B in each twin: a receipt line in a new file (first), printed by the program. It read the file it calls and the
 * program it edits.
 */
const TWINS = [
  {
    id: "catch",
    label: "B calls the renamed function",
    b: {
      branch: "agent-b",
      title: "Print a receipt line with the price",
      read: ["src/main.ts", "src/price.ts"],
      writes: {
        "src/receipt.ts": text('import { formatPrice } from "./price.ts";', "", "/** The receipt line of one item: what it is and what it cost. */", "export function receipt(item: string, cents: number): string {", "  return `Receipt: ${item}, ${formatPrice(cents)}`;", "}"),
        "src/main.ts": program('"Tea", 450'),
      },
    },
  },
  {
    id: "control",
    label: "B calls an untouched function",
    b: {
      branch: "agent-b",
      title: "Print a receipt line with the date",
      read: ["src/date.ts", "src/main.ts"],
      writes: {
        "src/receipt.ts": text('import { formatDate } from "./date.ts";', "", "/** The receipt line of one item: what it is and when it was sold. */", "export function receipt(item: string, date: Date): string {", "  return `Receipt: ${item}, ${formatDate(date)}`;", "}"),
        "src/main.ts": program('"Tea", new Date(Date.UTC(2026, 9, 21))'),
      },
    },
  },
];

/** Fixed people and times, so every commit id is the same on every run. */
const T0 = 1_792_573_200;
const BASE_WHO = { name: "Shop", email: "shop@example.com" };
const A_WHO = { name: "Agent A", email: "agent-a@example.com" };
const B_WHO = { name: "Agent B", email: "agent-b@example.com" };
const TRUNK_WHO = { name: "Trunk writer", email: "trunk@example.com" };
const RUN = "node src/main.ts";

/** Stock git in `dir`, with no user or system configuration, as `who` at `at` (seconds). */
function gitIn(dir) {
  const env = (who, at) => ({
    PATH: process.env.PATH ?? "",
    HOME: dir,
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_AUTHOR_DATE: `@${at} +0000`,
    GIT_COMMITTER_NAME: (who.committer ?? who).name,
    GIT_COMMITTER_EMAIL: (who.committer ?? who).email,
    GIT_COMMITTER_DATE: `@${at} +0000`,
  });
  const run = (args, who = BASE_WHO, at = T0) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: env(who, at) });
  const out = (args, who, at) => {
    const r = run(args, who, at);
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };
  return { run, out, lines: (args) => out(args).split("\n").filter((l) => l !== "") };
}

/** Write each file (its directories made), and commit them all. */
function commit(dir, git, files, message, who, at) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git.out(["add", "-A"]);
  git.out(["commit", "-q", "-m", message], who, at);
  return git.out(["rev-parse", "HEAD"]).trim();
}

/** Every file of a commit and its blob id, as git stores them. */
function tree(git, ref) {
  const out = new Map();
  for (const line of git.lines(["ls-tree", "-r", ref])) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** A file's text at a commit, or "" when it is absent there. */
function show(git, ref, path) {
  const r = git.run(["show", `${ref}:${path}`]);
  return r.status === 0 ? r.stdout : "";
}

/** Run the program in the checked-out tree: whether it exited 0, what it printed, and its error and where it was raised. */
function runProgram(dir) {
  const r = spawnSync(process.execPath, ["--no-warnings", "src/main.ts"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 30_000 });
  if (r.error) throw r.error;
  // Node names the file that failed by its URL: keep the path inside the repository only.
  const err = (r.stderr ?? "").replaceAll(`${pathToFileURL(dir).href}/`, "").replaceAll(`${dir}/`, "");
  const error = /^(\w*Error): (.+)$/m.exec(err);
  const at = /^(src\/[\w./-]+:\d+)$/m.exec(err);
  return { command: RUN, ok: r.status === 0, exit: r.status, stdout: r.stdout, error: error ? `${error[1]}: ${error[2]}` : null, at: at ? at[1] : null };
}

/** The trunk writer's diff of one file, before to after (decide/diff.ts: unified hunks, two lines of context), uncut. */
const hunks = (before, after) => renderHunks(diffLines(splitLines(before), splitLines(after)), 2);

/** A change's diffs of the files it changed that the base has (a new file is shown whole). */
function diffsOf(change) {
  return Object.fromEntries(Object.entries(change.writes).filter(([path]) => BASE[path] !== undefined).map(([path, body]) => [path, hunks(BASE[path], body)]));
}

/** The paths two commits differ in. */
const changed = (git, from, to) => git.lines(["diff", "--name-only", from, to]);

/** One twin, run with stock git and decided as the trunk writer decides it. */
function twin(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ft-gitmerge-")));
  try {
    const git = gitIn(dir);
    git.out(["init", "-q", "--object-format=sha1", "-b", "trunk", "."]);
    const base = commit(dir, git, BASE, "Start the shop", BASE_WHO, T0);
    git.out(["checkout", "-q", "-b", A.branch]);
    commit(dir, git, A.writes, A.title, A_WHO, T0 + 300);
    git.out(["checkout", "-q", "-b", t.b.branch, base]);
    commit(dir, git, t.b.writes, t.b.title, B_WHO, T0 + 360);

    // Core's blob ids are git's: the scene computes them from the texts in the browser.
    for (const [path, blob] of [...tree(git, base), ...tree(git, A.branch), ...tree(git, t.b.branch)]) {
      if (blobId(git.out(["cat-file", "-p", blob])) !== blob) throw new Error(`core blobId disagrees with git on ${path}`);
    }

    // Stock git: A merges first (a fast-forward), then B by a three-way merge, and the merged program runs.
    git.out(["checkout", "-q", "trunk"]);
    git.out(["merge", "-q", "--ff-only", A.branch]);
    const merge = git.run(["merge", "-q", "--no-edit", "-m", `Merge ${t.b.branch}`, t.b.branch], B_WHO, T0 + 600);
    const conflicts = git.lines(["diff", "--name-only", "--diff-filter=U"]);
    const clean = merge.status === 0 && conflicts.length === 0;
    const aFiles = changed(git, base, A.branch);
    const bFiles = changed(git, base, t.b.branch);
    const gitRun = clean ? runProgram(dir) : null;
    if (!clean) git.run(["merge", "--abort"]);

    // FireTrident: the same two changes in landing order, each checked by read-set validation against the trunk it
    // would land on (the blob of every file it read, and of every file it writes as its base had it, still there).
    // Import-name revalidation is off in production (FT_REVALIDATE), so a change stale through a file it read goes back.
    git.out(["checkout", "-q", "-B", "firetrident", base]);
    const baseTree = tree(git, base);
    let at = T0 + 600;
    const decide = (change, who) => {
      const own = tree(git, change.branch);
      const p = { readSet: change.read.map((path) => ({ path, blob: baseTree.get(path) ?? null })), writeSet: Object.keys(change.writes).map((path) => ({ path, blob: own.get(path) ?? null })) };
      const baseBlobs = Object.keys(change.writes).map((path) => ({ path, blob: baseTree.get(path) ?? null }));
      const now = tree(git, "firetrident");
      const occ = validateProposal(p, (path) => now.get(path) ?? null, baseBlobs);
      const textMerge = occ.eligible ? null : textMergeCandidate(p, occ.stale);
      if (textMerge) throw new Error("this scene does not model a text merge: keep B stale only through a file it read");
      at += 60;
      const landed = occ.eligible ? commit(dir, git, change.writes, change.title, { ...who, committer: TRUNK_WHO }, at) : null;
      return { eligible: occ.eligible, stale: occ.stale, textMerge, commit: landed };
    };
    const a = decide(A, A_WHO);
    const b = decide(t.b, B_WHO);

    // What moved each stale file: the newest landing since B's base to change it, and that landing's diff of the file,
    // as the trunk writer quotes it (cut to HUNK_LINES lines). Masking is left to the scene test, which runs the trunk
    // writer's own quote (trunk/quote.ts) on the same landing and requires the same text.
    const moved = [];
    for (const s of b.stale) {
      const by = git.lines(["log", "-1", "--format=%H", `${base}..firetrident`, "--", s.path])[0];
      if (!by) continue;
      let entry = moved.find((m) => m.commit === by);
      if (!entry) {
        entry = { commit: by, change: by === a.commit ? "a" : null, paths: [] };
        moved.push(entry);
      }
      entry.paths.push(s.path);
    }
    const quoted = moved.flatMap((m) =>
      m.paths.slice(0, HUNK_PATHS).map((path) => {
        const full = hunks(show(git, `${m.commit}^`, path), show(git, m.commit, path));
        const cut = cutDiff(firstLines(full, HUNK_LINES), HUNK_LINES, full.split("\n", HUNK_LINES + 1).length > HUNK_LINES);
        return { commit: m.commit, path, diff: cut.diff, truncated: cut.truncated };
      }),
    );
    const ftRun = runProgram(dir);

    return {
      id: t.id,
      label: t.label,
      b: { ...t.b, diffs: diffsOf(t.b) },
      git: { a: aFiles, b: bFiles, both: aFiles.filter((p) => bFiles.includes(p)), clean, conflicts, run: gitRun },
      fireTrident: { a, b, moved, quoted, run: ftRun },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The scene's data: the base, agent A's change, and each twin's B with what git and FireTrident made of the pair. */
export function buildScene() {
  return {
    about: "Computed by scripts/gitmerge_scene.mjs with stock git and the core's read-set validation; run it again rather than editing this file.",
    base: { files: BASE },
    a: { ...A, diffs: diffsOf(A) },
    twins: TWINS.map(twin),
  };
}

/** The scene's data as the JSON file holds it. */
export function sceneJson() {
  const json = `${JSON.stringify(buildScene(), null, 2)}\n`;
  if (json.includes(tmpdir()) || /\/(?:private|var|tmp)\//.test(json)) throw new Error("the scene's data names a local path");
  return json;
}

if (main) {
  const json = sceneJson();
  if (process.argv.includes("--check")) {
    let now = "";
    try {
      now = readFileSync(OUT, "utf8");
    } catch {}
    if (now !== json) {
      console.error("packages/web/src/landing/gitmerge.json is stale: run node scripts/gitmerge_scene.mjs");
      process.exit(1);
    }
    console.log("packages/web/src/landing/gitmerge.json is current");
  } else {
    writeFileSync(OUT, json);
    console.log("wrote packages/web/src/landing/gitmerge.json");
  }
}
