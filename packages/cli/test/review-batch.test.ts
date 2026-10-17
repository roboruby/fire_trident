import { describe, expect, it } from "vitest";
import type { Intent, Proposal } from "@fire_trident/core";
import { helpText, parseCommand } from "../src/args.ts";
import { batchOf, findBatch, groupBatches } from "../src/batch.ts";
import { colors, formatReview } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";

/** `ft review` and escalation batching: one block per batch, as the web shows one card, and an answer for a batch. */

const plain = colors(false);
const NOW = 1_800_000_000_000;
const BATCH = { id: "bat_0a1b2c3d", key: "P1|capability (network)", rule: "P1 danger pattern", label: "hit the danger pattern capability (network)", budget: 60, ids: ["prp_a", "prp_b"] };
const NET_LABEL = "capability (network) at src/hook.ts:2: await fetch(url, { method: 'POST', body });";

function proposal(id: string, over: Record<string, unknown> = {}): Proposal {
  return {
    id,
    colonyId: "web",
    intentId: `int_${id}`,
    agentId: "agt_1",
    workspace: { namespace: "n", name: "w", remote: "r" },
    baseSha: "a",
    headSha: "b",
    writeSet: [{ path: "src/hook.ts", blob: "c" }],
    readSet: [],
    declared: { footprint: ["src/hook.ts"], summary: `Deliver webhooks ${id}` },
    evidence: { checks: [] },
    status: "escalated",
    createdAt: NOW - 120_000,
    reason: "escalated by deterministic: danger patterns need a human: capability (network)",
    ...over,
  } as Proposal;
}

const view = { files: [], filesChanged: 1, danger: [{ path: "src/hook.ts", line: 2, cls: "capability", pattern: "capability:network", label: NET_LABEL }], residual: [] };
const QUEUE = [proposal("prp_a", { batch: BATCH, review: view }), proposal("prp_lone"), proposal("prp_b", { batch: BATCH })];
const intents = new Map<string, Intent>([["int_prp_a", { id: "int_prp_a", title: "Send order webhooks" } as Intent]]);

describe("batches in the review list", () => {
  it("reads a batch defensively and finds one by its id or key", () => {
    expect(batchOf(QUEUE[0]!)).toEqual(BATCH);
    expect(batchOf(proposal("prp_x", { batch: { key: "k" } }))).toBeNull();
    expect(batchOf(proposal("prp_x", { batch: BATCH, audit: { layer: "proof" } }))).toBeNull();
    const groups = groupBatches(QUEUE);
    expect(groups.map((g) => g.members.map((m) => m.id))).toEqual([["prp_a", "prp_b"]]);
    expect(findBatch(groups, "bat_0a1b2c3d")?.batch.key).toBe(BATCH.key);
    expect(findBatch(groups, BATCH.key)?.batch.id).toBe("bat_0a1b2c3d");
    expect(findBatch(groups, "bat_ffffffff")).toBeNull();
    // A batch down to one change in the queue is no batch.
    expect(groupBatches([QUEUE[0]!, QUEUE[1]!])).toEqual([]);
  });

  it("shows one block per batch with its count, each change and how to decide them all; their own entries only with --diff", () => {
    const text = formatReview(QUEUE, [...intents.values()], plain, NOW, { colony: "web" });
    expect(text).toContain("Batch bat_0a1b2c3d  2 changes hit the danger pattern capability (network)");
    expect(text).toContain("Past its budget of 60 an hour for escalations the alert budget cannot send back");
    expect(text).toContain("  prp_a  Send order webhooks  agt_1 · 2m ago");
    expect(text).toContain(`    ${NET_LABEL}`);
    expect(text).toContain("  prp_b  Deliver webhooks prp_b  agt_1 · 2m ago");
    expect(text).toContain("Decide all 2: ft review web --approve-batch bat_0a1b2c3d, or --reject-batch bat_0a1b2c3d --reason <text>. Open each: ft review web --diff");
    // Folded: the lone change has its own entry, the batch's changes do not.
    expect(text).toMatch(/^prp_lone {2}/m);
    expect(text).not.toMatch(/^prp_a {2}/m);
    const open = formatReview(QUEUE, [...intents.values()], plain, NOW, { colony: "web", diff: true });
    expect(open).toMatch(/^prp_a {2}/m);
    expect(open).toMatch(/^prp_b {2}/m);
  });

  it("shows the list as before when no change carries a batch", () => {
    const text = formatReview([proposal("prp_1"), proposal("prp_2")], undefined, plain, NOW, { colony: "web" });
    expect(text).not.toContain("Batch ");
    expect(text).toMatch(/^prp_1 {2}/m);
    expect(text).toMatch(/^prp_2 {2}/m);
  });
});

