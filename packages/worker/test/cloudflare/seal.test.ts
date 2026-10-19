import { describe, expect, it } from "vitest";
import { fromBase64Url, seal, SealError, toBase64Url, unseal } from "../../src/cloudflare/seal.ts";

/** Stored Cloudflare tokens: AES-GCM under a key HKDF derives from FT_GRANT_KEY with a salt per record, bound to its context. */

const KEY = "k".repeat(40);
const CTX = "cloudflare-grant:acc_1";

describe("seal and unseal", () => {
  it("round-trips, with a fresh salt and IV each time", async () => {
    const a = await seal(KEY, CTX, "access and refresh");
    const b = await seal(KEY, CTX, "access and refresh");
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(a).not.toContain("access");
    expect(await unseal(KEY, CTX, a)).toBe("access and refresh");
    expect(await unseal(KEY, CTX, b)).toBe("access and refresh");
  });

  it("refuses a changed ciphertext, salt or IV, another record's context, another key, and junk", async () => {
    const sealed = await seal(KEY, CTX, "secret");
    const parts = sealed.split(".");
    const flip = (i: number) => {
      const bytes = fromBase64Url(parts[i] ?? "");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      return parts.map((p, j) => (j === i ? toBase64Url(bytes) : p)).join(".");
    };
    for (const bad of [flip(1), flip(2), flip(3)]) await expect(unseal(KEY, CTX, bad)).rejects.toBeInstanceOf(SealError);
    await expect(unseal(KEY, "cloudflare-grant:acc_2", sealed)).rejects.toBeInstanceOf(SealError);
    await expect(unseal("x".repeat(40), CTX, sealed)).rejects.toBeInstanceOf(SealError);
    for (const junk of ["", "v1", "v2.a.b.c", "v1.!!.b.c", `v1.${parts[1]}.${parts[2]}.AAAA`]) await expect(unseal(KEY, CTX, junk)).rejects.toBeInstanceOf(SealError);
  });
});
