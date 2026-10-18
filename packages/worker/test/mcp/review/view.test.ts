import { describe, expect, it } from "vitest";
import { WEB, escalated, context } from "./fixtures.ts";
import { reviewCard, reviewQueue } from "../../../src/mcp/review/card.ts";
import { REVIEW_VIEW_JS, reviewAppHtml } from "../../../src/mcp/review/app.ts";
import { VIEW_BRIDGE_JS } from "../../../src/mcp/apps/bridge.ts";
import { UI_PROTOCOL_VERSION } from "../../../src/mcp/apps/protocol.ts";
import { DECISION_CODE_META } from "../../../src/mcp/review/codes.ts";

/**
 * The review view's message handling against a fake host: the view's own script, run in a fresh JavaScript context with
 * a small stand-in for the DOM and the host window. The host talks to it as the MCP Apps specification says (ui/initialize,
 * then tool input and result notifications), and the test plays the reviewer: it reads what was drawn, types and clicks.
 */

interface Vm {
  runInNewContext(code: string, sandbox: object): unknown;
}
const VM = "node:vm";
const vm = (await import(VM)) as Vm;

type Listener = (e: { type: string; target: FakeNode }) => void;

/** A DOM element as far as the view uses one: children, text, class, attributes, value, disabled, events, style. */
class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attrs: Record<string, string> = {};
  className = "";
  value = "";
  disabled = false;
  own = "";
  listeners: Record<string, Listener[]> = {};
  style: Record<string, unknown> & { setProperty(name: string, value: string): void; props: Record<string, string> };
  constructor(readonly tagName: string) {
    const props: Record<string, string> = {};
    this.style = { props, setProperty: (name: string, value: string) => void (props[name] = value) };
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.own = String(v);
  }
  appendChild(c: FakeNode): FakeNode {
    c.parent?.removeChild(c);
    this.children.push(c);
    c.parent = this;
    return c;
  }
  removeChild(c: FakeNode): FakeNode {
    this.children = this.children.filter((x) => x !== c);
    c.parent = null;
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  getBoundingClientRect(): { height: number; width: number } {
    return { height: 20 * this.all().length, width: 400 };
  }
  /** Fire an event; a disabled control fires no click, as in a browser. */
  fire(type: string): void {
    if (type === "click" && this.disabled) return;
    for (const fn of this.listeners[type] ?? []) fn({ type, target: this });
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  find(pred: (n: FakeNode) => boolean): FakeNode[] {
    return this.all().filter(pred);
  }
}

type Message = Record<string, any>;

/** The view loaded in a fake frame, with its host: what it sent, and how to answer it. */
function load(mode: "queue" | "card") {
  const html = reviewAppHtml(mode);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
  const sent: Message[] = [];
  const host = { postMessage: (m: unknown, target: string) => void sent.push({ ...(JSON.parse(JSON.stringify(m)) as Message), target }) };
  const stranger = { postMessage: () => undefined };
  const documentElement = new FakeNode("html");
  const body = new FakeNode("body");
  const app = new FakeNode("main");
  documentElement.appendChild(body);
  body.appendChild(app);
  const created: FakeNode[] = [];
  const document = {
    documentElement,
    body,
    getElementById: (id: string) => (id === "app" ? app : null),
    createElement: (tag: string) => {
      const n = new FakeNode(tag);
      created.push(n);
      return n;
    },
  };
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const stored = new Map<string, string>();
  const window = {
    parent: host,
    innerWidth: 420,
    addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
      if (type === "message") listeners.push(fn);
    },
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) },
  };
  vm.runInNewContext(script, { window, document });
  const deliver = (data: unknown, source: unknown = host) => {
    for (const fn of listeners) fn({ source, data: JSON.parse(JSON.stringify(data)) });
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { html, script, sent, host, stranger, app, created, deliver, settle, documentElement, stored };
}

/** Run the handshake as a host does: answer ui/initialize, then wait for initialized. */
async function handshake(v: ReturnType<typeof load>, hostContext: object = {}) {
  const init = v.sent.find((m) => m.method === "ui/initialize");
  v.deliver({ jsonrpc: "2.0", id: init?.id, result: { protocolVersion: UI_PROTOCOL_VERSION, hostInfo: { name: "fake-host", version: "1" }, hostCapabilities: { serverTools: {} }, hostContext } });
  await v.settle();
}

