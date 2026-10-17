import { describe, expect, it } from "vitest";
import type { FileVersion, Path, Sha } from "@fire_trident/core";
import { FoldedIndex, SYMLINK_MODE, cycleCollisions, structureProblem, submoduleProblems, type StructureTrunk, type TreeItem } from "../../src/trunk/structure.ts";

/** The trunk writer's checks for symbolic links and second spellings of one file (trunk/structure.ts). */

const sha = (c: string): Sha => c.repeat(40);

/** A trunk holding these files (mode 100644 unless given), its folded index read through FoldedIndex. */
function trunk(files: Record<Path, { blob: Sha; mode?: string }>, reads = { n: 0 }): StructureTrunk {
  const index = new FoldedIndex();
  return {
    file: (path) => (files[path] ? { blob: files[path]!.blob, mode: files[path]!.mode ?? "100644" } : null),
    folded: () =>
      index.get("v1", () => {
        reads.n++;
        return Object.keys(files);
      }),
  };
}

const write = (path: Path, c = "b"): FileVersion => ({ path, blob: sha(c) });
const del = (path: Path): FileVersion => ({ path, blob: null });

describe("symbolic links", () => {
  const t = trunk({ "config/current": { blob: sha("1"), mode: SYMLINK_MODE }, "README.md": { blob: sha("2") } });

  it("a write that would change where a trunk link points is refused, with what to do instead", () => {
    expect(structureProblem([write("config/current")], t)).toBe(
      "config/current is a symbolic link in trunk, and a change cannot change where it points (its new text would become the link's target): leave it out of the change, or replace the link with a regular file by deleting it in one change and writing the file in the next",
    );
  });

  it("deleting a link, writing it unchanged, and writing regular files all pass", () => {
    expect(structureProblem([del("config/current")], t)).toBeNull();
    expect(structureProblem([{ path: "config/current", blob: sha("1") }], t)).toBeNull();
    expect(structureProblem([write("README.md"), write("docs/new.md")], t)).toBeNull();
  });
});

describe("second spellings of one file", () => {
  it("a new path that folds to another trunk path is refused, naming both", () => {
    const t = trunk({ "README.md": { blob: sha("1") }, "docs/caf\u00E9.md": { blob: sha("2") } });
    expect(structureProblem([write("readme.md")], t)).toBe(
      "readme.md differs from the trunk file README.md only in letter case or Unicode form, so they are one file on case-insensitive file systems: write README.md instead, or rename it in the same change (delete README.md and write readme.md)",
    );
    // The decomposed spelling of a trunk path is the same file on a normalization-insensitive file system.
    expect(structureProblem([write("docs/cafe\u0301.md")], t)).toContain("differs from the trunk file docs/caf\u00E9.md");
    expect(structureProblem([write("DOCS/CAF\u00C9.MD")], t)).toContain("differs from the trunk file docs/caf\u00E9.md");
  });

  it("a rename by case in one change passes, and so does editing a path trunk already has", () => {
    const t = trunk({ "README.md": { blob: sha("1") }, "Notes.md": { blob: sha("2") }, "notes.md": { blob: sha("3") } });
    expect(structureProblem([del("README.md"), write("Readme.md")], t)).toBeNull();
    // Trunk already holds two spellings (written before this check): editing either is not adding one.
    expect(structureProblem([write("notes.md", "c")], t)).toBeNull();
    // A third spelling still collides with the one left.
    expect(structureProblem([del("Notes.md"), write("NOTES.md")], t)).toContain("differs from the trunk file notes.md");
  });

  it("two spellings in one change are refused", () => {
    expect(structureProblem([write("src/Util.ts"), write("src/util.ts")], trunk({}))).toBe(
      "src/Util.ts and src/util.ts differ only in letter case or Unicode form, so they are one file on case-insensitive file systems: write only one of them",
    );
  });

  it("the folded index is read only when a change adds a path, once per trunk version", () => {
    const reads = { n: 0 };
    const t = trunk({ "a.ts": { blob: sha("1") } }, reads);
    expect(structureProblem([write("a.ts")], t)).toBeNull();
    expect(reads.n).toBe(0);
    expect(structureProblem([write("b.ts")], t)).toBeNull();
    expect(structureProblem([write("c.ts")], t)).toBeNull();
    expect(reads.n).toBe(1);
    const index = new FoldedIndex();
    let n = 0;
    const paths = () => {
      n++;
      return ["A.ts"];
    };
    index.get("v1", paths);
    index.get("v1", paths);
    expect(index.get("v2", paths).get("a.ts")).toEqual(["A.ts"]);
    expect(n).toBe(2);
  });
});

