import { describe, expect, it } from "vitest";
import { redact } from "../src/env.ts";
import { redactEvidence } from "../src/evidence.ts";

// Built from pieces, so no token-shaped literal sits in this file.
const token = (version: number, secret: string): string => ["art", `v${version}`, secret].join("_");

describe("published evidence and run messages", () => {
  it("redact Artifacts tokens of any version", () => {
    for (const t of [token(1, "0123abcd"), token(2, "x_89abcdef"), token(3, "ab12.cd34"), token(12, "ff00ff00")]) {
      expect(redactEvidence(`push with ${t} done`)).toBe("push with <redacted> done");
      expect(redact(`clone failed for ${t}`)).toBe("clone failed for <redacted>");
    }
    // The expiry suffix is not secret and may stay; the secret before it goes.
    expect(redactEvidence(`push with ${token(12, "ff00ff00")}?expires=1760000000`)).toBe("push with <redacted>?expires=1760000000");
  });
});