/** A decision code as review_card's result carries it for the view (its value matters only to the server). */
const CODE = "mgx0abc.0123456789abcdef0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** review_card's result as the host passes it on: text, data, and the code in `_meta` (left out with `meta: false`). */
const cardData = (meta = true) => {
  const c = reviewCard("hono", escalated("prp_1"), context(["prp_1"]), WEB);
  const { text, ...structured } = c;
  return { content: [{ type: "text", text }], structuredContent: structured, ...(meta ? { _meta: { [DECISION_CODE_META]: CODE } } : {}) };
};

const byText = (root: FakeNode, text: string) => root.find((n) => n.tagName === "button" && n.textContent === text)[0]!;
const calls = (v: ReturnType<typeof load>) => v.sent.filter((m) => m.method === "tools/call");

describe("review view: the handshake", () => {
  it("opens with ui/initialize (its info, capabilities and the protocol version) and sends nothing else until the host answers", async () => {
    const v = load("card");
    await v.settle();
    expect(v.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: { appInfo: { name: "firetrident-review", version: "0.0.1" }, appCapabilities: { availableDisplayModes: ["inline"] }, protocolVersion: "2026-01-26" },
        target: "*",
      },
    ]);
    await handshake(v, { theme: "dark", styles: { variables: { "--color-text-primary": "#fafafa", "bad name": "x" } }, containerDimensions: { maxHeight: 600 } });
    expect(v.sent[1]).toEqual({ jsonrpc: "2.0", method: "ui/notifications/initialized", target: "*" });
    // It takes the host's theme and style variables, and reports its size.
    expect(v.documentElement.attrs["data-theme"]).toBe("dark");
    expect(v.documentElement.style.props).toEqual({ "--color-text-primary": "#fafafa" });
    expect(v.documentElement.style.maxHeight).toBe("600px");
    expect(v.sent.some((m) => m.method === "ui/notifications/size-changed" && m.params.width === 420 && m.params.height > 0)).toBe(true);
  });

  it("answers ping and teardown, refuses other requests, and ignores messages from anywhere but the host", async () => {
    const v = load("card");
    await handshake(v);
    v.deliver({ jsonrpc: "2.0", id: 7, method: "ping" });
    v.deliver({ jsonrpc: "2.0", id: 8, method: "ui/resource-teardown", params: { reason: "closed" } });
    v.deliver({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(v.sent.filter((m) => m.id === 7 || m.id === 8)).toEqual([
      { jsonrpc: "2.0", id: 7, result: {}, target: "*" },
      { jsonrpc: "2.0", id: 8, result: {}, target: "*" },
    ]);
    expect(v.sent.find((m) => m.id === 9)?.error).toMatchObject({ code: -32601 });
    // A tool result from another window, or a message that is not JSON-RPC 2.0, draws nothing.
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: cardData() }, v.stranger);
    v.deliver({ method: "ui/notifications/tool-result", params: cardData() });
    await v.settle();
    expect(v.app.textContent).toBe("");
    expect(v.app.find((n) => n.tagName === "h1")).toEqual([]);
  });
});

