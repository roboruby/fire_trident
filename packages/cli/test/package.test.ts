import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { proposal, removeAll, trunkRepo } from "./trunk-repo.ts";

/**
 * The npm package `fire_trident` (packages/cli) is published without @fire_trident/core, which is private and not on
 * the registry. What it ships (dist, which tsconfig.build.json compiles from src, plus the other `files`) may import
 * only its own files and Node's built-in modules, and core only for types, through a top-level `import type` or
 * `export type` that the build erases (under verbatimModuleSyntax, `import { type X }` still loads the module). What the
 * CLI needs from core at run time is copied by scripts/vendor_cli.rb: src/answerable.ts, connect.ts, pricing.ts and testdelta.ts. The last test builds the package
 * as `npm pack` does and runs it from a directory with no workspace.
 */

const PKG = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { version: string; bin: Record<string, string>; files: string[]; dependencies?: Record<string, string> };
const build = JSON.parse(readFileSync(join(PKG, "tsconfig.build.json"), "utf8")) as { include: string[]; compilerOptions: { rootDir: string; outDir: string } };
const CORE = "@fire_trident/core";

/** The directories the build compiles, absolute. */
const included = build.include.map((d) => resolve(PKG, d));

/** Every .ts file under `dir`. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : name.endsWith(".ts") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Each module one file imports or re-exports (statically, dynamically or with require): its line and whether only types come. */
function imports(text: string): Array<{ line: number; spec: string; typeOnly: boolean }> {
  const found: Array<{ line: number; spec: string; typeOnly: boolean }> = [];
  const lineOf = (at: number): number => text.slice(0, at).split("\n").length;
  // A statement that starts a line (or follows a semicolon): import or export, maybe `type`, a clause of names, then from.
  for (const m of text.matchAll(/(?:^|[;\n])[ \t]*(import|export)[ \t]+(type[ \t]+)?(?:[\w$\s{},*]*?\s*from\s*)?(["'])([^"'\n]+)\3/g)) {
    found.push({ line: lineOf(m.index + m[0].indexOf(m[1]!)), spec: m[4]!, typeOnly: m[2] !== undefined });
  }
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*(["'])([^"'\n]+)\1/g)) found.push({ line: lineOf(m.index), spec: m[2]!, typeOnly: false });
  return found.sort((a, b) => a.line - b.line);
}

/** What is wrong with one shipped file's imports, as `file:line: problem`. */
function problems(file: string): string[] {
  const name = relative(PKG, file);
  return imports(readFileSync(file, "utf8")).flatMap(({ line, spec, typeOnly }) => {
    if (spec.startsWith("node:")) return [];
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec);
      return included.some((d) => target === d || target.startsWith(`${d}${sep}`)) ? [] : [`${name}:${line}: imports ${spec}, which the package does not ship`];
    }
    if (spec === CORE) return typeOnly ? [] : [`${name}:${line}: imports ${CORE} for more than types, and the published package has no core: use a type-only import, or copy the function into the CLI`];
    return [`${name}:${line}: imports ${spec}, a package the published CLI does not depend on`];
  });
}

const temporary: string[] = [];
afterAll(() => {
  removeAll();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the published package", () => {
  it("depends on nothing, and ships its build and no sources", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.files).toContain(build.compilerOptions.outDir);
    expect(pkg.files.filter((f) => f === "src" || f === "test" || f.endsWith(".ts"))).toEqual([]);
    for (const bin of Object.values(pkg.bin)) expect(bin.startsWith(`${build.compilerOptions.outDir}/`), bin).toBe(true);
  });

  it("imports only its own files, Node's modules, and core's types, in every file it ships", () => {
    const files = included.flatMap(walk);
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap(problems)).toEqual([]);
  });

  it("finds a value import of core, an import { type } and a package import (the check is not blind)", () => {
    const scanned = imports(['import type { A } from "@fire_trident/core";', 'import { b, type C } from "@fire_trident/core";', "import {", "  type D,", '} from "@fire_trident/core";', 'export type { E } from "@fire_trident/core";', 'const z = await import("@fire_trident/core");', 'import "zod";'].join("\n"));
    expect(scanned).toEqual([
      { line: 1, spec: CORE, typeOnly: true },
      { line: 2, spec: CORE, typeOnly: false },
      { line: 3, spec: CORE, typeOnly: false },
      { line: 6, spec: CORE, typeOnly: true },
      { line: 7, spec: CORE, typeOnly: false },
      { line: 8, spec: "zod", typeOnly: false },
    ]);
  });

  // scripts/vendor_cli.rb writes these copies: a first comment line, then core's module with its type imports naming core.
  for (const name of ["answerable", "connect", "pricing", "testdelta"]) {
    it(`carries core's ${name}.ts as it is`, () => {
      const core = readFileSync(join(PKG, `../core/src/${name}.ts`), "utf8");
      const copy = readFileSync(join(PKG, `src/${name}.ts`), "utf8");
      const body = copy.slice(copy.indexOf("\n") + 1).replaceAll(`from "${CORE}";`, 'from "./types.ts";');
      expect(body, `packages/core/src/${name}.ts changed: run ruby scripts/vendor_cli.rb`).toBe(core);
    });
  }

  it("builds as npm pack builds it and runs from a directory with no workspace: --version, and ft verify on a clone", async () => {
    const out = mkdtempSync(join(tmpdir(), "ft-pack-"));
    temporary.push(out);
    const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", join(PKG, "tsconfig.build.json"), "--outDir", join(out, build.compilerOptions.outDir)], { stdio: "pipe" });
    for (const f of [...pkg.files.filter((f) => f !== build.compilerOptions.outDir), "package.json"]) cpSync(join(PKG, f), join(out, f), { recursive: true });
    for (const js of readdirSync(join(out, build.compilerOptions.outDir))) {
      expect(readFileSync(join(out, build.compilerOptions.outDir, js), "utf8"), js).not.toMatch(/["']@fire_trident\//);
    }
    const env = { PATH: process.env.PATH ?? "", HOME: out, NO_COLOR: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const ft = (args: string[]) => spawnSync(process.execPath, [join(out, pkg.bin.ft!), ...args], { cwd: out, env, encoding: "utf8" });

    const version = ft(["--version"]);
    expect(version.stderr).toBe("");
    expect(version).toMatchObject({ status: 0, stdout: `${pkg.version}\n` });

    // One landing a person approved, checked offline: the copied answerable functions say who answers for it.
    const repo = trunkRepo();
    repo.plain({ "README.md": "# demo\n" }, "Initial commit\n");
    const text = "export const a = 1;\n";
    await repo.landing({ "src/a.ts": text }, { landingId: "lnd_1", proposals: [proposal({ id: "prp_1", writeSet: [{ path: "src/a.ts", blob: repo.blob(text) }], decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "matt" }] })] });
    const verified = ft(["verify", "--dir", repo.dir]);
    expect(verified.stderr).toBe("");
    expect(verified).toMatchObject({ status: 0, stdout: "intact\nanswerable: matt (approved this change)\n" });
  }, 60_000);
});
