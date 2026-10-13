import { describe, expect, it } from "vitest";
import { MIN_RESUME_KEY, newResumeKey, resumeDigest, resumeKeyMatches } from "../../src/mcp/resume.ts";

describe("resume keys", () => {
  it("are 32 random bytes in base64url, different every time", () => {
    const keys = Array.from({ length: 50 }, () => newResumeKey());
    for (const k of keys) {
      expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(k.length).toBeGreaterThanOrEqual(MIN_RESUME_KEY);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("are stored as their SHA-256 digest in hex, never as themselves", async () => {
    expect(await resumeDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const key = newResumeKey();
    const digest = await resumeDigest(key);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(key);
  });

  it("match only the key behind the digest", async () => {
    const key = newResumeKey();
    const digest = await resumeDigest(key);
    expect(await resumeKeyMatches(key, digest)).toBe(true);
    expect(await resumeKeyMatches(newResumeKey(), digest)).toBe(false);
    expect(await resumeKeyMatches(`${key}x`, digest)).toBe(false);
    expect(await resumeKeyMatches("", digest)).toBe(false);
    // The digest itself is not a key.
    expect(await resumeKeyMatches(digest, digest)).toBe(false);
  });
});
