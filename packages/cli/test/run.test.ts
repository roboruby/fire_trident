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
/** What GET /review answers (the review test fills it). */
let reviewQueue: unknown[] = [];
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
      case "GET /api/colonies":
        return json(200, { total: 1, colonies: [{ id: "web", name: "web", createdAt: 0, trunkSha: "a".repeat(40), counters: { agentsActive: 2, intentsOpen: 1, landings: 7 } }] });
      case "GET /api/colonies/web/agents":
        return json(200, { total: 1, agents: [{ id: "agt_1", kind: "synthetic", state: "waiting", model: "m1", lastSeen: 60_000, running: true }] });
      case "POST /api/colonies/web/swarm/stop":
        return json(200, { ok: true, considered: 2, stopped: ["agt_1", "agt_2"], failed: [], retired: 2 });
      case "DELETE /api/colonies/web":
        return json(200, { colonyId: "web", found: true, ok: true, agents: { stopped: 2, failed: [] }, repos: { deleted: ["ft-trunk/web--trunk"], failed: [] }, objects: [{ object: "ColonyDO web", cleared: true }], unregistered: true });
      case "POST /api/colonies/web/vaccinate": {
        const n = (body as { count: number }).count;
        return json(202, { batch: "vb_1", requested: n, started: n, vaccines: Array.from({ length: n }, () => ({ proposalId: "prp_v", cls: "secret-log", paths: [] })), skipped: [] });
      }
      case "PATCH /api/colonies/web/intents/int_1":
        return json(200, {
          intent: { id: "int_1", title: "Greet", status: "claimed", revision: 2 },
          revision: { revision: 2, changed: ["why"], reason: (body as { reason: string }).reason, substantive: true },
          returned: 1,
          landed: [],
          confirmed: true,
          notified: [{ agentId: "agt_1", directiveId: "dir_1", delivery: "pushed" }],
        });
      case "POST /api/colonies/web/intents/int_1/withdraw":
        return json(200, {
          intent: { id: "int_1", colonyId: "web", title: "Greet", status: "landed" },
          returned: 0,
          landed: [{ proposalId: "prp_1", landingId: "lnd_9", trunkSha: "abcdef1234567890abcdef1234567890abcdef12" }],
          confirmed: true,
          notified: [{ agentId: "agt_1", directiveId: "dir_2", delivery: "inbox" }],
        });
      case "DELETE /api/colonies/web/rules/rule_1":
        return json(200, { rule: { id: "rule_1", description: "No console" }, withdrawn: 3, returned: 1, landed: [], confirmed: true, notified: [] });
      case "POST /api/colonies/web/agents/agt_1/directive":
        return json(201, { id: "dir_3", agentId: "agt_1", intentId: "int_1", message: (body as { message: string }).message, delivery: "pushed" });
      case "GET /api/colonies/web/intents/int_1":
        return json(200, {
          intent: { id: "int_1", title: "Greet", status: "claimed", revision: 2, why: "say bonjour", footprint: ["src/a.ts"], assignedTo: "agt_1" },
          revisions: [{ revision: 2, changed: ["why"], before: { why: "say hello" }, after: { why: "say bonjour" }, reason: "French UI", by: "tester", at: 1_000, substantive: true }],
          directives: [{ id: "dir_3", kind: "guidance", agentId: "agt_1", message: "keep it short", by: "tester", at: 2_000, deliveredAt: 2_500, via: "push" }],
        });
      case "GET /api/colonies/web/review":
        return json(200, reviewQueue);
      case "POST /api/colonies/web/review/prp_1":
        return json(200, { ok: true });
      case "GET /api/colonies/web/landings/lnd_1/tests":
        return json(200, {
          colonyId: "web",
          landingId: "lnd_1",
          trunkSha: "b".repeat(40),
          baseSha: "a".repeat(40),
          status: "certified",
          base: { sha: "a".repeat(40), status: "red", pass: 433, tests: 434, failing: 1, exact: true },
          certified: { sha: "b".repeat(40), status: "green", pass: 434, tests: 434, failing: 0 },
          lost: 0,
          reach: { earlier: 0, own: 0, later: 0, earlierFiles: [], ownFiles: [], checked: 12 },
          proof: { rungs: [{ rung: "model", count: 1 }], text: "model approval" },
          text: "433/434 at base, 434/434 certified, 0 lost · proof: model approval",
        });
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
    // The landing's test row (tests.ts), read beside the lineage.
    expect(text).toContain("delta    433/434 at base, 434/434 certified, 0 lost · proof: model approval");
    expect(text).toContain("         No earlier test reaches this change: no test file reaches its files.");
    expect(seen.map((s) => s.url).sort()).toEqual(["/api/colonies/web", "/api/colonies/web/landings/lnd_1/tests", "/api/colonies/web/why?path=src%2Fa.ts&line=3"]);
  });

  it("lists an empty review queue and decides a proposal", async () => {
    const t = io();
    expect(await main(["review", "web"], t)).toBe(0);
    expect(t.out.join("\n")).toContain("Review queue is empty");
    expect(await main(["review", "web", "prp_1", "reject", "--reason", "touches auth"], t)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/api/colonies/web/review/prp_1", body: { decision: "reject", reason: "touches auth", by: "tester" } });
    expect(t.out.join("\n")).toContain("Rejected prp_1: touches auth");
  });

  it("lists the queue code first, and every kept diff with --diff", async () => {
    const hunks = "@@ -1,1 +1,2 @@\n const a = 1;\n+console.log(process.env.API_TOKEN);";
    reviewQueue = [
      {
        id: "prp_2",
        intentId: "int_1",
        agentId: "agt_1",
        writeSet: [{ path: "src/a.ts", blob: "c" }],
        declared: { footprint: ["src/a.ts"], summary: "log less" },
        evidence: { checks: [] },
        status: "escalated",
        createdAt: 0,
        review: {
          files: [{ path: "src/a.ts", status: "modified", added: 1, removed: 0, hunks, truncated: false }],
          filesChanged: 1,
          danger: [{ path: "src/a.ts", line: 2, cls: "secret", pattern: "secret:logged", label: "secret (logged) at src/a.ts:2: console.log(process.env.API_TOKEN);" }],
          residual: [],
        },
      },
    ];
    try {
      const t = io();
      expect(await main(["review", "web"], t)).toBe(0);
      let text = t.out.join("\n");
      expect(text).toContain('prp_2  "Remove console.log from src/a.ts"');
      expect(text).toContain("    src/a.ts:2  secret (logged)");
      expect(text).toContain("      +    2  console.log(process.env.API_TOKEN);");
      expect(text).toContain("Full diffs: ft review web --diff");
      t.out.length = 0;
      expect(await main(["review", "web", "--diff"], t)).toBe(0);
      text = t.out.join("\n");
      expect(text).toContain("    src/a.ts  modified  +1 −0");
      expect(text).toContain("      +    2  console.log(process.env.API_TOKEN);  ← danger");
      expect(seen.filter((x) => x.url === "/api/colonies/web/review")).toHaveLength(2);
    } finally {
      reviewQueue = [];
    }
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

  it("lists colonies and agents, stops a swarm, vaccinates, and deletes", async () => {
    const t = io();
    expect(await main(["colonies"], t)).toBe(0);
    expect(t.out.join("\n")).toMatch(/web\s+2\s+1\s+0\s+7\s+0\s+0\s+aaaaaaa/);
    expect(await main(["agents", "web"], t)).toBe(0);
    expect(t.out.join("\n")).toMatch(/agt_1\s+synthetic\s+waiting\s+take\s+-\s+m1\s+just now/);
    expect(await main(["stop", "web", "--all"], t)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/api/colonies/web/swarm/stop", body: {}, auth: "Bearer tok" });
    expect(await main(["vaccinate", "web", "--count", "3"], t)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/api/colonies/web/vaccinate", body: { count: 3 } });
    expect(await main(["delete", "web"], t)).toBe(2);
    expect(await main(["delete", "web", "--yes"], t)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: "/api/colonies/web", auth: "Bearer tok" });
    const text = t.out.join("\n");
    expect(text).toContain("✓ Stopped 2 agents in web");
    expect(text).toContain("✓ Vaccinated web: 3 of 3 vaccines started (batch vb_1)");
    expect(text).toContain("✓ Deleted colony web");
  });

  it("falls back to ~/.config/firetrident/env for the server and token", async () => {
    const files: string[] = [];
    const config = `FT_URL=${base}\nFT_TOKEN=filetok\n`;
    const readFile = async (p: string) => {
      files.push(p);
      if (p === "/home/t/.config/firetrident/env") return config;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const t = io({ env: { HOME: "/home/t", NO_COLOR: "1", FT_USER: "tester" }, readFile });
    expect(await main(["colonies"], t)).toBe(0);
    expect(files).toEqual(["/home/t/.config/firetrident/env"]);
    expect(seen.at(-1)).toMatchObject({ url: "/api/colonies", auth: "Bearer filetok" });

    // The file's token never goes to another server.
    const other = io({ env: { HOME: "/home/t", NO_COLOR: "1", FT_URL: base.replace("127.0.0.1", "localhost") }, readFile });
    expect(await main(["colonies"], other)).toBe(0);
    expect(seen.at(-1)?.auth).toBeUndefined();

    // A missing file is fine.
    const none = io({ env: { HOME: "/nowhere", NO_COLOR: "1", FT_URL: base }, readFile });
    expect(await main(["colonies"], none)).toBe(0);
    expect(seen.at(-1)?.auth).toBeUndefined();
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

describe("changing direction from the CLI", () => {
  it("amends, withdraws, shows, retracts and directs", async () => {
    const t = io();
    expect(await main(["intent", "amend", "web", "int_1", "--why", "say bonjour", "--reason", "French UI"], t)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "PATCH", url: "/api/colonies/web/intents/int_1", body: { why: "say bonjour", reason: "French UI", by: "tester" } });
    expect(t.out.join("\n")).toContain('Amended int_1 "Greet" to r2: why changed');
    expect(t.out.join("\n")).toContain("1 change built on r1 stopped; agt_1 was told at once");

    expect(await main(["intent", "withdraw", "web", "int_1", "--reason", "not needed"], t)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/api/colonies/web/intents/int_1/withdraw", body: { reason: "not needed", by: "tester" } });
    expect(t.out.join("\n")).toContain("agt_1 will read it in its inbox");
    // The withdrawal lost the race to the trunk writer: the landing is named, with the command that undoes it.
    expect(t.out.join("\n")).toContain("! prp_1 already landed in abcdef1 as lnd_9; undo with ft revert web lnd_9");

    expect(await main(["intent", "show", "web", "int_1"], t)).toBe(0);
    expect(t.out.join("\n")).toMatch(/r2 +why changed by tester .*: "French UI"/);

    expect(await main(["rule", "retract", "web", "rule_1", "--reason", "logging is fine"], t)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: "/api/colonies/web/rules/rule_1", body: { reason: "logging is fine", by: "tester" } });
    expect(t.out.join("\n")).toContain("3 unlanded intents withdrawn; 1 change in flight stopped");

    expect(await main(["direct", "web", "agt_1", "keep", "it", "short"], t)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/api/colonies/web/agents/agt_1/directive", body: { message: "keep it short", by: "tester" } });
    expect(t.out.join("\n")).toContain("Directive dir_3 to agt_1 about int_1: delivered: the agent acts on it at its next step");
  });
});
