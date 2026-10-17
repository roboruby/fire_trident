import { describe, expect, it } from "vitest";
import { looksLikeSecret, maskExcerpt, scanDanger } from "../../src/decide/danger.ts";
import { MASKED, maskSecrets } from "../../src/trunk/mask.ts";

/**
 * Artifacts tokens of every version (`art_v<n>_`), not only v1: the danger scanner flags one in a change, its excerpt
 * hides it, and the lineage note's free text masks it (trunk/mask.ts reads the same detector).
 */

// Built from pieces, so no token-shaped literal sits in this file.
const HEX = "0123456789abcdef".repeat(2);
const token = (version: number, secret = HEX): string => ["art", `v${version}`, secret].join("_");
const TOKENS = [token(1), token(2), token(3), token(12), token(2, `x_${HEX}`), `${token(2)}?expires=1760000000`];

describe("Artifacts tokens of any version", () => {
  it("look like a secret, whatever the version", () => {
    for (const t of TOKENS) expect(looksLikeSecret(`const trunkRead = ${JSON.stringify(t)};`), t.slice(0, 8)).toBe(true);
    for (const t of TOKENS) expect(looksLikeSecret(`cloned with ${t} today`), t.slice(0, 8)).toBe(true);
  });

  it("are flagged in a change as a known token format, in tests and comments too", () => {
    for (const t of TOKENS) {
      const hits = scanDanger([{ path: "test/remote.test.ts", before: null, after: `// remote token: ${t}\n` }], { title: "Add a test", why: "", source: "human" });
      expect(hits.map((h) => h.pattern), t.slice(0, 8)).toContain("secret:token-format");
    }
  });

  it("are hidden in an excerpt and masked in a note's free text", () => {
    for (const t of TOKENS) {
      expect(maskExcerpt(`Bearer ${t}`)).not.toContain(HEX);
      expect(maskSecrets(`Not verified: I pushed with ${t} and it worked.`)).toBe(`Not verified: I pushed with ${MASKED} and it worked.`);
    }
  });

  it("leaves a short or bare prefix, and an identifier that only starts alike, alone", () => {
    for (const text of [token(2, "x_00"), token(1, "00"), "art_v2_", "the art_vintage collection", "art_version_2_notes"]) {
      expect(looksLikeSecret(text), text).toBe(false);
      expect(maskSecrets(`Not verified: ${text} here.`)).toBe(`Not verified: ${text} here.`);
    }
  });
});
