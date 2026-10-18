import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NoteDecision } from "@fire_trident/core";
import { main, type Io } from "../src/run.ts";
import { proposal, removeAll, signingKey, trunkRepo, type TrunkRepo } from "./trunk-repo.ts";

/**
 * The review receipt from a stock clone: scripts/verify_note.mjs and `ft verify --commit` print one receipt line a
 * decision after the answerable line, the same lines (src/receipt.ts), and nothing new for a note written before
 * receipts. A receipt field is inside the digest, so changing one is caught.
 */

const SCRIPT = fileURLToPath(new URL("../../../scripts/verify_note.mjs", import.meta.url));

function script(dir: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`.trimEnd() };
}

async function ft(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const io: Io = {
    env: { NO_COLOR: "1", FT_URL: "https://ft.test", FT_TOKEN: "unused" },
    stdout: (l) => void lines.push(l),
    stderr: (l) => void lines.push(l),
    isTTY: false,
    fetch: (async () => {
      throw new Error("a clone check calls no server");
    }) as unknown as typeof fetch,
    readFile: (p) => readFile(p, "utf8"),
    sleep: async () => {},
    now: () => 0,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
  };
  const code = await main(["verify", ...args, "--dir", dir], io);
  return { code, out: lines.join("\n") };
}

/** Both checkers on one commit: they must agree, line for line and on the exit code. */
async function both(dir: string, commit: string, rest: string[] = []): Promise<{ code: number; out: string }> {
  const s = script(dir, [commit, ...rest]);
  expect(await ft(dir, [`--commit=${commit}`, ...rest])).toEqual(s);
  return s;
}

const HEAD = "1234567890abcdef1234567890abcdef12345678";
const CARD = `sha256:${"ab".repeat(32)}`;
const PROMPT = `sha256:${"cd".repeat(32)}`;

let repo: TrunkRepo;
let keys: { keyId: string; keysFile: string };
const sha: Record<string, string> = {};

beforeAll(async () => {
  repo = trunkRepo();
  const key = await signingKey(repo.dir);
  keys = key;
  repo.plain({ "src/a.ts": "export const a = 1;\n" }, "Initial commit\n");
  // Before receipts: decisions with no head, view or identity.
  sha.old = await repo.landing(
    { "src/a.ts": "export const a = 2;\n" },
    { landingId: "lnd_old", proposals: [proposal({ id: "prp_old", writeSet: [{ path: "src/a.ts", blob: repo.blob("export const a = 2;\n") }], decisions: [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "matt" }] })] },
    { signer: key.signer },
  );
  const decisions: NoteDecision[] = [
    { kind: "triage", layer: "llm", p: 0.6, action: "escalate", by: "@cf/google/gemma", head: HEAD, shown: { view: "prompt-diff", digest: PROMPT, clipped: true, seen: "saw 20 of 22 files" }, earlier: 3 },
    { kind: "triage", layer: "human", p: 1, action: "approve", by: "dana@example.com", head: HEAD, shown: { view: "review-card", digest: CARD }, identity: "verified" },
  ];
  const stated: NoteDecision[] = [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "matt", head: HEAD, shown: { view: "review-card", clipped: true, seen: "the card served no view of the change" }, identity: "stated" }];
  sha.receipt = await repo.landing(
    { "src/a.ts": "export const a = 3;\n", "src/b.ts": "b\n" },
    {
      landingId: "lnd_r",
      proposals: [
        proposal({ id: "prp_1", writeSet: [{ path: "src/a.ts", blob: repo.blob("export const a = 3;\n") }], decisions }),
        proposal({ id: "prp_2", writeSet: [{ path: "src/b.ts", blob: repo.blob("b\n") }], decisions: stated }),
      ],
    },
    { signer: key.signer },
  );
});

afterAll(removeAll);

describe("receipt lines from a clone", () => {
  it("prints nothing new for a note written before receipts", async () => {
    expect(await both(repo.dir, sha.old!)).toEqual({ code: 0, out: "intact\nanswerable: matt (approved this change)" });
  });

  it("prints each decision's head, what its decider was shown, and verified or stated, the same from both checkers", async () => {
    const r = await both(repo.dir, sha.receipt!, ["--keys", keys.keysFile]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      `intact, signed by ${keys.keyId}`,
      "answerable: dana@example.com, matt (1 of 2: dana@example.com approved this change; 1 of 2: matt approved this change)",
      "receipt: prp_1 2 of 5 decisions kept (the 3 earliest left out by the note's cap)",
      `receipt: prp_1 llm escalate by @cf/google/gemma at head 1234567890ab, shown the prompt's diff sha256:${"cd".repeat(8)}, clipped: saw 20 of 22 files`,
      `receipt: prp_1 human approve by dana@example.com (verified by Access) at head 1234567890ab, shown the review card sha256:${"ab".repeat(8)}`,
      "receipt: prp_2 human approve by matt (stated, not verified) at head 1234567890ab, shown the review card: no view was kept, clipped: the card served no view of the change",
    ]);
  });

  it("catches a changed receipt: it is inside the note's digest", async () => {
    const r = await both(repo.dir, sha.receipt!, ["--tamper", "--tamper-field", "proposals[0].decisions[1].identity"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").at(-1)).toBe("tampered copy: altered (proposals[0].decisions[1].identity changed from verified to mallory): the digest no longer matches");
  });
});
