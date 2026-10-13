import { describe, expect, it } from "vitest";
import { INLINE_LIMITS, blobId, changesetId, inlineProblem, utf8Bytes } from "../src/changeset.ts";
import type { FileVersion } from "../src/types.ts";

const BASE = "a".repeat(40);

describe("blobId", () => {
  it("matches git hash-object", () => {
    // Expected ids from `git hash-object --stdin`.
    expect(blobId("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(blobId("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(blobId("é\n")).toBe("c6003325155f475bd7c87731607525dce73be9cf");
    expect(blobId("e\n")).toBe("d905d9da82c97264ab6f4920e20242e088850ce9");
    expect(blobId("line of seventy characters exactly to cross a sixty-four byte block\n".repeat(3))).toBe("bdd63c3979f99494a604ebebad53b7a2f793c6d5");
    expect(blobId("😀 emoji and 中文\n")).toBe("c44ece5219fee5337f7df8a0faa19d75bebbb5ea");
    expect(blobId("x".repeat(1_000_000))).toBe("8eb708f936a80a54e0daa13707cba9b938bf257b");
  });

  it("encodes UTF-8 as TextEncoder does", () => {
    expect([...utf8Bytes("é")]).toEqual([0xc3, 0xa9]);
    expect([...utf8Bytes("😀")]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect([...utf8Bytes("\ud800")]).toEqual([0xef, 0xbf, 0xbd]); // a lone surrogate becomes U+FFFD
  });
});

describe("changesetId", () => {
  it("does not depend on the order of the write set", () => {
    const a: FileVersion[] = [
      { path: "src/a.ts", blob: "1".repeat(40) },
      { path: "src/b.ts", blob: null },
    ];
    expect(changesetId(BASE, a)).toBe(changesetId(BASE, [...a].reverse()));
  });

  it("changes with the base, a path or a blob", () => {
    const w: FileVersion[] = [{ path: "src/a.ts", blob: "1".repeat(40) }];
    const id = changesetId(BASE, w);
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(changesetId("b".repeat(40), w)).not.toBe(id);
    expect(changesetId(BASE, [{ path: "src/c.ts", blob: "1".repeat(40) }])).not.toBe(id);
    expect(changesetId(BASE, [{ path: "src/a.ts", blob: "2".repeat(40) }])).not.toBe(id);
    expect(changesetId(BASE, [{ path: "src/a.ts", blob: null }])).not.toBe(id);
  });
});

describe("inlineProblem", () => {
  it("accepts contents that hash to the written blobs, and deletions without contents", () => {
    const text = "export const a = 1;\n";
    const w: FileVersion[] = [
      { path: "src/a.ts", blob: blobId(text) },
      { path: "src/old.ts", blob: null },
    ];
    expect(inlineProblem(w, { [w[0]!.blob!]: text })).toBeNull();
  });

  it("refuses missing, mismatched, extra, binary and oversized contents", () => {
    const text = "export const a = 1;\n";
    const blob = blobId(text);
    const w: FileVersion[] = [{ path: "src/a.ts", blob }];
    expect(inlineProblem(w, {})).toMatch(/no contents for src\/a\.ts/);
    expect(inlineProblem(w, { [blob]: "export const a = 2;\n" })).toMatch(/hash to/);
    expect(inlineProblem(w, { [blob]: text, ["f".repeat(40)]: "x" })).toMatch(/no written file uses/);
    const bin = "a\0b";
    expect(inlineProblem([{ path: "x.bin", blob: blobId(bin) }], { [blobId(bin)]: bin })).toMatch(/NUL byte/);
    const big = "x".repeat(INLINE_LIMITS.fileBytes + 1);
    expect(inlineProblem([{ path: "big.txt", blob: blobId(big) }], { [blobId(big)]: big })).toMatch(/limit/);
  });

  it("caps the number of files", () => {
    const w: FileVersion[] = [];
    const contents: Record<string, string> = {};
    for (let i = 0; i <= INLINE_LIMITS.files; i++) {
      const t = `export const v${i} = ${i};\n`;
      const b = blobId(t);
      w.push({ path: `src/f${i}.ts`, blob: b });
      contents[b] = t;
    }
    expect(inlineProblem(w, contents)).toMatch(/at most 64 files/);
  });
});
