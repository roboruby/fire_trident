import { describe, expect, it } from "vitest";
import { importsOf } from "@fire_trident/core";
import { MAX_ASSUMPTION_NAMES, exportedNames, importBindings, nameAssumptionCandidates, nameAssumptions } from "../../src/decide/mechanical.ts";

const names = (src: string) => importBindings(src).map((b) => [b.specifier, b.names]);

describe("importBindings: the names a file takes from each module", () => {
  it("reads named imports by the exported name, default imports as default, and re-exports from", () => {
    const src = [
      'import { a, b as c } from "./s";',
      "import x from './t';",
      'import y, { z as zz } from "./u";',
      'import type { T } from "./types";',
      'import { type U, v } from "./mixed";',
      'export { e as f, default } from "./re";',
      'export type { R } from "./re-types";',
      'import { "kebab-name" as kebab } from "./strings";',
    ].join("\n");
    expect(names(src)).toEqual([
      ["./s", ["a", "b"]],
      ["./t", ["default"]],
      ["./u", ["default", "z"]],
      ["./types", ["T"]],
      ["./mixed", ["U", "v"]],
      ["./re", ["e", "default"]],
      ["./re-types", ["R"]],
      ["./strings", ["kebab-name"]],
    ]);
  });

  it("gives no checkable names for namespace, side-effect, dynamic, require, export * and empty imports", () => {
    const src = [
      'import * as ns from "./a";',
      'import d, * as both from "./b";',
      'import "./c";',
      'const lazy = await import("./d");',
      'const old = require("./e");',
      'export * from "./f";',
      'export * as g from "./g";',
      'import {} from "./h";',
      'import type * as types from "./i";',
    ].join("\n");
    expect(names(src)).toEqual([
      ["./a", null],
      ["./b", null],
      ["./c", null],
      ["./d", null],
      ["./e", null],
      ["./f", null],
      ["./g", null],
      ["./h", null],
      ["./i", null],
    ]);
  });

  it("handles the `type` keyword as a binding name, and refuses the ambiguous `type as`", () => {
    expect(names('import type from "./a";\nimport type, { b } from "./b";\nimport { type as c } from "./c";')).toEqual([
      ["./a", ["default"]],
      ["./b", ["default", "b"]],
      ["./c", null],
    ]);
  });

  it("reads multi-line clauses with comments, and reports exactly the imports importsOf finds, at the same lines", () => {
    const src = [
      "// import { fake } from './comment'",
      "const s = \"import { alsoFake } from './string'\";",
      "import {",
      "  a, // first",
      "  /* second */ b as c,",
      '} from "./s";',
      "const t = `import { tpl } from './template'`;",
    ].join("\n");
    const got = importBindings(src);
    expect(got).toEqual([{ specifier: "./s", line: 6, names: ["a", "b"] }]);
    expect(got.map(({ specifier, line }) => ({ specifier, line }))).toEqual(importsOf(src));
  });
});

describe("exportedNames: what a file exports", () => {
  it("finds every top-level export form", () => {
    const src = [
      "export function f() {}",
      "export async function g() {}",
      "export function* h() {}",
      "export const c1 = 1, c2 = 2;",
      "export let l = 1;",
      "export var v = 1;",
      "export class K {}",
      "export abstract class AK {}",
      "export interface I { x: number }",
      "export type T = string;",
      "export enum E { A }",
      "export const enum CE { B }",
      "export declare const dc: number;",
      "export declare function df(): void;",
      "export namespace N { export const inner = 1; }",
      "const local1 = 1, local2 = 2;",
      "export { local1, local2 as renamed };",
      'export { x as default2 } from "./x";',
      'export type { TT } from "./t";',
      'export * as nsx from "./y";',
      'export * from "./z";',
      "export import Alias = N.inner;",
      "export default function () {}",
    ].join("\n");
    const ex = exportedNames(src)!;
    expect([...ex.names].sort()).toEqual(
      ["AK", "Alias", "CE", "E", "I", "K", "N", "T", "TT", "c1", "dc", "default", "default2", "df", "f", "g", "h", "l", "local1", "nsx", "renamed", "v"].sort(),
    );
    expect(ex.star).toEqual(["./z"]);
  });

  it("ignores exports in comments, strings, templates and nested blocks", () => {
    const src = [
      "// export const c1 = 1",
      "/* export function c2() {} */",
      'const s = "export const c3 = 1";',
      "const t = `",
      "export const c4 = 1;",
      "`;",
      'declare module "m" { export const c5: number; }',
      "export const real = 1;",
    ].join("\n");
    expect([...exportedNames(src)!.names]).toEqual(["real"]);
  });

  it("is null when the source cannot be read reliably", () => {
    expect(exportedNames("const x = 1;\nexport = x;\n")).toBeNull();
    expect(exportedNames('export const a = "unterminated;\n')).toBeNull();
    expect(exportedNames("export function f() {\n")).toBeNull();
    expect(exportedNames("}\nexport const a = 1;\n")).toBeNull();
  });

  it("lists nothing for a module without exports", () => {
    expect(exportedNames("const x = 1;\n")).toEqual({ names: new Set(), star: [] });
  });
});

/** Trunk: the files a written file can import. */
const TRUNK = new Set(["src/s.ts", "src/t.ts", "src/u/index.ts", "src/data.json", "src/v.ts", "src/widget.ts", "src/lib/config.ts", "src/auth/session.ts"]);

