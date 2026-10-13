import { describe, expect, it } from "vitest";
import type { Path, Sha } from "@fire_trident/core";
import { importedDeletions, importedText, movedText, planRevert, relativeSpecifiers, type LandedPath } from "../../src/trunk/revert.ts";

const sha = (c: string): Sha => c.repeat(40).slice(0, 40);

describe("planRevert", () => {
  // The landing edited src/a.ts, created src/new.ts and deleted src/old.ts.
  const landed: LandedPath[] = [
    { path: "src/a.ts", before: sha("1"), after: sha("2") },
    { path: "src/new.ts", before: null, after: sha("3") },
    { path: "src/old.ts", before: sha("4"), after: null },
  ];
  const later = (by: Record<Path, string>) => (path: Path) => by[path] ?? null;

  it("puts every path back while trunk still holds what the landing produced", () => {
    const trunk: Record<Path, Sha | null> = { "src/a.ts": sha("2"), "src/new.ts": sha("3") };
    expect(planRevert(landed, (p) => trunk[p] ?? null, later({}))).toEqual({
      ok: true,
      restore: [
        { path: "src/a.ts", blob: sha("1"), expect: sha("2") },
        { path: "src/new.ts", blob: null, expect: sha("3") },
        { path: "src/old.ts", blob: sha("4"), expect: null },
      ],
    });
  });

  it("refuses when work landed on top, naming each path and the landing that moved it", () => {
    const trunk: Record<Path, Sha | null> = { "src/a.ts": sha("5"), "src/old.ts": sha("6") };
    const plan = planRevert(landed, (p) => trunk[p] ?? null, later({ "src/a.ts": "lnd_b", "src/new.ts": "lnd_c", "src/old.ts": "lnd_d" }));
    expect(plan).toEqual({
      ok: false,
      moved: [
        { path: "src/a.ts", now: sha("5"), by: "lnd_b" },
        { path: "src/new.ts", now: null, by: "lnd_c" },
        { path: "src/old.ts", now: sha("6"), by: "lnd_d" },
      ],
    });
    if (plan.ok) throw new Error("expected a refusal");
    expect(movedText(plan.moved)).toBe("src/a.ts changed since, last by lnd_b; src/new.ts deleted since, last by lnd_c; src/old.ts changed since, last by lnd_d");
    expect(movedText(plan.moved, 1)).toBe("src/a.ts changed since, last by lnd_b; and 2 more");
  });

  it("skips paths the landing left as they were", () => {
    const same: LandedPath[] = [{ path: "src/a.ts", before: sha("1"), after: sha("1") }];
    expect(planRevert(same, () => sha("1"), later({}))).toEqual({ ok: true, restore: [] });
  });
});

describe("importedDeletions", () => {
  // Trunk after landings: src/lib/fresh.ts and src/lib/kit/index.ts were created by the landing being undone.
  const tree = new Set(["src/app/main.ts", "src/app/other.ts", "src/lib/fresh.ts", "src/lib/kit/index.ts", "src/lib/util.ts", "src/lib/util/index.ts", "docs/guide.md", "data.json"]);
  const exists = (p: Path) => tree.has(p);
  const files = (texts: Record<Path, string>) => Object.entries(texts).map(([path, text]) => ({ path, specifiers: relativeSpecifiers(text) }));

  it("finds the trunk files whose relative imports resolve to a deleted file, as the decide stage resolves them", () => {
    const found = importedDeletions(
      ["src/lib/fresh.ts", "src/lib/kit/index.ts"],
      files({
        "src/app/main.ts": 'import { fresh } from "../lib/fresh.js";\nimport kit from "../lib/kit";\n',
        "src/app/other.ts": 'export { fresh } from "../lib/fresh";\n',
        "src/lib/util.ts": 'import type { Fresh } from "./fresh.ts";\n',
        "docs/guide.md": 'import { fresh } from "../src/lib/fresh";\n',
      }),
      exists,
    );
    expect(found).toEqual([
      { path: "src/lib/fresh.ts", by: ["src/app/main.ts", "src/app/other.ts", "src/lib/util.ts"] },
      { path: "src/lib/kit/index.ts", by: ["src/app/main.ts"] },
    ]);
    expect(importedText(found, (p) => (p === "src/app/main.ts" ? "lnd_b" : null))).toBe(
      "src/lib/fresh.ts is imported by src/app/main.ts (last changed by lnd_b), src/app/other.ts, src/lib/util.ts; src/lib/kit/index.ts is imported by src/app/main.ts (last changed by lnd_b)",
    );
  });

  it("ignores imports that resolve elsewhere, packages, comments and strings, and the deleted files themselves", () => {
    const found = importedDeletions(
      ["src/lib/fresh.ts", "src/lib/kit/index.ts"],
      files({
        // "./util" resolves to the file beside the directory, never to anything deleted.
        "src/app/main.ts": 'import { helper } from "../lib/util";\nimport x from "fresh";\n// import { fresh } from "../lib/fresh";\nconst s = "import y from \'../lib/fresh\'";\n',
        // A deleted file importing another deleted file goes away with it.
        "src/lib/kit/index.ts": 'export * from "../fresh.ts";\n',
      }),
      exists,
    );
    expect(found).toEqual([]);
  });

  it("caps the refusal text", () => {
    const by = Array.from({ length: 7 }, (_, i) => `src/a${i}.ts`);
    const list = Array.from({ length: 7 }, (_, i) => ({ path: `src/gone${i}.ts`, by }));
    const text = importedText(list);
    expect(text.startsWith("src/gone0.ts is imported by src/a0.ts, src/a1.ts, src/a2.ts, src/a3.ts, src/a4.ts, 2 more; src/gone1.ts")).toBe(true);
    expect(text.endsWith("; and 2 more")).toBe(true);
  });
});
