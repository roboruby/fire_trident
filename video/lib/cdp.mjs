// A minimal Chrome DevTools Protocol client: launch headless Chrome, open a page target
// (flattened session over the browser socket), send commands, and listen for events.
// Node 24's global WebSocket is enough; nothing to install.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const CHROME = process.env.FT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One WebSocket to the browser; page sessions share it (Target.attachToTarget flatten). */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => this.#onMessage(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")));
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }

  #onMessage(text) {
    const msg = JSON.parse(text);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    const key = `${msg.sessionId ?? ""}|${msg.method}`;
    for (const h of this.handlers.get(key) ?? []) h(msg.params ?? {});
  }

  /** Send a command (to a page session when sessionId is set). */
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const body = { id, method, params };
    if (sessionId) body.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(body));
    });
  }

  /** Subscribe to an event; returns an unsubscribe function. */
  on(method, handler, sessionId) {
    const key = `${sessionId ?? ""}|${method}`;
    const list = this.handlers.get(key) ?? [];
    list.push(handler);
    this.handlers.set(key, list);
    return () => this.handlers.set(key, (this.handlers.get(key) ?? []).filter((h) => h !== handler));
  }

  /** Resolve on the next matching event (or reject after timeoutMs). */
  once(method, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(
        method,
        (params) => {
          clearTimeout(timer);
          off();
          resolve(params);
        },
        sessionId,
      );
    });
  }
}

/** Launch headless Chrome with a throwaway profile; returns { cdp, close }. */
export async function launch({ profileDir, width = 1920, height = 1080, headless = true }) {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  const args = [
    headless ? "--headless=new" : "",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--password-store=basic",
    "--use-mock-keychain",
    "about:blank",
  ].filter(Boolean);
  const proc = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  const portFile = join(profileDir, "DevToolsActivePort");
  const t0 = Date.now();
  while (!existsSync(portFile)) {
    if (Date.now() - t0 > 20_000 || proc.exitCode !== null) throw new Error(`Chrome did not start: ${stderr}`);
    await sleep(50);
  }
  let lines = [];
  while (lines.length < 2) {
    lines = readFileSync(portFile, "utf8").trim().split("\n");
    if (lines.length < 2) await sleep(50);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("could not open the CDP socket")), { once: true });
  });
  const cdp = new Cdp(ws);
  return {
    cdp,
    async close() {
      try {
        await Promise.race([cdp.send("Browser.close"), sleep(2000)]);
      } catch {}
      try {
        ws.close();
      } catch {}
      await Promise.race([new Promise((r) => proc.once("exit", r)), sleep(3000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
}

/** A page target with its own session: send/on/once scoped to it. */
export async function newPage(cdp, { width = 1920, height = 1080 } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = {
    targetId,
    sessionId,
    send: (method, params) => cdp.send(method, params, sessionId),
    on: (method, handler) => cdp.on(method, handler, sessionId),
    once: (method, timeoutMs) => cdp.once(method, sessionId, timeoutMs),
    close: () => cdp.send("Target.closeTarget", { targetId }).catch(() => {}),
  };
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 5, g: 7, b: 11, a: 1 } });
  return page;
}

/** Evaluate an expression in the page and return its JSON value (awaits promises). */
export async function evaluate(page, expression) {
  const r = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
  }
  return r.result?.value;
}

/** Poll an expression until it is truthy (real time). */
export async function waitFor(page, expression, { timeoutMs = 30_000, intervalMs = 100, what = expression } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await evaluate(page, expression);
    } catch {
      v = undefined;
    }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** Press a key (keyDown + keyUp) the way a person would. */
export async function press(page, key) {
  const codes = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, PageDown: 34, PageUp: 33, Escape: 27, Enter: 13, " ": 32 };
  const vk = codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const code = key === " " ? "Space" : key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.send("Input.dispatchKeyEvent", { type: key.length === 1 ? "keyDown" : "rawKeyDown", ...base, ...(key.length === 1 ? { text: key } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Click at a point in CSS pixels. */
export async function click(page, x, y) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
