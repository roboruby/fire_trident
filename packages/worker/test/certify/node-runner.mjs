// Node-only helpers for the certification tests (plain JavaScript: the worker's type program has no Node types).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function writeTree(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

/** Run a plan's harness in a fresh Node process and return its report. */
export function runPlanInNode(plan) {
  const dir = mkdtempSync(join(tmpdir(), "ft-certify-plan-"));
  try {
    const files = { "package.json": '{ "type": "module" }\n' };
    for (const [key, m] of Object.entries(plan.modules)) files[key] = "js" in m ? m.js : JSON.stringify(m.json);
    writeTree(dir, files);
    const main = pathToFileURL(join(dir, plan.mainModule)).href;
    const script = `const m = await import(${JSON.stringify(main)}); const r = await m.runAll(); process.stdout.write(JSON.stringify(r));`;
    const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `node --test` on `paths` of a project written from `files`, and parse its summary counts. */
export function nodeTestCounts(files, paths) {
  const dir = mkdtempSync(join(tmpdir(), "ft-certify-node-"));
  try {
    writeTree(dir, { "package.json": '{ "type": "module" }\n', ...files });
    const res = spawnSync(process.execPath, ["--no-warnings", "--test", "--test-reporter=tap", ...paths], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    const output = `${res.stdout}${res.stderr}`;
    const n = (k) => Number(new RegExp(`^# ${k} (\\d+)$`, "m").exec(output)?.[1] ?? Number.NaN);
    return { tests: n("tests"), pass: n("pass"), fail: n("fail"), cancelled: n("cancelled"), skipped: n("skipped"), todo: n("todo"), suites: n("suites"), output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Does this Node run TypeScript files by stripping types (Node 22.18+, 23.6+)? */
export function nodeStripsTypes() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}