describe("review view: a card", () => {
  it("draws the change from the tool result as text: agent-written markup stays text, and nothing decides on load", async () => {
    const v = load("card");
    await handshake(v);
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { colony: "hono", proposalId: "prp_1" } } });
    expect(v.app.textContent).toBe("Reading change prp_1…");
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: cardData() });
    await v.settle();
    const text = v.app.textContent;
    expect(v.app.find((n) => n.tagName === "h1")[0]?.textContent).toBe("Accept tokens <b>prp_1</b>");
    expect(text).toContain("Read the token from the header. <script>alert(1)</script>");
    expect(text).toContain("const shown = '<img src=x onerror=alert(1)>';");
    expect(text).toContain("Look here first");
    expect(text).toContain("src/app/main.ts:2");
    // Markup in agent text never became elements: only the view's own tags were created.
    expect(new Set(v.created.map((n) => n.tagName))).toEqual(new Set(["p", "div", "span", "h1", "h2", "details", "summary", "button", "input", "label", "textarea"]));
    // Who said what: each run and the statement of what was not verified carry their speaker.
    const labels = v.app.find((n) => n.className.startsWith("said ")).map((n) => n.textContent);
    expect(labels).toEqual(expect.arrayContaining(["agent's claim", "checked by FireTrident", "model (@cf/model-a)", "model (@cf/model-b)"]));
    // The danger line is marked in its diff.
    expect(v.app.find((n) => n.className === "dl dl-add is-hit").map((n) => n.textContent)).toContain("2+const token = req.header('Authorization');");
    expect(calls(v)).toEqual([]);
    expect(v.sent.filter((m) => m.method === "ui/notifications/size-changed").length).toBeGreaterThanOrEqual(1);
  });

  it("approves only on a click with a name and a reason, once, and shows what happened", async () => {
    const v = load("card");
    await handshake(v);
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: cardData() });
    await v.settle();
    const approve = byText(v.app, "Approve");
    const giveBack = byText(v.app, "Return to the agent");
    const [name] = v.app.find((n) => n.tagName === "input");
    const [reason] = v.app.find((n) => n.tagName === "textarea");
    expect(approve.disabled).toBe(true);
    expect(giveBack.disabled).toBe(true);
    approve.fire("click");
    name!.value = "Matt";
    name!.fire("input");
    expect(approve.disabled).toBe(true);
    approve.fire("click");
    expect(calls(v)).toEqual([]);
    reason!.value = "  Read the header code; fine.  ";
    reason!.fire("input");
    expect(approve.disabled).toBe(false);
    approve.fire("click");
    approve.fire("click");
    giveBack.fire("click");
    expect(calls(v)).toEqual([
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "decide", arguments: { colony: "hono", proposalId: "prp_1", decision: "approve", reason: "Read the header code; fine.", by: "Matt", code: CODE } }, target: "*" },
    ]);
    expect(approve.disabled).toBe(true);
    v.deliver({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "Approved by Matt: prp_1 rejoins its lane and lands on the next cycle." }], structuredContent: { kind: "decided", text: "Approved by Matt: prp_1 rejoins its lane and lands on the next cycle." } } });
    await v.settle();
    expect(v.app.find((n) => n.className === "status is-ok")[0]?.textContent).toBe("Approved by Matt: prp_1 rejoins its lane and lands on the next cycle.");
    approve.fire("click");
    expect(calls(v)).toHaveLength(1);
    expect(v.stored.get("firetrident-review-name")).toBe("Matt");
  });

  it("returns with the reason, and lets the reviewer try again after a refusal", async () => {
    const v = load("card");
    await handshake(v);
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: cardData() });
    await v.settle();
    const giveBack = byText(v.app, "Return to the agent");
    const [name] = v.app.find((n) => n.tagName === "input");
    const [reason] = v.app.find((n) => n.tagName === "textarea");
    name!.value = "Matt";
    reason!.value = "Check the header before reading it.";
    reason!.fire("input");
    giveBack.fire("click");
    const first = calls(v)[0]!;
    expect(first.params.arguments).toEqual({ colony: "hono", proposalId: "prp_1", decision: "return", reason: "Check the header before reading it.", by: "Matt", code: CODE });
    v.deliver({ jsonrpc: "2.0", id: first.id, result: { isError: true, content: [{ type: "text", text: "{}" }], structuredContent: { error: { kind: "conflict", message: "Change prp_1 does not wait for a person (it is ready): nothing was decided." } } } });
    await v.settle();
    expect(v.app.find((n) => n.className === "status is-bad")[0]?.textContent).toBe("Change prp_1 does not wait for a person (it is ready): nothing was decided.");
    expect(giveBack.disabled).toBe(false);
    giveBack.fire("click");
    expect(calls(v)).toHaveLength(2);
  });
});