describe("second spellings inside one landing cycle", () => {
  it("the later of two changes adding one file under two spellings waits for the next cycle", () => {
    const changes = [
      { id: "prp_1", writeSet: [write("Notes.md")] },
      { id: "prp_2", writeSet: [write("src/x.ts")] },
      { id: "prp_3", writeSet: [write("NOTES.md")] },
    ];
    expect([...cycleCollisions(changes, () => false)]).toEqual([["prp_3", "NOTES.md differs only in letter case or Unicode form from Notes.md, which another change in this landing cycle adds; it waits for the next cycle"]]);
  });

  it("the same spelling twice, edits of trunk paths and deletions are left to the other checks", () => {
    const changes = [
      { id: "prp_1", writeSet: [write("a.md")] },
      { id: "prp_2", writeSet: [write("a.md", "c")] },
      { id: "prp_3", writeSet: [write("B.md"), del("c.md")] },
      { id: "prp_4", writeSet: [write("b.md"), del("C.md")] },
    ];
    // B.md is in trunk: prp_3 edits it, so prp_4's b.md meets it at structureProblem instead.
    expect(cycleCollisions(changes, (path) => path === "B.md").size).toBe(0);
  });
});

describe("submodules", () => {
  /** Trunk's trees: the root holds src/ and vendor/, vendor/ holds README.md and the submodule lib. */
  const TREES: Record<string, TreeItem[]> = {
    root: [
      { path: "src", mode: "040000", oid: "t_src", type: "tree" },
      { path: "vendor", mode: "040000", oid: "t_vendor", type: "tree" },
    ],
    t_src: [{ path: "a.ts", mode: "100644", oid: sha("1"), type: "blob" }],
    t_vendor: [
      { path: "README.md", mode: "100644", oid: sha("2"), type: "blob" },
      { path: "lib", mode: "160000", oid: sha("c"), type: "commit" },
    ],
  };
  const NOT = "FireTrident does not change submodules. Leave it out of the change.";

  it("refuses a write to, a write inside and a deletion of a submodule, reading each tree once", async () => {
    const reads: string[] = [];
    const entries = async (oid: string) => {
      reads.push(oid);
      return TREES[oid] ?? [];
    };
    const out = await submoduleProblems(
      [
        { id: "prp_1", writeSet: [write("vendor/README.md"), write("vendor/lib")] },
        { id: "prp_2", writeSet: [write("vendor/lib/src/x.ts")] },
        { id: "prp_3", writeSet: [del("vendor/lib")] },
        { id: "prp_4", writeSet: [write("vendor/libs.md"), write("src/a.ts"), write("docs/new.md")] },
      ],
      "root",
      entries,
    );
    expect([...out]).toEqual([
      ["prp_1", { kind: "returned", reason: `This change writes vendor/lib, which is a submodule in trunk; ${NOT}` }],
      ["prp_2", { kind: "returned", reason: `This change writes vendor/lib/src/x.ts, which is inside the submodule vendor/lib in trunk; ${NOT}` }],
      ["prp_3", { kind: "returned", reason: `This change deletes vendor/lib, which is a submodule in trunk; ${NOT}` }],
    ]);
    expect(reads.sort()).toEqual(["root", "t_src", "t_vendor"]);
  });

  it("lets a change wait when trunk's tree cannot be read: the check fails closed", async () => {
    const out = await submoduleProblems([{ id: "prp_1", writeSet: [write("src/a.ts")] }], "root", async () => {
      throw new Error("object not found");
    });
    expect(out.get("prp_1")).toEqual({ kind: "deferred", reason: "trunk's tree could not be read to check for submodules: object not found" });
  });
});