function assumptions(files: Array<{ path: string; after: string | null; unreadable?: boolean; binary?: boolean }>) {
  const own = new Map(files.map((f) => [f.path, f.after !== null || Boolean(f.unreadable || f.binary)]));
  const existed = (p: string): boolean => TRUNK.has(p);
  const exists = (p: string): boolean => (own.has(p) ? own.get(p)! : existed(p));
  return nameAssumptions(files, exists, existed);
}

describe("nameAssumptions: the names a change imports from trunk files", () => {
  const reader = [
    'import { a, b as bb } from "./s";',
    'import def from "./t.ts";',
    'import * as uu from "./u";',
    'import data from "./data.json";',
    'import type { V } from "./v";',
    'import { helper } from "./mine";',
    'import { gone } from "./missing";',
    'import { useState } from "ui-kit";',
    "export const r = [a, bb, def, uu, data, helper, gone, useState];",
  ].join("\n");

  it("records named and default imports of trunk files, sorted, and leaves out everything that cannot be checked", () => {
    expect(assumptions([{ path: "src/r.ts", after: reader }, { path: "src/mine.ts", after: "export const helper = 1;\n" }])).toEqual([
      { path: "src/s.ts", names: ["a", "b"] },
      { path: "src/t.ts", names: ["default"] },
      { path: "src/v.ts", names: ["V"] },
    ]);
  });

  it("joins the names several written files take, but one namespace import of a file leaves it uncovered", () => {
    const one = 'import { a } from "./s";\nimport { x } from "./t";\n';
    const two = 'import { b } from "../s";\nimport * as t from "../t";\n';
    expect(assumptions([{ path: "src/one.ts", after: one }, { path: "src/sub/two.ts", after: two }])).toEqual([{ path: "src/s.ts", names: ["a", "b"] }]);
  });

  it("never records a sensitive file: a change that read one that moved goes back with a strict version check", () => {
    expect(assumptions([{ path: "src/r.ts", after: 'import { a } from "./s";\nimport { verify } from "./auth/session";\n' }])).toEqual([{ path: "src/s.ts", names: ["a"] }]);
  });

  it("never records a file the change writes or deletes", () => {
    expect(assumptions([{ path: "src/r.ts", after: 'import { a } from "./s";\n' }, { path: "src/s.ts", after: "export const a = 2;\n" }])).toEqual([]);
    expect(assumptions([{ path: "src/r.ts", after: 'import { a } from "./s";\n' }, { path: "src/s.ts", after: null }])).toEqual([]);
  });

  it("records nothing when a written file cannot be read, or embeds imports it does not parse", () => {
    const ok = { path: "src/r.ts", after: 'import { a } from "./s";\n' };
    expect(assumptions([ok, { path: "src/big.ts", after: null, binary: true }])).toEqual([]);
    expect(assumptions([ok, { path: "src/gone.ts", after: null, unreadable: true }])).toEqual([]);
    expect(assumptions([ok, { path: "src/App.vue", after: '<script>import { b } from "./s"</script>' }])).toEqual([]);
    expect(assumptions([ok, { path: "README.md", after: "# notes\n" }])).toEqual([{ path: "src/s.ts", names: ["a"] }]);
  });

  it("leaves a file uncovered when a path alias or base URL import could name it", () => {
    const local = 'import { load } from "./lib/config";\n';
    expect(assumptions([{ path: "src/r.ts", after: `${local}import { other } from "@/lib/config";\n` }])).toEqual([]);
    expect(assumptions([{ path: "src/r.ts", after: `${local}import { other } from "lib/config";\n` }])).toEqual([]);
    expect(assumptions([{ path: "src/r.ts", after: `${local}import fs from "node:fs";\nimport { z } from "schema-kit";\n` }])).toEqual([{ path: "src/lib/config.ts", names: ["load"] }]);
    // A subpath import or a slashless alias may point anywhere.
    expect(assumptions([{ path: "src/r.ts", after: `${local}import { other } from "#config";\n` }])).toEqual([]);
    expect(assumptions([{ path: "src/r.ts", after: `${local}import { other } from "@cfg";\n` }])).toEqual([]);
    expect(assumptions([{ path: "src/r.ts", after: `${local}import { other } from "#lib/config";\n` }])).toEqual([]);
    // A package that shares a trunk file's name is treated the same way: when unsure, the file is uncovered.
    expect(assumptions([{ path: "src/r.ts", after: 'import { Widget } from "./widget";\nimport { Widget as W } from "widget";\n' }])).toEqual([]);
  });

  it("leaves a file uncovered past the names cap", () => {
    const many = Array.from({ length: MAX_ASSUMPTION_NAMES + 1 }, (_, i) => `n${i}`);
    expect(assumptions([{ path: "src/r.ts", after: `import { ${many.join(", ")} } from "./s";\n` }])).toEqual([]);
  });

  it("asks the trunk about every relative import of the written scripts", () => {
    const wanted = nameAssumptionCandidates([{ path: "src/r.ts", after: reader }, { path: "README.md", after: 'import "./not-code"' }]);
    expect(wanted).toContain("src/s.ts");
    expect(wanted).toContain("src/u/index.ts");
    expect(wanted).toContain("src/data.json");
    expect(wanted).not.toContain("not-code.ts");
    expect(wanted.some((p) => p.startsWith("ui-kit"))).toBe(false);
  });
});
