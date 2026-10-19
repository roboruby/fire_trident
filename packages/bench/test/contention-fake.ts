/**
 * A fake colony for the contention-scale tests: the REST calls the run makes (register, declare with assignedTo, take,
 * propose inline, poll, metrics, create and delete), and a trunk writer that lands batches the way the real one decides
 * them: a change whose read set still matches lands; one stale only on files it writes is merged line by line with
 * core's mergeText when text merge is on; anything else goes back stale. Every batch is one commit with a lineage note
 * naming its proposals. It also serves as the run's trunk reader (no git). Not the platform: a stand-in to drive the
 * benchmark and its check end to end without a deployment.
 */
import { blobId, changesetId, mergeText, type FileVersion } from "@fire_trident/core";
import type { TrunkCommit } from "../src/contention/check.ts";
import type { TrunkReader } from "../src/contention/trunk.ts";

/** How the fake behaves. */
export interface FakeOptions {
  textMerge?: boolean;
  insertions?: boolean;
  /** Close a change whose merge leaves every file as trunk has it as already on trunk (FT_ALREADY_ON_TRUNK). */
  alreadyOnTrunk?: boolean;
  /** Fault injection: land every change as written, with no read-set check (last writer wins). */
  skipOcc?: boolean;
  /** Every n-th lease of a fresh assignment fails as an empty pool would, giving the intent back. */
  leaseFailEvery?: number;
  /** The trunk writer's cycle (ms). */
  cycleMs?: number;
  flags?: string[];
}

type Intent = { id: string; status: string; assignedTo: string | null; footprint: string[]; leased: boolean };
type Prop = {
  id: string;
  intentId: string;
  agentId: string;
  baseSha: string;
  writeSet: FileVersion[];
  readSet: FileVersion[];
  contents: Record<string, string>;
  status: string;
  createdAt: number;
  reason?: string;
  landingId?: string;
};
type Commit = { sha: string; parent: string | null; files: Map<string, string>; note: string | null; at?: number };

const hex = (n: number, salt: string): string => blobId(`${salt}:${n}`);

export class FakeColony implements TrunkReader {
  readonly opts: FakeOptions;
  readonly calls: string[] = [];
  colony: string | null = null;
  deleted = false;
  private agents = new Map<string, { intentId: string | null }>();
  private intents = new Map<string, Intent>();
  private proposals = new Map<string, Prop>();
  private queue: Prop[] = [];
  private commits = new Map<string, Commit>();
  head: string;
  private seq = 0;
  private takes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly metrics = { landings: 0, landedProposals: 0, proposals: 0, returned: 0, alreadyOnTrunk: 0 };

  constructor(opts: FakeOptions = {}) {
    this.opts = opts;
    const root: Commit = { sha: hex(0, "root"), parent: null, files: new Map(), note: null };
    this.commits.set(root.sha, root);
    this.head = root.sha;
  }

  private id(prefix: string): string {
    return `${prefix}${(++this.seq).toString(36).padStart(6, "0")}`;
  }

