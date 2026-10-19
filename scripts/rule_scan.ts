#!/usr/bin/env node
/**
 * Count one rule's violations in a local git clone with the colony's own scan: scanFiles in
 * packages/worker/src/morph/scan.ts (the source files the rule's globs name, at most MAX_SCAN_BYTES each, every one
 * checked by core checkFile), over the files `git ls-files` lists, read as git stores them at HEAD. It prints the clone's
 * commit, the rule, each violating file with its lines, and the totals: the starting count a colony records when the
 * rule is declared on a trunk at that commit.
 *
 * Usage:
 *   node scripts/rule_scan.ts --repo <clone> --colony <id> --rule <rul_...> [--base https://<deployment>]
 *     the rule as GET /api/colonies/<id> lists it (--base, else FT_URL; one GET, no token)
 *   node scripts/rule_scan.ts --repo <clone> --rule-file <rule.json>
 *     a rule as JSON: { "id", "kind", "spec", "description" }
 *
 * The clone is only read. Exits 0 when the scan ran, 1 when the rule cannot be read or checked, 2 on a usage error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Rule } from "@fire_trident/core";
import { MAX_SCAN_BYTES, scanFiles, shouldScan } from "../packages/worker/src/morph/scan.ts";
import type { ScanInput } from "../packages/worker/src/morph/scan.ts";

const usage = "usage: node scripts/rule_scan.ts --repo <clone> (--colony <id> --rule <rul_...> [--base <url>] | --rule-file <rule.json>)";

function git(repo: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...args], { maxBuffer: 256 << 20 });
}

/** The rule from a deployment's colony snapshot (public GET, no token). */
async function remoteRule(base: string, colony: string, ruleId: string): Promise<Rule> {
  const url = `${base.replace(/\/+$/, "")}/api/colonies/${encodeURIComponent(colony)}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const snap = (await res.json()) as { rules?: Rule[] };
  const rule = snap.rules?.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`colony ${colony} lists no rule ${ruleId}`);
  return rule;
}

async function main(): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { repo: { type: "string" }, colony: { type: "string" }, rule: { type: "string" }, base: { type: "string" }, "rule-file": { type: "string" } },
      strict: true,
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
    return 2;
  }
  const repo = values.repo;
  if (!repo || !existsSync(join(repo, ".git"))) {
    console.error(`--repo must name a git clone\n${usage}`);
    return 2;
  }
  let rule: Rule;
  let from: string;
  if (values["rule-file"]) {
    rule = JSON.parse(readFileSync(values["rule-file"], "utf8")) as Rule;
    from = values["rule-file"];
  } else if (values.colony && values.rule) {
    const base = values.base ?? process.env.FT_URL ?? "";
    if (!/^https?:\/\//.test(base)) {
      console.error(`--base or FT_URL must name the deployment\n${usage}`);
      return 2;
    }
    rule = await remoteRule(base, values.colony, values.rule);
    from = `GET ${base.replace(/\/+$/, "")}/api/colonies/${values.colony}`;
  } else {
    console.error(usage);
    return 2;
  }

  const head = git(repo, ["log", "-1", "--format=%H %cI %s", "HEAD"]).toString().trim();
  const origin = (() => {
    try {
      return git(repo, ["remote", "get-url", "origin"]).toString().trim();
    } catch {
      return "(no origin)";
    }
  })();
  const tracked = git(repo, ["ls-files", "-z"]).toString().split("\0").filter(Boolean);
  const files: ScanInput[] = [];
  for (const path of tracked) {
    if (!shouldScan(rule, path)) continue;
    const blob = git(repo, ["cat-file", "blob", `HEAD:${path}`]);
    if (blob.length > MAX_SCAN_BYTES) continue;
    files.push({ path, content: blob.toString("utf8") });
  }
  const violations = scanFiles(rule, files);
  const byFile = new Map<string, number[]>();
  for (const v of violations) byFile.set(v.path, [...(byFile.get(v.path) ?? []), v.line]);

  console.log(`rule: ${rule.id} (${rule.kind}) "${rule.description ?? ""}", from ${from}`);
  console.log(`spec: ${JSON.stringify(rule.spec)}`);
  console.log(`repo: ${origin} at ${head}`);
  console.log(`files: ${tracked.length} tracked, ${files.length} scanned (source files the rule's globs name, at most ${MAX_SCAN_BYTES} bytes)`);
  for (const [path, lines] of byFile) console.log(`${path}: ${lines.length} (line${lines.length === 1 ? "" : "s"} ${lines.join(", ")})`);
  console.log(`total: ${violations.length} violations in ${byFile.size} files`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
