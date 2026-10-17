import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { InnateFile } from "../../src/colony/innate.ts";
import { destructiveFact } from "../../src/decide/destructive.ts";
import { declaredRecipe, replayable, reproduceChange, reproductionText, type ReproduceInput } from "../../src/decide/reproduce.ts";

/** One written file as the innate checks read it (before null: a new file; after null: deleted). */
function file(path: string, before: string | null, after: string | null): InnateFile {
  return { path, beforeBlob: before === null ? null : blobId(before), afterBlob: after === null ? null : blobId(after), before, after, binary: false, unreadable: false };
}

const RENAME = { kind: "rename-identifier", version: "1", args: { from: "compose", to: "assemble" }, scope: ["src/**"] };

/** A module that defines compose and calls it `n` times, and its renamed twin. */
function mod(n: number, name = "compose"): string {
  return [`export function ${name}(a: number): number {`, "  return a + 1;", "}", ...Array.from({ length: n }, (_, i) => `export const v${i} = ${name}(${i});`), ""].join("\n");
}
function user(name = "compose"): string {
  return `import { ${name} } from "./mod.ts";\nexport const total = ${name}(2) + ${name}(3);\n`;
}

function input(files: InnateFile[], over: Partial<ReproduceInput> = {}): ReproduceInput {
  return { files, outside: [], danger: [], destructive: destructiveFact(files), on: true, maxChars: 24_000, ...over };
}