describe("review view: the decision code", () => {
  it("keeps the code to itself, and decides nothing without one: the web review queue instead", async () => {
    const v = load("card");
    await handshake(v);
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: cardData() });
    await v.settle();
    expect(v.app.textContent).not.toContain(CODE);
    expect(v.app.all().some((n) => Object.values(n.attrs).some((a) => a.includes(CODE)))).toBe(false);
    // A host that does not pass the result's _meta to the view: no buttons, a link to the web review queue.
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: cardData(false) });
    await v.settle();
    expect(v.app.find((n) => n.tagName === "button")).toEqual([]);
    expect(v.app.textContent).toContain(`decide this change in the web review queue at ${WEB}.`);
    expect(calls(v)).toEqual([]);
  });

  it("after a refusal of the code, the card decides no more and says to open the change again", async () => {
    const v = load("card");
    await handshake(v);
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: cardData() });
    await v.settle();
    const approve = byText(v.app, "Approve");
    const [name] = v.app.find((n) => n.tagName === "input");
    const [reason] = v.app.find((n) => n.tagName === "textarea");
    name!.value = "Matt";
    reason!.value = "fine";
    reason!.fire("input");
    approve.fire("click");
    const sentence = `Decisions are made by clicking Approve or Return in the review view, or in the web review queue at ${WEB}.`;
    v.deliver({ jsonrpc: "2.0", id: calls(v)[0]!.id, result: { isError: true, content: [{ type: "text", text: "{}" }], structuredContent: { error: { kind: "auth", status: 403, message: sentence } } } });
    await v.settle();
    expect(v.app.find((n) => n.className === "status is-bad")[0]?.textContent).toBe(`${sentence} This card can no longer decide: open the change again to decide it here.`);
    expect(approve.disabled).toBe(true);
    approve.fire("click");
    expect(calls(v)).toHaveLength(1);
  });
});

describe("review view: the queue", () => {
  it("lists what waits and opens a change through review_card, with a way back", async () => {
    const v = load("queue");
    await handshake(v);
    const q = reviewQueue("hono", [escalated("prp_1"), escalated("prp_2")], context(["prp_1", "prp_2"]), WEB);
    const { text, ...structured } = q;
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { colony: "hono" } } });
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text }], structuredContent: structured } });
    await v.settle();
    expect(v.app.find((n) => n.tagName === "h1")[0]?.textContent).toBe("2 changes wait for a person in hono");
    expect(v.app.find((n) => n.className === "title").map((n) => n.textContent)).toEqual(["Accept tokens <b>prp_1</b>", "Accept tokens <b>prp_2</b>"]);
    expect(calls(v)).toEqual([]);
    v.app.find((n) => n.tagName === "button" && n.textContent === "Open")[1]!.fire("click");
    const open = calls(v)[0]!;
    expect(open.params).toEqual({ name: "review_card", arguments: { colony: "hono", proposalId: "prp_2" } });
    v.deliver({ jsonrpc: "2.0", id: open.id, result: cardData() });
    await v.settle();
    expect(v.app.find((n) => n.tagName === "h1")[0]?.textContent).toBe("Accept tokens <b>prp_1</b>");
    byText(v.app, "Back to the queue").fire("click");
    expect(v.app.find((n) => n.tagName === "h1")[0]?.textContent).toBe("2 changes wait for a person in hono");
  });

  it("shows a failed call's sentence, and a plain text result as text", async () => {
    const v = load("queue");
    await handshake(v);
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { isError: true, content: [{ type: "text", text: "x" }], structuredContent: { error: { message: "There is no colony \"nope\"." } } } });
    await v.settle();
    expect(v.app.textContent).toBe('There is no colony "nope".');
    v.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "<b>plain</b>" }] } });
    await v.settle();
    expect(v.app.find((n) => n.tagName === "pre")[0]?.textContent).toBe("<b>plain</b>");
  });
});

describe("review view: the document", () => {
  it("is one self-contained document whose script sets text, never markup, and fetches nothing", () => {
    for (const mode of ["queue", "card"] as const) {
      const html = reviewAppHtml(mode);
      expect(html.match(/<script>/g)).toHaveLength(1);
      expect(html.match(/<\/script>/g)).toHaveLength(1);
      expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\';');
      expect(html).toContain("connect-src 'none'");
    }
    for (const js of [VIEW_BRIDGE_JS, REVIEW_VIEW_JS]) {
      expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\("on|\.src\s*=|\.href\s*=/);
      expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/);
      expect(js).not.toMatch(/<\/script|<!--/i);
    }
  });
});
