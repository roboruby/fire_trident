import { UI_PROTOCOL_VERSION } from "./protocol.ts";

/**
 * The view side of MCP Apps (specification 2026-01-26), as JavaScript a view inlines in its one HTML document: the
 * JSON-RPC 2.0 the view and its host speak over postMessage. It defines one function, `mcpAppBridge(win, doc, appInfo)`,
 * which returns the view's side of the conversation:
 * - `start()` sends `ui/initialize` (the view's info, its capabilities and the protocol version), applies the host
 *   context it answers with (theme, style variables, container size), sends `ui/notifications/initialized`, then
 *   reports the document's size with `ui/notifications/size-changed` whenever it changes.
 * - `request(method, params)` sends a request (for example `tools/call`) and resolves with its result or rejects with
 *   its error; `notify(method, params)` sends a notification.
 * - `on(method, handler)` receives the host's notifications (`ui/notifications/tool-input`, `tool-result`,
 *   `tool-cancelled`, ...). The host's `ping` and `ui/resource-teardown` requests are answered with an empty result,
 *   any other request with "method not found".
 * - `sizeChanged()` measures again after the view redraws.
 * Messages are taken only from the host window (the parent) and only when they are JSON-RPC 2.0; everything else is
 * ignored. It never fetches anything and touches no storage.
 */
export const VIEW_BRIDGE_JS = String.raw`
function mcpAppBridge(win, doc, appInfo) {
  var host = win.parent;
  var nextId = 1;
  var waiting = {};
  var handlers = {};
  var context = {};
  var lastWidth = -1;
  var lastHeight = -1;
  var scheduled = false;
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  function post(message) { host.postMessage(message, "*"); }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) {
    var message = { jsonrpc: "2.0", method: method };
    if (params !== undefined) message.params = params;
    post(message);
  }
  function applyContext(c) {
    if (!c || typeof c !== "object") return;
    for (var k in c) if (has(c, k)) context[k] = c[k];
    var root = doc.documentElement;
    if (c.theme === "light" || c.theme === "dark") {
      root.setAttribute("data-theme", c.theme);
      root.style.colorScheme = c.theme;
    }
    var vars = c.styles && typeof c.styles === "object" ? c.styles.variables : null;
    if (vars && typeof vars === "object") {
      for (var name in vars) if (has(vars, name) && /^--[A-Za-z0-9-]+$/.test(name) && typeof vars[name] === "string") root.style.setProperty(name, vars[name]);
    }
    var d = c.containerDimensions;
    if (d && typeof d === "object") {
      if (typeof d.height === "number") root.style.height = "100vh";
      else if (typeof d.maxHeight === "number" && d.maxHeight > 0) root.style.maxHeight = d.maxHeight + "px";
      if (typeof d.width === "number") root.style.width = "100vw";
      else if (typeof d.maxWidth === "number" && d.maxWidth > 0) root.style.maxWidth = d.maxWidth + "px";
    }
  }
  function measure() {
    scheduled = false;
    var html = doc.documentElement;
    var before = html.style.height;
    html.style.height = "max-content";
    var rect = typeof html.getBoundingClientRect === "function" ? html.getBoundingClientRect() : null;
    html.style.height = before;
    var height = Math.ceil(rect && typeof rect.height === "number" ? rect.height : 0);
    var width = Math.ceil(typeof win.innerWidth === "number" ? win.innerWidth : 0);
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    notify("ui/notifications/size-changed", { width: width, height: height });
  }
  function sizeChanged() {
    if (scheduled) return;
    scheduled = true;
    if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(measure);
    else win.setTimeout(measure, 0);
  }
  function watchSize() {
    sizeChanged();
    if (typeof win.ResizeObserver !== "function") return;
    var observer = new win.ResizeObserver(sizeChanged);
    observer.observe(doc.documentElement);
    if (doc.body) observer.observe(doc.body);
  }
  win.addEventListener("message", function (event) {
    if (!event || event.source !== host) return;
    var m = event.data;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
    if (typeof m.method === "string") {
      var params = m.params && typeof m.params === "object" ? m.params : {};
      if (m.id !== undefined && m.id !== null) {
        if (m.method === "ping" || m.method === "ui/resource-teardown") {
          if (handlers[m.method]) handlers[m.method](params);
          post({ jsonrpc: "2.0", id: m.id, result: {} });
        } else {
          post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } });
        }
        return;
      }
      if (m.method === "ui/notifications/host-context-changed") applyContext(params);
      if (handlers[m.method]) handlers[m.method](params);
      return;
    }
    if ((typeof m.id === "number" || typeof m.id === "string") && has(waiting, m.id)) {
      var w = waiting[m.id];
      delete waiting[m.id];
      if (m.error) w.reject(m.error);
      else w.resolve(m.result);
    }
  });
  function start() {
    return request("ui/initialize", { appInfo: appInfo, appCapabilities: { availableDisplayModes: ["inline"] }, protocolVersion: ${JSON.stringify(UI_PROTOCOL_VERSION)} }).then(function (result) {
      var r = result && typeof result === "object" ? result : {};
      applyContext(r.hostContext);
      notify("ui/notifications/initialized");
      watchSize();
      return r;
    });
  }
  return {
    start: start,
    request: request,
    notify: notify,
    on: function (method, handler) { handlers[method] = handler; },
    sizeChanged: sizeChanged,
    context: function () { return context; }
  };
}
`;
