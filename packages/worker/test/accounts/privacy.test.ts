import { describe, expect, it } from "vitest";
import { hideOwners } from "../../src/accounts/ownership.ts";

/** Public reads never name the account that owns a colony (accounts/ownership.ts hideOwners, used by api/app.ts hideRemotes). */

const trunk = { namespace: "ft-trunk", name: "shop--trunk", remote: "artifacts://firetrident-trunk/shop--trunk.git" };

describe("hideOwners", () => {
  it("takes a repository reference's owner out wherever it sits in its object, compact or indented", () => {
    for (const json of [
      JSON.stringify({ id: "shop", trunk: { ...trunk, owner: "acc_mvfl3l2a079rue" } }),
      JSON.stringify({ id: "shop", trunk: { owner: "acc_mvfl3l2a079rue", ...trunk } }),
      JSON.stringify({ id: "shop", trunk: { namespace: "ft-trunk", owner: "acc_mvfl3l2a079rue", name: "shop--trunk", remote: trunk.remote } }),
      JSON.stringify({ id: "shop", trunk: { ...trunk, owner: "acc_mvfl3l2a079rue" } }, null, 2),
      JSON.stringify([{ owner: "acc_mvfl3l2a079rue" }, { workspace: { owner: "acc_x1", name: "w" } }]),
    ]) {
      const out = hideOwners(json);
      expect(out).not.toContain("acc_");
      expect(() => JSON.parse(out)).not.toThrow();
    }
    expect(JSON.parse(hideOwners(JSON.stringify({ trunk: { ...trunk, owner: "acc_1" } })))).toEqual({ trunk });
  });

  it("leaves everything else alone: other owners, and text inside strings", () => {
    const other = JSON.stringify({ owner: "the platform team", note: 'an agent wrote "owner":"acc_1" in its why', rule: { owner: 3 } });
    expect(hideOwners(other)).toBe(other);
    const plain = JSON.stringify({ id: "hono", trunk });
    expect(hideOwners(plain)).toBe(plain);
  });
});
