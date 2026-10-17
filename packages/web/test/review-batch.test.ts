import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Proposal } from "@fire_trident/core";
import { HttpBackend, saveToken } from "../src/api.ts";
import { ReviewBatchCard } from "../src/components/ReviewBatch.tsx";
import { batchAnswerOf, batchDoneText, batchHeadline, batchMemberLine, batchOf, batchWhy, groupBatches, type BatchGroup } from "../src/batch.ts";
import { reviewOf } from "../src/review.ts";

/** Escalation batching on the review page: one card per batch, its changes listed, approve all, reject all, open each. */

const BATCH = { id: "bat_0a1b2c3d", key: "P1|capability (network)", rule: "P1 danger pattern", label: "hit the danger pattern capability (network)", budget: 60, ids: ["prp_a", "prp_b"] };
const DANGER = { files: [], filesChanged: 1, danger: [{ path: "src/hook.ts", line: 2, cls: "capability", pattern: "capability:network", label: "capability (network) at src/hook.ts:2: await fetch(url, { method: 'POST', body });" }], residual: [] };

const item = (id: string, extra: Record<string, unknown> = {}): Proposal =>
  ({ id, status: "escalated", intentId: `int_${id}`, agentId: "agt_1", createdAt: Date.now() - 60_000, evidence: { checks: [] }, reason: "escalated by deterministic: danger patterns need a human: capability (network)", ...extra }) as unknown as Proposal;

describe("reading batches from the queue", () => {
  it("reads a batch field by field, and nothing from a queue without batches", () => {
    expect(batchOf(item("prp_a", { batch: BATCH }))).toEqual(BATCH);
    expect(batchOf(item("prp_a"))).toBeNull();
    expect(batchOf(item("prp_a", { batch: { key: "", label: "x" } }))).toBeNull();
    expect(batchOf(item("prp_a", { batch: [BATCH] }))).toBeNull();
    expect(batchOf(item("prp_a", { batch: { key: "k", label: "hit it", ids: ["prp_a", 4, ""], budget: -1 } }))).toEqual({ id: "", key: "k", rule: "", label: "hit it", budget: 0, ids: ["prp_a"] });
  });

  it("groups a batch's changes in queue order, leaving lone changes and other cards alone", () => {
    const other = { ...BATCH, key: "L5", rule: "L5 too large", label: "were too large for model review", ids: ["prp_c"] };
    const queue = [item("prp_x"), item("prp_b", { batch: BATCH }), item("prp_c", { batch: other }), item("prp_a", { batch: BATCH })];
    const groups = groupBatches(queue);
    expect(groups.map((g) => [g.batch.key, g.members.map((m) => m.id)])).toEqual([["P1|capability (network)", ["prp_b", "prp_a"]]]);
    expect(groupBatches([item("prp_x")])).toEqual([]);
  });

  it("says what the changes share and why they wait together", () => {
    const g: BatchGroup = { batch: BATCH, members: [item("prp_a"), item("prp_b")] };
    expect(batchHeadline(g)).toBe("2 changes hit the danger pattern capability (network)");
    expect(batchWhy(BATCH)).toBe(
      "Past its budget of 60 an hour for escalations the alert budget cannot send back, this colony puts changes that escalate for the same reason on one card. A person still decides each change: approving or rejecting all records your decision on every change listed here.",
    );
    expect(batchMemberLine(item("prp_a"), reviewOf(item("prp_a", { review: DANGER })))).toBe("capability (network) at src/hook.ts:2: await fetch(url, { method: 'POST', body });");
    expect(batchMemberLine(item("prp_a"), null)).toBe("danger patterns need a human: capability (network)");
  });

  it("reads the server's answer and says it back", () => {
    const a = batchAnswerOf({ decided: ["prp_a", 3], skipped: [{ id: "prp_b", why: "it is landed and no longer waits for a person" }, { why: "no id" }] });
    expect(a).toEqual({ decided: ["prp_a"], skipped: [{ id: "prp_b", why: "it is landed and no longer waits for a person" }] });
    expect(batchAnswerOf(null)).toEqual({ decided: [], skipped: [] });
    expect(batchDoneText("approve", a)).toBe("Approved 1 change. Each rejoins its lane and lands on the next cycle. 1 change left alone: it is landed and no longer waits for a person.");
    expect(batchDoneText("reject", { decided: ["prp_a", "prp_b"], skipped: [] })).toBe("Rejected 2 changes. Your reason is now one antibody, from the first of them.");
    expect(batchDoneText("approve", { decided: [], skipped: [] })).toBe("Nothing was decided: none of these changes still waits in this batch.");
  });
});

describe("the batch card", () => {
  const group: BatchGroup = { batch: BATCH, members: [item("prp_a", { review: DANGER }), item("prp_b")] };
  const render = (over: Partial<Parameters<typeof ReviewBatchCard>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(ReviewBatchCard, {
        group,
        agentName: () => "scout",
        titleOf: (p: Proposal) => `Intent of ${p.id}`,
        open: false,
        busy: false,
        readOnly: false,
        reason: "",
        onReason: () => {},
        onToggle: () => {},
        onDecide: () => {},
        ...over,
      }),
    );

  it("shows the count, each change, approve all, reject all (waiting for a reason) and open each", () => {
    const html = render();
    expect(html).toContain("2 changes hit the danger pattern capability (network): review them together");
    expect(html).toContain("Batch of 2");
    expect(html).toContain("bat_0a1b2c3d");
    for (const id of ["prp_a", "prp_b"]) expect(html).toContain(`Intent of ${id}`);
    expect(html).toContain("capability (network) at src/hook.ts:2");
    expect(html).toContain("Approve all 2");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reject all 2<\/button>/);
    expect(html).toContain("Open each");
    expect(render({ reason: "No new network calls." })).not.toMatch(/disabled=""[^>]*>Reject all/);
  });

  it("reads only in a replay, and says close each once opened", () => {
    const html = render({ readOnly: true, open: true });
    expect(html).not.toContain("Approve all");
    expect(html).not.toContain("Reject all");
    expect(html).toContain("Close each");
  });
});

describe("answering a batch in the live backend", () => {
  afterEach(() => {
    saveToken("");
    vi.unstubAllGlobals();
  });

  it("posts the listed changes with this browser's token and reads the answer", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return new Response(JSON.stringify({ key: BATCH.key, decision: "approve", decided: ["prp_a"], skipped: [] }), { status: 200 });
      }),
    );
    saveToken("operator-token");
    const answer = await new HttpBackend("web").decideBatch(BATCH.key, ["prp_a", "prp_b"], "approve", "", "matt");
    expect(answer).toEqual({ decided: ["prp_a"], skipped: [] });
    expect(calls.map((c) => [c.url, c.init?.method, c.init?.body])).toEqual([
      ["/api/colonies/web/review/batches/decide", "POST", JSON.stringify({ key: BATCH.key, ids: ["prp_a", "prp_b"], decision: "approve", reason: "", by: "matt" })],
    ]);
    expect(JSON.stringify(calls[0]?.init?.headers)).toContain("Bearer operator-token");
  });
});