describe("ft review --approve-batch and --reject-batch", () => {
  it("parses them, needs a reason to reject, and takes no proposal or other flags", () => {
    const ok = parseCommand(["review", "web", "--approve-batch", "bat_0a1b2c3d", "--by", "matt"]);
    expect(ok.ok && ok.command).toEqual({ name: "review-batch", colony: "web", batch: "bat_0a1b2c3d", decision: "approve", reason: "", by: "matt" });
    const rej = parseCommand(["review", "web", "--reject-batch", "bat_0a1b2c3d", "--reason", "No new network calls."]);
    expect(rej.ok && rej.command).toMatchObject({ name: "review-batch", decision: "reject", reason: "No new network calls." });
    const noReason = parseCommand(["review", "web", "--reject-batch", "bat_0a1b2c3d"]);
    expect(!noReason.ok && noReason.error).toMatch(/--reason is required to reject a batch/);
    const both = parseCommand(["review", "web", "--approve-batch", "bat_1", "--reject-batch", "bat_1", "--reason", "x"]);
    expect(!both.ok && both.error).toMatch(/not both/);
    expect(parseCommand(["review", "web", "prp_1", "--approve-batch", "bat_1"]).ok).toBe(false);
    const diff = parseCommand(["review", "web", "--approve-batch", "bat_1", "--diff"]);
    expect(!diff.ok && diff.error).toMatch(/--diff does not apply to deciding a batch/);
    expect(helpText("review")).toContain("ft review <colony> --approve-batch <batchId> [--by <name>]");
    expect(helpText("review")).toContain("ft review <colony> --reject-batch <batchId> --reason <text> [--by <name>]");
  });

  /** ft against a fake server whose review queue is QUEUE; records each call. */
  function fakeIo(answer: unknown = { key: BATCH.key, decision: "approve", decided: ["prp_a", "prp_b"], skipped: [] }) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: Array<{ method: string; url: string; auth?: string; body?: unknown }> = [];
    const io: Io = {
      env: { FT_URL: "https://ft.test", FT_TOKEN: "t", FT_USER: "matt" },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      isTTY: false,
      fetch: (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ method: init?.method ?? "GET", url, ...(headers.authorization ? { auth: headers.authorization } : {}), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        const body = (init?.method ?? "GET") === "GET" ? QUEUE : answer;
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      readFile: async () => "",
      sleep: async () => undefined,
      now: () => NOW,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => undefined,
    };
    return { io, out, err, calls };
  }

  it("reads the queue, answers the batch's changes with the admin token, and says what it did", async () => {
    const { io, out, calls } = fakeIo({ key: BATCH.key, decision: "approve", decided: ["prp_a"], skipped: [{ id: "prp_b", why: "it is landed and no longer waits for a person" }] });
    expect(await main(["review", "web", "--approve-batch", "bat_0a1b2c3d"], io)).toBe(0);
    expect(calls).toEqual([
      { method: "GET", url: "https://ft.test/api/colonies/web/review", auth: "Bearer t" },
      { method: "POST", url: "https://ft.test/api/colonies/web/review/batches/decide", auth: "Bearer t", body: { key: BATCH.key, ids: ["prp_a", "prp_b"], decision: "approve", reason: "", by: "matt" } },
    ]);
    expect(out).toEqual([
      "Approved 1 change of batch bat_0a1b2c3d: prp_a",
      "  Each rejoins its lane and lands on the next cycle.",
      "  left alone prp_b: it is landed and no longer waits for a person",
    ]);
  });

  it("rejects a batch with the reason, and fails when the queue holds no such batch", async () => {
    const rej = fakeIo({ decided: ["prp_a", "prp_b"], skipped: [] });
    expect(await main(["review", "web", "--reject-batch", BATCH.key, "--reason", "No new network calls."], rej.io)).toBe(0);
    expect(rej.calls[1]?.body).toMatchObject({ decision: "reject", reason: "No new network calls.", ids: ["prp_a", "prp_b"] });
    expect(rej.out[0]).toBe("Rejected 2 changes of batch bat_0a1b2c3d: prp_a, prp_b");
    const none = fakeIo();
    expect(await main(["review", "web", "--approve-batch", "bat_ffffffff"], none.io)).toBe(1);
    expect(none.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(none.err.join("\n")).toContain("no batch bat_ffffffff in the review queue of web");
  });

  it("prints the read and the answer it would send with --dry-run, sending nothing", async () => {
    const { io, out, calls } = fakeIo();
    expect(await main(["review", "web", "--approve-batch", "bat_0a1b2c3d", "--dry-run"], io)).toBe(0);
    expect(calls).toEqual([]);
    const shown = JSON.parse(out.join("\n")) as Array<{ method: string; url: string; body?: { ids?: unknown } }>;
    expect(shown.map((r) => [r.method, r.url])).toEqual([
      ["GET", "https://ft.test/api/colonies/web/review"],
      ["POST", "https://ft.test/api/colonies/web/review/batches/decide"],
    ]);
    expect(shown[1]?.body?.ids).toBe("<the batch's changes in the queue>");
  });
});