  /** The fetch the run calls (install with vi.stubGlobal). */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const path = url.pathname;
    this.calls.push(`${method} ${path}`);
    if (path === "/api/about") return json({ service: "firetrident", commit: "fake", flags: this.opts.flags ?? ["FT_INLINE", ...(this.opts.textMerge ? ["FT_TEXT_MERGE"] : []), ...(this.opts.insertions ? ["FT_MERGE_INSERTIONS"] : [])] });
    if (path === "/api/colonies" && method === "POST") {
      if (this.colony) return json({ error: "exists" }, 409);
      this.colony = body.name;
      this.timer = setInterval(() => this.cycle(), this.opts.cycleMs ?? 15);
      return json({ id: body.name }, 201);
    }
    const m = /^\/api\/colonies\/([^/]+)(\/.*)?$/.exec(path);
    if (!m || m[1] !== this.colony) return json({ error: "unknown colony" }, 404);
    const rest = m[2] ?? "";
    if (rest === "" && method === "DELETE") {
      this.deleted = true;
      this.stop();
      return json({ ok: true });
    }
    if (rest === "/decide/policy") return json({ enabled: false });
    if (rest === "/swarm/stop") return json({ ok: true, retired: this.agents.size });
    if (rest.startsWith("/certifications")) return json({ on: false, results: [] });
    if (rest === "/metrics") return json({ metrics: { ...this.metrics } });
    if (rest === "/agents" && method === "POST") {
      const id = this.id("agt_");
      this.agents.set(id, { intentId: null });
      return json({ id }, 201);
    }
    if (rest === "/intents" && method === "POST") {
      const id = this.id("int_");
      const it: Intent = { id, status: body.assignedTo ? "claimed" : "open", assignedTo: body.assignedTo ?? null, footprint: body.footprint, leased: false };
      this.intents.set(id, it);
      if (body.assignedTo) this.agents.get(body.assignedTo)!.intentId = id;
      return json(it, 201);
    }
    let x = /^\/intents\/([^/]+)$/.exec(rest);
    if (x && method === "GET") return this.intents.has(x[1]!) ? json(this.intents.get(x[1]!)) : json({ error: "no intent" }, 404);
    x = /^\/agents\/([^/]+)\/take$/.exec(rest);
    if (x) return json(this.take(x[1]!));
    if (/^\/agents\/[^/]+\/heartbeat$/.test(rest)) return json({ ok: true });
    if (rest === "/proposals" && method === "POST") {
      const r = this.propose(body);
      return typeof r === "string" ? json({ error: r }, 400) : json(r, 201);
    }
    x = /^\/proposals\/([^/]+)$/.exec(rest);
    if (x && method === "GET") return this.proposals.has(x[1]!) ? json(this.proposals.get(x[1]!)) : json({ error: "no proposal" }, 404);
    return json({ error: `fake: ${method} ${rest} is not served` }, 404);
  };

  private take(agentId: string): unknown {
    const a = this.agents.get(agentId);
    const it = a?.intentId ? this.intents.get(a.intentId) : undefined;
    if (!a || !it || it.status !== "claimed" || it.assignedTo !== agentId) return { wait: true, retryInMs: 20, reason: "no open intents" };
    if (!it.leased && this.opts.leaseFailEvery && ++this.takes % this.opts.leaseFailEvery === 0) {
      it.status = "open";
      it.assignedTo = null;
      a.intentId = null;
      return { wait: true, retryInMs: 10, reason: "pool empty" };
    }
    it.leased = true;
    return {
      intent: { id: it.id, footprint: it.footprint, status: "claimed", assignedTo: agentId },
      lease: { repo: { namespace: "ws", name: "ws-1", remote: "https://fake.test/ws" }, token: "art_v1_fakeworkspacetoken", tokenExpiresAt: Date.now() + 3_600_000, baseSha: this.head, leasedAt: Date.now(), trunk: { remote: "https://fake.test/trunk", token: "art_v1_faketrunktoken", sha: this.head } },
    };
  }

  private propose(b: Record<string, any>): Prop | string {
    const writeSet = b.writeSet as FileVersion[];
    for (const w of writeSet) if (!w.blob || typeof b.contents?.[w.blob] !== "string" || blobId(b.contents[w.blob]) !== w.blob) return `inline contents do not match ${w.path}`;
    if (b.headSha !== changesetId(b.baseSha, writeSet)) return "headSha is not the changeset id";
    if (!this.commits.has(b.baseSha)) return "unknown base";
    const it = this.intents.get(b.intentId);
    if (!it || it.assignedTo !== b.agentId) return "the intent is not held by this agent";
    it.status = "proposed";
    const p: Prop = { id: this.id("prp_"), intentId: b.intentId, agentId: b.agentId, baseSha: b.baseSha, writeSet, readSet: b.readSet, contents: b.contents, status: "ready", createdAt: Date.now() };
    this.proposals.set(p.id, p);
    this.queue.push(p);
    this.metrics.proposals++;
    return p;
  }

  private settle(p: Prop, status: string, reason?: string): void {
    p.status = status;
    if (reason) p.reason = reason;
    const it = this.intents.get(p.intentId)!;
    const a = this.agents.get(p.agentId)!;
    if (status === "landed" || status === "already_on_trunk") it.status = status === "landed" ? "landed" : "closed";
    else {
      it.status = "open";
      it.assignedTo = null;
      this.metrics.returned++;
    }
    if (a.intentId === p.intentId) a.intentId = null;
  }

  /** One trunk writer cycle: every queued proposal, in order, against the trunk and the ones accepted ahead of it. */
  private cycle(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, 50);
    const virtual = new Map(this.commits.get(this.head)!.files);
    const accepted: Array<{ p: Prop; writeSet: FileVersion[]; merged: Array<{ path: string; rule?: string }> }> = [];
    for (const p of batch) {
      const blobOf = (path: string): string | null => (virtual.has(path) ? blobId(virtual.get(path)!) : null);
      const stale = this.opts.skipOcc ? [] : p.readSet.filter((r) => blobOf(r.path) !== (r.blob ?? null));
      const writes = new Map(p.writeSet.map((w) => [w.path, p.contents[w.blob!]!]));
      const merged: Array<{ path: string; rule?: string }> = [];
      if (stale.length > 0) {
        const written = stale.every((s) => writes.has(s.path));
        if (!this.opts.textMerge || !written) {
          this.settle(p, "returned", `stale: ${stale.map((s) => s.path).join(", ")} changed after this change read it`);
          continue;
        }
        const base = this.commits.get(p.baseSha)!.files;
        let conflict: string | null = null;
        for (const s of stale) {
          const r = mergeText(base.get(s.path) ?? "", virtual.get(s.path) ?? "", writes.get(s.path)!, undefined, { insertions: this.opts.insertions === true });
          if (!r.clean) {
            conflict = `stale: ${s.path} changed after this change read it; text merge of ${s.path}: ${r.conflicts} conflicting hunk${r.conflicts === 1 ? "" : "s"}, at line ${r.lines.join(", ")} of its base`;
            break;
          }
          writes.set(s.path, r.text);
          merged.push({ path: s.path, ...(r.rule ? { rule: r.rule } : {}) });
        }
        if (conflict) {
          this.settle(p, "returned", conflict);
          continue;
        }
        if (this.opts.alreadyOnTrunk && [...writes].every(([path, text]) => virtual.get(path) === text)) {
          this.settle(p, "already_on_trunk", "already on trunk: what this change writes is there already");
          this.metrics.alreadyOnTrunk++;
          continue;
        }
      }
      for (const [path, text] of writes) virtual.set(path, text);
      accepted.push({ p, writeSet: [...writes].map(([path, text]) => ({ path, blob: blobId(text) })), merged });
    }
    if (accepted.length === 0) return;
    const sha = hex(++this.seq, "commit");
    const landingId = this.id("lnd_");
    const note = JSON.stringify({
      schema: "firetrident.lineage/v1",
      landingId,
      colonyId: this.colony,
      proposals: accepted.map((a) => ({ id: a.p.id, agentId: a.p.agentId, writeSet: a.writeSet, readSet: a.p.readSet, ...(a.merged.length > 0 ? { merged: a.merged } : {}) })),
    });
    this.commits.set(sha, { sha, parent: this.head, files: virtual, note, at: Date.now() });
    this.head = sha;
    this.metrics.landings++;
    for (const a of accepted) {
      a.p.landingId = landingId;
      this.settle(a.p, "landed");
      this.metrics.landedProposals++;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // The trunk reader.
  async ensure(sha: string): Promise<boolean> {
    return this.commits.has(sha);
  }
  async read(sha: string, path: string): Promise<string | null> {
    return this.commits.get(sha)?.files.get(path) ?? null;
  }
  async refresh(): Promise<string | null> {
    return this.head;
  }
  async history(): Promise<TrunkCommit[]> {
    const out: TrunkCommit[] = [];
    for (let c = this.commits.get(this.head); c; c = c.parent ? this.commits.get(c.parent) : undefined) out.push({ sha: c.sha, parent: c.parent, note: c.note, ...(c.at !== undefined ? { at: c.at } : {}) });
    return out;
  }
  async tree(sha: string): Promise<Map<string, string>> {
    return new Map(this.commits.get(sha)?.files ?? []);
  }
  close(): void {
    this.stop();
  }
}
