import { describe, expect, it } from "vitest";
import type { NoteCheck, NotesVerification } from "@fire_trident/core";
import { colors, formatVerify } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";
import { mainCheckLines, mainChecksFailed } from "../src/verifymain.ts";

/** `ft verify <colony>` with the server's main, full-commit signature and signing key checks (verifymain.ts). */

const plain = colors(false);
const NOW = 1_000_000_000;
const sha = (c: string): string => c.repeat(40);
const check = (landingId: string, extra: Partial<NoteCheck>): NoteCheck => ({ landingId, trunkSha: sha(landingId.slice(-1)), at: NOW - 120_000, status: "intact", ...extra });

const DROPPED = `main (at ${sha("8").slice(0, 12)}) was rewritten: ${sha("7").slice(0, 12)} on main now stands for this landing, with its message changed, and main no longer reaches the commit it landed as`;

const report: NotesVerification = {
  colonyId: "web",
  notesTip: sha("9"),
  mainTip: sha("8"),
  notes: [
    check("lnd_4", {
      status: "dropped",
      detail: DROPPED,
      main: { status: "dropped", replacedBy: sha("7"), detail: DROPPED },
      commitSignature: { status: "signed", keyId: "0123456789abcdef" },
    }),
    check("lnd_3", { main: { status: "on-main" }, commitSignature: { status: "bad-signature", keyId: "0123456789abcdef", detail: "the full-commit signature does not verify with key 0123456789abcdef" } }),
    check("lnd_2", { main: { status: "pending" }, commitSignature: { status: "signed", keyId: "0123456789abcdef" } }),
    check("lnd_1", { main: { status: "unchecked", detail: "main's history could not be read: binding unavailable" }, commitSignature: { status: "note-only" } }),
  ],
  counts: { dropped: 1, intact: 3 },
  at: NOW,
};

describe("ft verify with main and full-commit signatures", () => {
  it("lists a landing off main with the notes, counts each kind, and lists each bad signature and unchecked landing", () => {
    expect(formatVerify("web", report, plain, NOW).split("\n")).toEqual([
      "web lineage notes on the trunk repository against each commit's FT-Note trailer (newest 4 landings; notes commit 9999999)",
      "  ✓ 3 intact · ✗ 1 no longer on main",
      `  ✗ lnd_4 4444444 2m ago  main (at 888888888888) was rewritten: 777777777777 on main now stands for this landing, with its message changed, and main no longer reaches the commit it landed as`,
      "  full-commit signatures ✓ 2 signed by key 0123456789abcdef · ✗ 1 bad · - 1 signed before full-commit signatures",
      "  ✗ lnd_3 3333333 2m ago  bad full-commit signature: the full-commit signature does not verify with key 0123456789abcdef",
      "  A bad full-commit signature means the commit is not what the trunk writer signed: its message, author or committer changed, or its key was replaced without the old one listed as retired.",
      "  main ✓ 1 on main · ✗ 1 no longer on main · … 1 not published yet · ? 1 not checked (main at 8888888)",
      "  ? lnd_1 1111111 2m ago  main's history could not be read: binding unavailable",
      "  Main no longer reaches a commit FireTrident landed: someone with write access to the trunk repository rewrote or reset main after it landed.",
    ]);
    expect(mainChecksFailed(report)).toBe(true);
  });

  it("adds nothing for a server that checks neither, passes a clean answer, and fails on a key that cannot sign", () => {
    const old = { ...report, notes: [check("lnd_1", {})], counts: { intact: 1 } };
    delete (old as Partial<NotesVerification>).mainTip;
    expect(mainCheckLines(old, plain, NOW)).toEqual([]);
    expect(mainChecksFailed(old)).toBe(false);
    const clean = { ...report, notes: [check("lnd_1", { main: { status: "on-main" }, commitSignature: { status: "signed", keyId: "0123456789abcdef" } })], counts: { intact: 1 } };
    expect(mainCheckLines(clean, plain, NOW)).toEqual(["  full-commit signatures ✓ 1 signed by key 0123456789abcdef", "  main ✓ 1 on main (main at 8888888)"]);
    expect(mainChecksFailed(clean)).toBe(false);
    const broken = { ...old, signingProblem: "FT_NOTE_KEY is set but cannot sign (it is not JSON), so landings go out unsigned: set it to a key and deploy again" };
    expect(mainCheckLines(broken, plain, NOW)).toEqual(["  ✗ FT_NOTE_KEY is set but cannot sign (it is not JSON), so landings go out unsigned: set it to a key and deploy again"]);
    expect(mainChecksFailed(broken)).toBe(true);
  });

  it("exits 1 when a landing is off main, and 0 when every landing is on it", async () => {
    const run = async (answer: unknown): Promise<number> => {
      const io: Io = {
        env: { NO_COLOR: "1", FT_URL: "https://ft.test", FT_TOKEN: "t" },
        stdout: () => undefined,
        stderr: () => undefined,
        isTTY: false,
        fetch: (async () => new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
        readFile: async () => "",
        sleep: async () => {},
        now: () => NOW,
        WebSocket: globalThis.WebSocket,
        onInterrupt: () => {},
      };
      return main(["verify", "web"], io);
    };
    expect(await run(report)).toBe(1);
    expect(await run({ ...report, notes: [check("lnd_1", { main: { status: "on-main" } })], counts: { intact: 1 } })).toBe(0);
  });
});
