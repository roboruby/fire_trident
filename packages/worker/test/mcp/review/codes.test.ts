import { describe, expect, it } from "vitest";
import { DECISION_CODE_TTL_MS, decisionCodeSigned, issueDecisionCode, parseDecisionCode } from "../../../src/mcp/review/codes.ts";
import { spendReviewCode } from "../../../src/colony/reviewcodes.ts";
import { memorySql, sha } from "./fixtures.ts";

const ADMIN = "admin-s3cret";
const NOW = Date.UTC(2026, 9, 18, 12);
const subject = { colony: "hono", proposalId: "prp_1", head: sha("b") };

async function valid(code: string | null, s = subject, at = NOW, admin = ADMIN): Promise<boolean> {
  const parsed = parseDecisionCode(code, at);
  return parsed !== null && (await decisionCodeSigned(admin, s, parsed));
}

describe("decision codes", () => {
  it("a code is valid for its colony, change and head for ten minutes", async () => {
    const code = await issueDecisionCode(ADMIN, subject, NOW);
    expect(code).toMatch(/^[0-9a-z]+\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    expect(await valid(code)).toBe(true);
    expect(await valid(code, subject, NOW + DECISION_CODE_TTL_MS)).toBe(true);
    expect(await valid(code, subject, NOW + DECISION_CODE_TTL_MS + 1)).toBe(false);
    // Two codes for one change differ (each has its own nonce).
    expect(await issueDecisionCode(ADMIN, subject, NOW)).not.toBe(code);
  });

  it("a code does not open another colony, another change, a moved head, or another deployment's key", async () => {
    const code = await issueDecisionCode(ADMIN, subject, NOW);
    expect(await valid(code, { ...subject, colony: "other" })).toBe(false);
    expect(await valid(code, { ...subject, proposalId: "prp_2" })).toBe(false);
    expect(await valid(code, { ...subject, head: sha("c") })).toBe(false);
    expect(await valid(code, subject, NOW, "another-admin")).toBe(false);
    expect(await valid(code, subject, NOW, "")).toBe(false);
  });

  it("refuses what is not a code, a code issued too far ahead, and issues none without the admin token", async () => {
    const code = (await issueDecisionCode(ADMIN, subject, NOW))!;
    for (const bad of [undefined, "", "x", code.slice(1), `${code}x`, code.replace(/\.[0-9a-f]{32}\./, ".zz.")]) expect(await valid(bad as string)).toBe(false);
    // A forged expiry breaks the MAC; one beyond the ten minutes is refused before the MAC is read.
    const [, nonce, mac] = code.split(".");
    expect(await valid(`${(NOW + DECISION_CODE_TTL_MS - 1).toString(36)}.${nonce}.${mac}`)).toBe(false);
    expect(parseDecisionCode(`${(NOW + DECISION_CODE_TTL_MS + 60_000).toString(36)}.${nonce}.${mac}`, NOW)).toBeNull();
    expect(await issueDecisionCode(undefined, subject, NOW)).toBeNull();
    expect(await issueDecisionCode("\r\n", subject, NOW)).toBeNull();
  });
});

describe("spent decision codes in the colony", () => {
  it("spends a code once; a decision voids the change's older codes, not newer ones or other changes'", () => {
    const sql = memorySql();
    const t = NOW + DECISION_CODE_TTL_MS;
    expect(spendReviewCode(sql, "a".repeat(32), "prp_1", t, NOW)).toBe(true);
    expect(spendReviewCode(sql, "a".repeat(32), "prp_1", t, NOW)).toBe(false);
    // A code from a card opened before the decision (an earlier expiry) is void; one issued after it is not.
    expect(spendReviewCode(sql, "b".repeat(32), "prp_1", t - 1, NOW)).toBe(false);
    expect(spendReviewCode(sql, "c".repeat(32), "prp_1", t + 1, NOW + 1)).toBe(true);
    expect(spendReviewCode(sql, "d".repeat(32), "prp_2", t - 1, NOW)).toBe(true);
  });

  it("forgets codes once they expire (an expired code is refused before it is spent)", () => {
    const sql = memorySql();
    expect(spendReviewCode(sql, "a".repeat(32), "prp_1", NOW + 10, NOW)).toBe(true);
    spendReviewCode(sql, "b".repeat(32), "prp_9", NOW + 50, NOW + 20);
    expect(sql.exec("SELECT nonce FROM review_codes").toArray()).toEqual([{ nonce: "b".repeat(32) }]);
  });
});
