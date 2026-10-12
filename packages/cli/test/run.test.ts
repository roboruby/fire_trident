import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/run.ts";
import type { Io } from "../src/run.ts";

interface Seen {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

const seen: Seen[] = [];
let wsAuth: string | undefined;
let importPolls = 0;
let server: Server;
let base = "";

const snapshot = {
  colony: { id: "web", name: "web", trunk: { namespace: "ft-trunk", name: "web--trunk", remote: "https://x" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1, source: { url: "https://github.com/org/web", branch: "main" } },
  files: [{ path: "src/a.ts", size: 10 }, { path: "lib/b.ts", size: 5 }, { path: "README.md", size: 3 }],
  intents: [{ id: "int_1", colonyId: "web", title: "Remove console.log from src/a.ts", why: "rule", source: "rule", ruleId: "rule_1", footprint: ["src/a.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "rule" }],
  agents: [],
  recentLandings: [],
  violations: { total: 1, byRule: { rule_1: 1 } },
  funnel: { reflex: 3, llm: 1, human: 0 },
  metrics: {},
  rules: [{ id: "rule_1", colonyId: "web", kind: "forbid-pattern", spec: {}, description: "No console", approvedBy: "tester", createdAt: 0 }],
};

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const entry: Seen = { method: req.method ?? "", url: req.url ?? "", body };
    if (req.headers.authorization) entry.auth = req.headers.authorization;
    seen.push(entry);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const route = `${req.method} ${(req.url ?? "").split("?")[0]}`;
    switch (route) {
      case "GET /api/colonies/web":
        return json(200, snapshot);
      case "POST /api/colonies":
        return json(201, { colony: { id: "col_new", name: (body as { name: string }).name } });
      case "GET /api/colonies/col_new":
        importPolls++;
        return importPolls < 3 ? json(409, { error: "import in progress" }) : json(200, { ...snapshot, colony: { ...snapshot.colony, id: "col_new", name: "repo" } });
      case "POST /api/colonies/web/rules":
        return json(200, { rule: { id: "rule_9" }, violations: 214, intents: 214 });
      case "GET /api/colonies/web/review":
        return json(200, []);
      case "POST /api/colonies/web/review/prp_1":
        return json(200, { ok: true });
      case "GET /api/colonies/web/why":
        return json(200, [
          {
            landing: { id: "lnd_1", colonyId: "web", trunkSha: "b".repeat(40), parentSha: "a".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: 1_000 },
            note: {
              schema: "firetrident.lineage/v1",
              landingId: "lnd_1",
              colonyId: "web",
              proposals: [
                {
                  id: "prp_1",
                  agentId: "agt_7",
                  agentKind: "internal",
                  model: "m1",
                  intent: { id: "int_1", title: "Remove console.log from src/a.ts", why: "Rule rule_1 found a violation", ruleId: "rule_1" },
                  writeSet: [{ path: "src/a.ts", blob: "c".repeat(40) }],
                  readSet: [{ path: "src/a.ts", blob: "d".repeat(40) }],
                  decisions: [{ kind: "triage", layer: "reflex", p: 0.97, action: "land" }],
                  evidence: { checks: [{ name: "typecheck", ok: true, ms: 1200 }], notVerified: "runtime behavior" },
                },
              ],
            },
          },
        ]);
      default:
        return json(404, { error: `no route ${route}` });
    }
  });
  server.on("upgrade", (req, socket) => {
    wsAuth = req.headers.authorization;
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(frame(JSON.stringify({ t: "mark", at: 0, region: "src", path: "src/a.ts", kind: "claim", value: 1 })));
    socket.write(frame(JSON.stringify([
      { t: "landing", at: 0, landingId: "lnd_1", trunkSha: "b".repeat(40), proposalIds: ["prp_1"], paths: ["src/a.ts"] },
      { t: "violations", at: 0, total: 0, byRule: { rule_1: 0 } },
    ])));
    socket.on("data", (buf: Buffer) => {
      if (((buf[0] ?? 0) & 0x0f) === 8) {
        socket.write(Buffer.from([0x88, 0x00]));
        socket.end();
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  seen.length = 0;
});

function io(extra: Partial<Io> = {}): Io & { out: string[]; err: string[]; interrupt?: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const self: Io & { out: string[]; err: string[]; interrupt?: () => void } = {
    env: { FT_URL: base, FT_TOKEN: "tok", FT_USER: "tester", NO_COLOR: "1" },
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    isTTY: false,
    fetch: globalThis.fetch,
    readFile: async () => "",
    sleep: async () => {},
    now: () => 61_000,
    WebSocket: globalThis.WebSocket,
    onInterrupt: (fn) => {
      self.interrupt = fn;
    },
    out,
    err,
    ...extra,
  };
  return self;
}

describe("ft against a server", () => {
  it("prints a status summary", async () => {
    const t = io();
    expect(await main(["status", "web"], t)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toContain("web web  from https://github.com/org/web (main)");
    expect(text).toContain("3 in 3 regions");
    expect(text).toContain('1 left  rule_1 "No console" 1');
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/colonies/web", auth: "Bearer tok" });
  });

  it("prints raw JSON with --json", async () => {
    const t = io();
    expect(await main(["status", "web", "--json"], t)).toBe(0);
    expect(JSON.parse(t.out.join("\n"))).toEqual(snapshot);
  });

  it("adds a rule and reports the violations it found", async () => {
    const t = io();
    expect(await main(["rule", "add", "web", "--pattern", "console\\.log", "--hint", "Use the logger", "--description", "No console"], t)).toBe(0);
    expect(seen[0]?.body).toEqual({ colonyId: "web", kind: "forbid-pattern", spec: { pattern: "console\\.log", hint: "Use the logger" }, description: "No console", approvedBy: "tester" });
    expect(t.out.join("\n")).toMatch(/rule_9 added[\s\S]*214 violations → 214 intents/);
  });

  it("imports and waits until trunk has files", async () => {
    importPolls = 0;
    const t = io();
    expect(await main(["import", "org/repo", "--pool", "8"], t)).toBe(0);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/colonies", body: { name: "repo", source: { url: "https://github.com/org/repo" }, pool: 8 } });
    expect(importPolls).toBe(3);
    expect(t.out.join("\n")).toContain("Importing https://github.com/org/repo as repo col_new");
  });

  it("walks the lineage for why", async () => {
    const t = io();
    expect(await main(["why", "web", "src/a.ts:3"], t)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toContain("src/a.ts:3  1 landing, newest first");
    expect(text).toContain('intent   int_1 "Remove console.log from src/a.ts"');
    expect(text).toContain('rule     rule_1 "No console" approved by tester');
    expect(text).toContain("decided  reflex triage p=0.97 → land");
    expect(text).toContain("✓ typecheck 1.2s");
    expect(seen.map((s) => s.url).sort()).toEqual(["/api/colonies/web", "/api/colonies/web/why?path=src%2Fa.ts&line=3"]);
  });

  it("lists an empty review queue and decides a proposal", async () => {
    const t = io();
    expect(await main(["review", "web"], t)).toBe(0);
    expect(t.out.join("\n")).toContain("Review queue is empty");
    expect(await main(["review", "web", "prp_1", "reject", "--reason", "touches auth"], t)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/api/colonies/web/review/prp_1", body: { decision: "reject", reason: "touches auth", by: "tester" } });
    expect(t.out.join("\n")).toContain("Rejected prp_1: touches auth");
  });

  it("exits 1 with the server's error message", async () => {
    const t = io();
    expect(await main(["status", "missing"], t)).toBe(1);
    expect(t.err.join("\n")).toContain("GET /api/colonies/missing failed: 404 Not Found: no route GET /api/colonies/missing");
  });

  it("exits 2 on usage errors without calling the server", async () => {
    const t = io();
    expect(await main(["swarm", "web"], t)).toBe(2);
    expect(t.err[0]).toBe("ft: missing --agents");
    expect(seen).toHaveLength(0);
  });

  it("streams filtered live events and stops on Ctrl-C", async () => {
    const t = io();
    const done = main(["watch", "web", "--only", "landing,violations"], t);
    for (let i = 0; i < 200 && t.out.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    t.interrupt?.();
    expect(await done).toBe(0);
    expect(wsAuth).toBe("Bearer tok");
    expect(t.out).toHaveLength(2);
    expect(t.out[0]).toMatch(/landing\s+bbbbbbb 1 proposal, 1 path src\/a\.ts$/);
    expect(t.out[1]).toMatch(/violations 0 left \(rule_1 0\)$/);
  });

  it("streams raw JSON lines with --json", async () => {
    const t = io();
    const done = main(["watch", "web", "--json"], t);
    for (let i = 0; i < 200 && t.out.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    t.interrupt?.();
    expect(await done).toBe(0);
    expect(t.out.map((l) => (JSON.parse(l) as { t: string }).t)).toEqual(["mark", "landing", "violations"]);
  });
});