describe("review by reproduction: the replay", () => {
  it("reproduces every file that equals the recipe replayed on its base, and leaves nothing to review", () => {
    const files = [file("src/mod.ts", mod(3), mod(3, "assemble")), file("src/user.ts", user(), user("assemble"))];
    const r = reproduceChange(RENAME, input(files))!;
    expect(r.signal).toEqual({ label: "rename-identifier@1", reproduced: { files: 2, lines: 6 }, residual: { files: 0, lines: 0 }, text: "6 lines reproduced by rename-identifier@1, nothing else to review" });
    expect(r.note).toMatchObject({ applied: true, recipe: RENAME, reproduced: { files: 2, lines: 6, paths: ["src/mod.ts", "src/user.ts"] }, residual: { files: 0, lines: 0, paths: [] } });
    expect(r.view).toEqual([]);
    expect(r.check).toMatchObject({ name: "deterministic: reproduction", ok: true });
    // The rename's removed export is the recipe's own: it is exported under the new name.
    expect(destructiveFact(files).hits.map((h) => h.kind)).toContain("export-removed");
    expect(r.destructive.hits).toEqual([]);
  });

  it("leaves a smuggled line as the residual, shown against the replay so the diff is that line alone", () => {
    const smuggled = mod(3, "assemble").replace("  return a + 1;\n", "  return a + 1;\n  globalThis.flag = true;\n");
    const files = [file("src/mod.ts", mod(3), smuggled), file("src/user.ts", user(), user("assemble"))];
    const r = reproduceChange(RENAME, input(files))!;
    expect(r.signal).toMatchObject({ reproduced: { files: 1, lines: 2 }, residual: { files: 1, lines: 1 }, text: "2 lines reproduced by rename-identifier@1, 1 line to review" });
    expect(r.note.residual.paths).toEqual([{ path: "src/mod.ts", why: "it differs from the recipe's output (shown against the replay)" }]);
    expect(r.view.map((f) => f.path)).toEqual(["src/mod.ts"]);
    expect(r.view[0]!.before).toBe(mod(3, "assemble"));
    expect(r.diffs!.map((d) => [d.path, d.added, d.removed, d.addedLines])).toEqual([["src/mod.ts", 1, 0, ["  globalThis.flag = true;"]]]);
    expect(r.fact).toMatch(/^Review by reproduction: 1 file \(2 lines\) of this change equal the declared recipe rename-identifier@1/);
  });

  it("leaves the files a rename reproduced out of the goal-conflict check, and keeps every file for an import migration", () => {
    const smuggled = mod(1, "assemble") + "export const extra = 1;\n";
    const files = [file("src/mod.ts", mod(1), smuggled), file("src/user.ts", user(), user("assemble"))];
    expect(reproduceChange(RENAME, input(files))!.goalFiles!.map((f) => f.path)).toEqual(["src/mod.ts"]);
    const imports = [file("src/user.ts", 'import { a } from "lodash";\n', 'import { a } from "lodash-es";\n')];
    const migrated = reproduceChange({ kind: "replace-import", version: "1", args: { from: "lodash", to: "lodash-es" }, scope: ["src/**"] }, input(imports))!;
    expect(migrated.signal).toMatchObject({ reproduced: { files: 1, lines: 1 }, residual: { files: 0 } });
    expect(migrated.goalFiles).toBeNull();
  });

  it("names why each file is residual: outside the scope, new, deleted, left as it was, unchanged by the recipe", () => {
    const files = [
      file("src/mod.ts", mod(1), mod(1, "assemble")),
      file("docs/notes.md", "compose\n", "assemble\n"),
      file("src/new.ts", null, "export const x = 1;\n"),
      file("src/gone.ts", "export const y = 2;\n", null),
      file("src/taken.ts", "const assemble = 1;\nexport const z = compose(assemble);\n", "export const z = 0;\n"),
      file("src/plain.ts", "export const w = 1;\n", "export const w = 2;\n"),
    ];
    const r = reproduceChange(RENAME, input(files))!;
    expect(Object.fromEntries(r.note.residual.paths.map((p) => [p.path, p.why]))).toEqual({
      "docs/notes.md": "outside the recipe's scope",
      "src/new.ts": "a new file (a recipe only rewrites files that exist)",
      "src/gone.ts": "deleted (a recipe never deletes a file)",
      "src/taken.ts": expect.stringMatching(/^the recipe leaves it as it was \(name-taken/),
      "src/plain.ts": "the recipe changes nothing in it",
    });
    expect(r.signal?.reproduced.files).toBe(1);
  });

  it("sends a reproduced file with damage of its own to review: a sensitive path, outside the footprint, a danger pattern", () => {
    const files = [file("src/mod.ts", mod(1), mod(1, "assemble")), file("src/auth/session.ts", user(), user("assemble")), file("src/other.ts", user(), user("assemble"))];
    const r = reproduceChange(RENAME, input(files, { outside: ["src/other.ts"] }))!;
    expect(Object.fromEntries(r.note.residual.paths.map((p) => [p.path, p.why]))).toEqual({
      "src/auth/session.ts": "it equals the recipe's output but is on a sensitive path (authentication)",
      "src/other.ts": "it equals the recipe's output but is outside the intent's footprint",
    });
    // Its whole diff goes to review, not the empty one against the replay.
    expect(r.diffs!.find((d) => d.path === "src/auth/session.ts")!.added).toBe(2);

    const danger = reproduceChange(RENAME, input(files.slice(0, 1), { danger: [{ cls: "capability", pattern: "capability:x", path: "src/mod.ts", line: 1, excerpt: "x" }] }))!;
    expect(danger.signal).toBeNull();
    expect(danger.note.reason).toBe("every file that equals the recipe's output needs review of its own (src/mod.ts: it equals the recipe's output but carries a danger pattern), so the whole change has ordinary review");
  });

  it("takes no agent's text-replace as proof, and fails closed when a replay removes many lines across files", () => {
    const body = (n: number, cut: boolean): string => [...Array.from({ length: n }, (_, i) => `export const k${i} = ${i};`), ...(cut ? [] : Array.from({ length: 45 }, () => "legacyHook();"))].join("\n") + "\n";
    const files = Array.from({ length: 5 }, (_, i) => file(`src/m${i}.ts`, body(160, false), body(160, true)));
    const recipe = { kind: "text-replace", version: "1", args: { find: "legacyHook();\n", replace: "" }, scope: ["src/**"] };
    expect(reproduceChange(recipe, input(files))!.note.reason).toBe(
      "a text-replace recipe can change what code does, so reproducing it would prove only that the change is that replacement: the whole change has ordinary review (a person can declare it as a recipe instead)",
    );
    // With the kind allowed, the replay's removal across files (a destructive fact no residual file shows) still fails closed.
    const r = reproduceChange(recipe, input(files, { kinds: new Set(["text-replace"]) }))!;
    expect(r.signal).toBeNull();
    expect(r.note.reason).toBe("the change removes 225 lines net across 5 files, a destructive fact no single file shows, so the whole change has ordinary review");
  });

  it("fails closed to ordinary review with the reason: unknown, module, unpinned or other-version recipes, the flag off", () => {
    const files = [file("src/mod.ts", mod(1), mod(1, "assemble"))];
    const why = (recipe: unknown, over: Partial<ReproduceInput> = {}) => {
      const r = reproduceChange(recipe, input(files, over))!;
      expect(r.signal).toBeNull();
      expect(r.note.applied).toBe(false);
      expect(r.check.ok).toBe(false);
      expect(r.view).toEqual(files);
      expect(r.diffs).toBeNull();
      return r.note.reason ?? "";
    };
    expect(why({ ...RENAME, kind: "prettier" })).toMatch(/^the recipe cannot be replayed \(unknown recipe kind "prettier"/);
    expect(why({ kind: "module", version: "1", args: { source: "export function transform() {}" }, scope: ["src/**"] })).toMatch(/module recipe is not replayed in review/);
    expect(why({ ...RENAME, version: undefined })).toMatch(/names no version/);
    expect(why({ ...RENAME, version: "2" })).toMatch(/pinned to version 2 is refused/);
    expect(why(RENAME, { on: false })).toMatch(/off for this colony \(FT_REPRODUCE\)/);
    expect(reproduceChange(undefined, input(files))).toBeNull();
  });

  it("keeps a declared recipe bounded, and reads one only as a built-in kind with its version", () => {
    expect(declaredRecipe({ kind: " rename-identifier ", version: 1, args: { from: "a", to: "b", n: 3 }, scope: "src/**" })).toEqual({ kind: "rename-identifier", version: "1", args: { from: "a", to: "b" }, scope: ["src/**"] });
    expect(declaredRecipe({ args: {} })).toBeUndefined();
    expect(declaredRecipe("rename")).toBeUndefined();
    expect(replayable(declaredRecipe({ kind: "rename-identifier", args: { from: "a", to: "b" }, scope: ["src/**"] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/names no version/) });
    expect(reproductionText("text-replace@1", 3_999, { files: 1, lines: 1 })).toBe("3,999 lines reproduced by text-replace@1, 1 line to review");
    expect(reproductionText("text-replace@1", 1, { files: 2, lines: 0 })).toBe("1 line reproduced by text-replace@1, 0 lines to review (2 files)");
  });
});
