import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColonyEvent, ColonySnapshot } from "@fire_trident/core";
import { HttpBackend } from "../src/api.ts";
import { buildTree, treeInput } from "../src/intentTree.ts";
import { ColonyStore } from "../src/store.ts";

/** A live page learns where intents declared after it loaded came from: their events do not say, the colony's snapshot does. */

class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(): void {}
  close(): void {}
}

const rule = (id: string, description: string) => ({ id, colonyId: "c", kind: "forbid-pattern", spec: {}, description, approvedBy: "m", createdAt: 0 });
const intent = (id: string, extra: Record<string, unknown>) => ({ id, colonyId: "c", title: id, why: "w", source: "human", footprint: [`src/${id}.ts`], priority: 1, status: "open", createdAt: 0, createdBy: "m", ...extra });
const snapshot = (intents: unknown[], rules: unknown[]): ColonySnapshot =>
  ({
    colony: { id: "c", name: "c", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
    files: [],
    intents,
    rules,
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
  }) as unknown as ColonySnapshot;

let current: ColonySnapshot = snapshot([], []);
const reads: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  reads.length = 0;
  current = snapshot([], []);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const suffix = url.replace("/api/colonies/c", "");
      reads.push(suffix);
      const body = suffix === "" ? current : suffix === "/field" ? [] : {};
      return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const opened = (id: string, title: string, path: string): ColonyEvent => ({ t: "intent", at: Date.now(), intentId: id, status: "open", title, footprint: [path] });
const send = (evs: ColonyEvent[]) => FakeSocket.last?.onmessage?.({ data: JSON.stringify(evs) });
const snapshotReads = () => reads.filter((r) => r === "").length;
/** Let `ms` pass with the socket answering its keepalive, so it is not taken for dead (which reconnects and reads the snapshot). */
async function quietly(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 20_000) {
    await vi.advanceTimersByTimeAsync(Math.min(20_000, left));
    FakeSocket.last?.onmessage?.({ data: "pong" });
  }
}

describe("the live page learns intent origins", () => {
  it("re-reads the snapshot once intents arrive without an origin, then at most every 30 s", async () => {
    current = snapshot([intent("old", {})], [rule("r1", "Rule one")]);
    const store = new ColonyStore("c");
    const backend = new HttpBackend("c");
    backend.start(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.loaded).toBe(true);
    expect(snapshotReads()).toBe(1);

    // A person adds a rule: its intents arrive by event, and the page does not know the rule yet.
    send([opened("n1", "New rule in lib/a.ts", "lib/a.ts"), opened("n2", "New rule in lib/b.ts", "lib/b.ts")]);
    expect(store.unsourcedBorn).toBe(2);
    expect(buildTree(treeInput(store)).groups.find((g) => g.key === "unknown")?.total).toBe(2);
    current = snapshot([intent("old", {}), intent("n1", { source: "rule", ruleId: "r9", title: "New rule in lib/a.ts" })], [rule("r1", "Rule one"), rule("r9", "New rule")]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(snapshotReads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshotReads()).toBe(2);
    // n1 learned its origin; n2 was not listed, but the rule is known now and its title names it.
    expect(store.intents.get("n1")?.source).toBe("rule");
    expect(store.rules.has("r9")).toBe(true);
    const tree = buildTree(treeInput(store));
    expect(tree.groups.find((g) => g.key === "rule:r9")?.total).toBe(2);
    expect(tree.groups.some((g) => g.key === "unknown")).toBe(false);

    // Another arrives soon after: the next read waits for 30 s after the last one.
    send([opened("n3", "Add search", "src/search.ts")]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshotReads()).toBe(2);
    current = snapshot([intent("n3", { title: "Add search", source: "human" })], [rule("r9", "New rule")]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(snapshotReads()).toBe(3);
    expect(store.intents.get("n3")?.source).toBe("human");

    // Nothing new without an origin: no more reads (the socket stays alive; a silent one reconnects and reads it anyway).
    await quietly(120_000);
    expect(snapshotReads()).toBe(3);
    backend.stop();
  });

  it("reads nothing more while every intent arrives with a known origin, and stops with the page", async () => {
    current = snapshot([intent("a", {})], []);
    const store = new ColonyStore("c");
    const backend = new HttpBackend("c");
    backend.start(store);
    await vi.advanceTimersByTimeAsync(0);
    send([{ t: "intent", at: Date.now(), intentId: "a", status: "claimed", title: "a", footprint: ["src/a.ts"] }]);
    await quietly(60_000);
    expect(snapshotReads()).toBe(1);
    // An unknown one, then the page closes before the read: nothing is read.
    send([opened("z", "Something", "src/z.ts")]);
    backend.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshotReads()).toBe(1);
  });
});
