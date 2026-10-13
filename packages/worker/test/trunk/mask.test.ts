import { describe, expect, it, vi } from "vitest";
import type { LineageNote } from "@fire_trident/core";
import { looksLikeSecret } from "../../src/decide/danger.ts";
import { MASKED, maskNote, maskSecrets, maskStrings } from "../../src/trunk/mask.ts";

// The real detector, watched: what masking hands it is part of the contract (see "reads long text in slices").
vi.mock("../../src/decide/danger.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/decide/danger.ts")>();
  return { ...real, looksLikeSecret: vi.fn(real.looksLikeSecret) };
});

// Fake values in the shapes the secret detector knows (decide/danger.ts), as its own tests use.
const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
const LIVE = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e";
const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7x9\nqzW1abcdefg\n-----END RSA PRIVATE KEY-----";

describe("maskSecrets", () => {
  it("leaves text without a secret exactly as it is", () => {
    for (const text of [
      "Not verified: tests not run on Windows; the API key rotation is out of scope.",
      "The token check now uses a constant-time compare.",
      "short",
      "",
      "Line one\nLine two with password policy notes\n",
    ]) {
      expect(maskSecrets(text)).toBe(text);
    }
  });

  it("masks a known token format and keeps the words around it", () => {
    expect(maskSecrets(`Not verified: I cloned with ${GH} and it worked.`)).toBe(`Not verified: I cloned with ${MASKED} and it worked.`);
    expect(maskSecrets(`two: ${GH} and ${GH}`)).toBe(`two: ${MASKED} and ${MASKED}`);
  });

  it("masks a credential with its name when only the pair reads as a secret", () => {
    expect(maskSecrets(`set API_KEY="${LIVE}" before running`)).toBe(`set ${MASKED} before running`);
    expect(maskSecrets('the fixture sets password = "Zx9vQ2mW7pL4", and I did not rotate it')).toBe(`the fixture sets ${MASKED} and I did not rotate it`);
    expect(maskSecrets("deploy with\napi_key: s3cr3tv4lu3x9k")).toBe(`deploy with\n${MASKED}`);
  });

  it("masks a whole private key block, and only the lines it spans", () => {
    expect(maskSecrets(`Here is the key:\n${KEY}\nThanks`)).toBe(`Here is the key:\n${MASKED}\n${MASKED}\n${MASKED}\n${MASKED}\nThanks`);
    expect(maskSecrets("key: -----BEGIN PRIVATE KEY-----MIIEabcdef-----END PRIVATE KEY----- done")).toBe(`key: ${MASKED} done`);
    // A block that never ends is masked to the end of the text.
    expect(maskSecrets("-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\nmore")).toBe(`${MASKED}\n${MASKED}\n${MASKED}`);
  });

  it("masks a whole line when its secret is two far-apart parts", () => {
    const line = "Debug: console.log(request.headers) stays in for now, and it may print the AUTH_TOKEN header with the rest";
    expect(maskSecrets(`first\n${line}\nlast line`)).toBe(`first\n${MASKED}\nlast line`);
    expect(maskSecrets("left console.log(process.env.API_KEY) in the handler")).toBe(`left ${MASKED} in the handler`);
  });

  it("reads long text in slices: a secret deep inside is still found, and no crafted string is read whole", () => {
    // The detector's time grows faster than what it reads (a long run of word characters), and notes are written while trunk lands.
    const detector = vi.mocked(looksLikeSecret);
    detector.mockClear();
    const filler = "word ".repeat(2_000);
    expect(maskSecrets(`${filler}${GH} ${filler}`)).toBe(`${filler}${MASKED} ${filler}`);
    expect(maskSecrets(`${"token".repeat(4_000)}=ab12cd34ef56gh78`)).toBe(MASKED);
    expect(maskSecrets(`${"-token=".repeat(3_000)}1`)).toBe(MASKED);
    const benign = "-token=".repeat(3_000);
    expect(maskSecrets(benign)).toBe(benign);
    expect(detector).toHaveBeenCalled();
    expect(detector.mock.calls.reduce((most, [s]) => Math.max(most, s.length), 0)).toBeLessThanOrEqual(512);
  });

  it("returns anything that is not a string as it is", () => {
    expect(maskSecrets(undefined as unknown as string)).toBeUndefined();
    expect(maskSecrets(42 as unknown as string)).toBe(42);
  });
});

describe("maskStrings", () => {
  it("masks every string in a JSON value and keeps its shape", () => {
    const v = { a: [`x ${GH}`, 1, true, null], b: { c: `y ${GH}`, d: 2.5 }, e: undefined };
    expect(maskStrings(v)).toEqual({ a: [`x ${MASKED}`, 1, true, null], b: { c: `y ${MASKED}`, d: 2.5 }, e: undefined });
    expect(v.a[0]).toBe(`x ${GH}`);
  });
});

