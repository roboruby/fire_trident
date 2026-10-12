import { describe, expect, it } from "vitest";
import { pickBranchHead } from "../../src/artifacts/colony.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("pickBranchHead", () => {
  it("follows HEAD when it names a branch other than main", () => {
    const refs = [
      { ref: "HEAD", oid: B, target: "refs/heads/trunk" },
      { ref: "refs/heads/master", oid: A },
      { ref: "refs/heads/trunk", oid: B },
    ];
    expect(pickBranchHead(refs)).toBe(B);
  });

  it("falls back to the requested branch, then master, then any branch", () => {
    expect(pickBranchHead([{ ref: "refs/heads/dev", oid: C }, { ref: "refs/heads/master", oid: A }], "dev")).toBe(C);
    expect(pickBranchHead([{ ref: "refs/heads/dev", oid: C }, { ref: "refs/heads/master", oid: A }])).toBe(A);
    expect(pickBranchHead([{ ref: "refs/heads/dev", oid: C }])).toBe(C);
  });

  it("ignores main and returns null for an empty repo", () => {
    expect(pickBranchHead([{ ref: "refs/heads/main", oid: A }])).toBeNull();
    expect(pickBranchHead([])).toBeNull();
  });
});
