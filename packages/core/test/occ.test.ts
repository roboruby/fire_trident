import { describe, expect, it, vi } from "vitest";
import { validateProposal } from "../src/occ.ts";
import type { TrunkIndex } from "../src/occ.ts";
import type { FileVersion, Sha } from "../src/types.ts";

const sha = (c: string): Sha => c.repeat(40);
const A = sha("a");
const A2 = sha("1");
const B = sha("b");
const B2 = sha("2");
const NEW = sha("f");
const X = sha("e");

const fv = (path: string, blob: Sha | null): FileVersion => ({ path, blob });
/** A trunk index over a plain map; unknown paths return undefined. */
const trunkOf = (files: Record<string, Sha | null>): TrunkIndex => (path) => (Object.hasOwn(files, path) ? files[path] : undefined);

describe("validateProposal", () => {
  it("is eligible when reads and write bases are current", () => {
    const p = { readSet: [fv("a.ts", A)], writeSet: [fv("b.ts", NEW)] };
    expect(validateProposal(p, trunkOf({ "a.ts": A, "b.ts": B }), [fv("b.ts", B)])).toEqual({ eligible: true, stale: [] });
  });

  it("is eligible for an empty proposal", () => {
    expect(validateProposal({ readSet: [], writeSet: [] }, trunkOf({}), [])).toEqual({ eligible: true, stale: [] });
  });

  it("reports a read whose blob changed on trunk", () => {
    const p = { readSet: [fv("a.ts", A)], writeSet: [] };
    expect(validateProposal(p, trunkOf({ "a.ts": A2 }), [])).toEqual({
      eligible: false,
      stale: [{ path: "a.ts", expected: A, actual: A2 }],
    });
  });

  it("reports a read file that was deleted on trunk", () => {
    const p = { readSet: [fv("a.ts", A)], writeSet: [] };
    expect(validateProposal(p, trunkOf({ "a.ts": null }), []).stale).toEqual([{ path: "a.ts", expected: A, actual: null }]);
  });

  it("treats an undefined trunk answer as absent", () => {
    const p = { readSet: [fv("missing.ts", null)], writeSet: [] };
    expect(validateProposal(p, trunkOf({}), []).eligible).toBe(true);
    const gone = { readSet: [fv("a.ts", A)], writeSet: [] };
    expect(validateProposal(gone, trunkOf({}), []).stale).toEqual([{ path: "a.ts", expected: A, actual: null }]);
  });

  it("reports an absent file that someone else created after it was read", () => {
    const p = { readSet: [fv("new.ts", null)], writeSet: [] };
    expect(validateProposal(p, trunkOf({ "new.ts": X }), []).stale).toEqual([{ path: "new.ts", expected: null, actual: X }]);
  });

  it("compares a written path with its base blob, not with the new blob", () => {
    const p = { readSet: [], writeSet: [fv("b.ts", NEW)] };
    expect(validateProposal(p, trunkOf({ "b.ts": B }), [fv("b.ts", B)]).eligible).toBe(true);
    expect(validateProposal(p, trunkOf({ "b.ts": B2 }), [fv("b.ts", B)])).toEqual({
      eligible: false,
      stale: [{ path: "b.ts", expected: B, actual: B2 }],
    });
  });

  it("treats a written path missing from baseBlobs as a new file", () => {
    const p = { readSet: [], writeSet: [fv("fresh.ts", NEW)] };
    expect(validateProposal(p, trunkOf({}), []).eligible).toBe(true);
    expect(validateProposal(p, trunkOf({ "fresh.ts": X }), []).stale).toEqual([{ path: "fresh.ts", expected: null, actual: X }]);
  });

  it("reports a written path deleted on trunk since the base", () => {
    const p = { readSet: [], writeSet: [fv("b.ts", NEW)] };
    expect(validateProposal(p, trunkOf({ "b.ts": null }), [fv("b.ts", B)]).stale).toEqual([{ path: "b.ts", expected: B, actual: null }]);
  });

  it("validates deletions in the write set against their base", () => {
    const p = { readSet: [], writeSet: [fv("old.ts", null)] };
    expect(validateProposal(p, trunkOf({ "old.ts": A }), [fv("old.ts", A)]).eligible).toBe(true);
    expect(validateProposal(p, trunkOf({ "old.ts": A2 }), [fv("old.ts", A)]).eligible).toBe(false);
  });

  it("reports every stale path, reads first, then writes", () => {
    const p = { readSet: [fv("a.ts", A), fv("ok.ts", X), fv("c.ts", null)], writeSet: [fv("b.ts", NEW)] };
    const trunk = trunkOf({ "a.ts": A2, "ok.ts": X, "c.ts": X, "b.ts": B2 });
    expect(validateProposal(p, trunk, [fv("b.ts", B)]).stale).toEqual([
      { path: "a.ts", expected: A, actual: A2 },
      { path: "c.ts", expected: null, actual: X },
      { path: "b.ts", expected: B, actual: B2 },
    ]);
  });

  it("reports a path read and written with the same discrepancy once", () => {
    const p = { readSet: [fv("a.ts", A)], writeSet: [fv("a.ts", NEW)] };
    expect(validateProposal(p, trunkOf({ "a.ts": A2 }), [fv("a.ts", A)]).stale).toEqual([{ path: "a.ts", expected: A, actual: A2 }]);
  });

  it("reports both expectations when the read and the base disagree", () => {
    const p = { readSet: [fv("a.ts", A2)], writeSet: [fv("a.ts", NEW)] };
    expect(validateProposal(p, trunkOf({ "a.ts": X }), [fv("a.ts", A)]).stale).toEqual([
      { path: "a.ts", expected: A2, actual: X },
      { path: "a.ts", expected: A, actual: X },
    ]);
  });

  it("asks the trunk index about every read and written path", () => {
    const trunk = vi.fn<TrunkIndex>(() => null);
    validateProposal({ readSet: [fv("r.ts", null)], writeSet: [fv("w.ts", NEW)] }, trunk, []);
    expect(trunk.mock.calls.map((c) => c[0]).sort()).toEqual(["r.ts", "w.ts"]);
  });
});