/** A note as the trunk writer builds it, with agent and person text that holds secrets. */
function note(): LineageNote & Record<string, unknown> {
  return {
    schema: "firetrident.lineage/v1",
    landingId: "lnd_1",
    colonyId: "col",
    proposals: [
      {
        id: "prp_1",
        agentId: "agt_1",
        agentKind: "external",
        model: "scripted",
        intent: { id: "int_1", title: `Rotate ${GH}`, why: `The old key ${LIVE} leaked.`, ruleId: "rul_1" },
        writeSet: [{ path: "src/config.ts", blob: "a".repeat(40) }],
        readSet: [{ path: "src/token.ts", blob: "b".repeat(40) }],
        decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", at: 5, question: "Approve?", by: "matt", answer: `ok, ${GH} is a test token` }],
        evidence: {
          checks: [{ name: "tests", ok: false, ms: 12, detail: `expected '${LIVE}' to equal 'x'\n${KEY}` }],
          residual: ["docs/notes.md"],
          notVerified: `Not verified: ran with DEPLOY_TOKEN=${GH}`,
          direction: { intentRevision: 2, directives: [{ id: "dir_1", message: `use ${GH}`, by: "matt", at: 3 }], note: `trying ${LIVE}` },
        },
        alternatives: [{ proposalId: "prp_2", agentId: "agt_2", reason: `it printed ${GH}` }],
        revalidated: [{ path: "src/token.ts", read: "b".repeat(40), landedOn: "c".repeat(40), names: ["token"] }],
      },
    ],
    system: { kind: "antibody", antibody: "ab_1", path: ".firetrident/antibodies/ab_1.json", rejected: "prp_1", reason: `it logs ${GH}`, by: "matt", question: "Does it log a token?", threshold: 0.7 },
  };
}

describe("maskNote", () => {
  it("masks the free text of every proposal and of a system commit, and nothing else", () => {
    const masked = maskNote(note());
    const text = JSON.stringify(masked);
    expect(text).not.toContain(GH);
    expect(text).not.toContain(LIVE);
    expect(text).not.toContain("MIIEpAIBAAKCAQEA7x9");
    const p = masked.proposals[0]!;
    expect(p.intent).toEqual({ id: "int_1", title: `Rotate ${MASKED}`, why: `The old key ${MASKED} leaked.`, ruleId: "rul_1" });
    expect(p.evidence.notVerified).toBe(`Not verified: ran with ${MASKED}`);
    expect(p.evidence.checks[0]).toEqual({ name: "tests", ok: false, ms: 12, detail: `expected ${MASKED} to equal 'x'\n${MASKED}\n${MASKED}\n${MASKED}\n${MASKED}` });
    expect(p.evidence.direction).toEqual({ intentRevision: 2, directives: [{ id: "dir_1", message: `use ${MASKED}`, by: "matt", at: 3 }], note: `trying ${MASKED}` });
    expect(p.decisions[0]).toMatchObject({ kind: "triage", layer: "human", p: 1, action: "approve", answer: `ok, ${MASKED} is a test token` });
    expect(p.alternatives).toEqual([{ proposalId: "prp_2", agentId: "agt_2", reason: `it printed ${MASKED}` }]);
    expect((masked as Record<string, unknown>).system).toMatchObject({ kind: "antibody", reason: `it logs ${MASKED}`, question: "Does it log a token?", threshold: 0.7 });
    // Ids, read and write sets, revalidated paths and the rest stay exact.
    const before = note().proposals[0]!;
    expect({ ...p, intent: before.intent, decisions: before.decisions, evidence: before.evidence, alternatives: before.alternatives }).toEqual(before);
    expect({ ...masked, proposals: [], system: null }).toEqual({ ...note(), proposals: [], system: null });
  });

  it("changes nothing in a note without secrets, old or odd ones included", () => {
    const clean = note();
    const p = clean.proposals[0]!;
    p.intent = { id: "int_1", title: "Rename helper", why: "Clarity" };
    p.decisions = [];
    p.evidence = { checks: [{ name: "tests", ok: true, ms: 1 }] };
    delete p.alternatives;
    delete clean.system;
    expect(maskNote(clean)).toEqual(clean);
    // A proposal without evidence or decisions (an older note shape) does not throw.
    const odd = { ...clean, proposals: [{ ...p, evidence: undefined, decisions: undefined }] } as unknown as LineageNote;
    expect(maskNote(odd).proposals[0]).toMatchObject({ id: "prp_1", intent: { title: "Rename helper" } });
  });
});
