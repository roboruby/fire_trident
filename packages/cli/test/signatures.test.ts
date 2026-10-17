import { describe, expect, it } from "vitest";
import type { NoteCheck, NotesVerification } from "@fire_trident/core";
import { helpText } from "../src/args.ts";
import { colors, formatVerify, verifyFailed } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";
import { signatureFailed, signatureLines } from "../src/signatures.ts";

/** `ft verify` on a deployment that signs lineage notes: each commit signed, unsigned or with a bad signature. */

const plain = colors(false);
const NOW = 1_000_000_000;
const KEY = "0123456789abcdef";
const sha = (c: string): string => c.repeat(40);
const check = (landingId: string, extra: Partial<NoteCheck> = {}): NoteCheck => ({ landingId, trunkSha: sha(landingId.slice(-1)), at: NOW - 120_000, status: "intact", ownCopy: true, ...extra });

const report: NotesVerification = {
  colonyId: "web",
  notesTip: sha("9"),
  notes: [
    check("lnd_3", { signature: { status: "signed", keyId: KEY } }),
    check("lnd_2", { signature: { status: "bad-signature", keyId: KEY, detail: `the signature does not verify with key ${KEY}: the note digest, tree or parent this commit carries is not what the trunk writer signed` } }),
    check("lnd_1", { signature: { status: "unsigned" } }),
  ],
  counts: { intact: 3 },
  at: NOW,
};

describe("formatVerify with signatures", () => {
  it("counts signed, bad and unsigned commits, names the key, and lists each bad signature with why", () => {
    const lines = formatVerify("web", report, plain, NOW).split("\n");
    expect(lines.slice(1)).toEqual([
      "  ✓ 3 intact",
      `  signatures ✓ 1 signed by key ${KEY} · ✗ 1 bad signature · - 1 unsigned (landed before signing)`,
      `  ✗ lnd_2 2222222 2m ago  bad signature: the signature does not verify with key ${KEY}: the note digest, tree or parent this commit carries is not what the trunk writer signed`,
      "  A bad signature means the trunk writer did not sign that commit with a key it publishes for that commit's time: history was rewritten, or its key was replaced without the old one listed as retired.",
    ]);
  });

  it("says nothing about signatures where the server checked none, and reads odd answers without failing", () => {
    const unsigned = { ...report, notes: report.notes.map(({ signature: _s, ...n }) => n) };
    expect(formatVerify("web", unsigned, plain, NOW)).not.toContain("signatures");
    expect(signatureLines([check("lnd_1", { signature: { status: "sealed-with-wax" } as unknown as NoteCheck["signature"] })], plain, NOW)).toEqual([]);
    expect(signatureLines([check("lnd_1", { signature: { status: "signed" } })], plain, NOW)).toEqual(["  signatures ✓ 1 signed"]);
    const many = signatureLines(Array.from({ length: 12 }, (_, i) => check(`lnd_${i}`, { signature: { status: "bad-signature" } })), plain, NOW);
    expect(many[0]).toBe("  signatures ✗ 12 bad signature");
    expect(many).toContain("  ✗ lnd_0 0000000 2m ago  bad signature: it does not verify with the published key");
    expect(many).toContain("    +2 more");
  });

  it("fails on a bad signature, and never on a signed or unsigned commit", () => {
    expect(signatureFailed(report)).toBe(true);
    expect(verifyFailed(report)).toBe(false);
    expect(signatureFailed({ notes: [check("a", { signature: { status: "signed" } }), check("b", { signature: { status: "unsigned" } }), check("c")] })).toBe(false);
    expect(signatureFailed(null)).toBe(false);
    expect(helpText("verify")).toContain("/.well-known/firetrident-keys.json");
  });
});

describe("ft verify against a server that signs", () => {
  function io(body: unknown): Io & { out: string[] } {
    const out: string[] = [];
    const fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
    return {
      env: { FT_URL: "https://ft.test", NO_COLOR: "1" },
      stdout: (l) => void out.push(l),
      stderr: () => {},
      isTTY: false,
      fetch,
      readFile: async () => "",
      sleep: async () => {},
      now: () => NOW,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => {},
      out,
    };
  }

  it("exits 1 on a bad signature even when every note is intact, and 0 when the commits are signed or unsigned", async () => {
    const bad = io(report);
    expect(await main(["verify", "web"], bad)).toBe(1);
    expect(bad.out.join("\n")).toContain("✗ 1 bad signature");
    const good = io({ ...report, notes: [report.notes[0], report.notes[2]] });
    expect(await main(["verify", "web"], good)).toBe(0);
    expect(await main(["verify", "web", "--json"], io(report))).toBe(1);
  });
});
