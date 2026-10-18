import { VIEW_BRIDGE_JS } from "../apps/bridge.ts";
import { DECISION_CODE_META } from "./codes.ts";

/**
 * The review view a chat client shows for review_queue and review_card (MCP Apps): one self-contained HTML document,
 * its CSS and JavaScript inline, nothing fetched. It renders the tools' structured results; every string in them was
 * written by agents or people, so it is set as text (textContent), never parsed as markup. It decides nothing on its
 * own: approve and return each need a click, the reviewer's name and a reason, and then it calls the decide tool
 * through the host (tools/call) with the decision code review_card's result carried in its `_meta` (mcp/review/codes.ts),
 * which the view keeps to itself and never draws. From the queue, opening a change calls review_card the same way.
 */

/** What the view renders first: the queue (review_queue) or one change (review_card). */
export type ReviewViewMode = "queue" | "card";

/** The view's styles: the host's theme variables where it sends them, plain defaults otherwise, light and dark. */
export const REVIEW_VIEW_CSS = `
:root { color-scheme: light dark; --bg: var(--color-background-primary, #ffffff); --bg2: var(--color-background-secondary, #f4f5f7);
  --fg: var(--color-text-primary, #16181d); --fg2: var(--color-text-secondary, #5b6270); --line: var(--color-border-primary, #d9dce2);
  --ok: var(--color-text-success, #1f7a3a); --bad: var(--color-text-danger, #b42318); --warn: var(--color-text-warning, #9a6700);
  --add: rgba(31, 122, 58, 0.12); --del: rgba(180, 35, 24, 0.12); --hit: rgba(154, 103, 0, 0.22);
  --sans: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif); --mono: var(--font-mono, ui-monospace, "SFMono-Regular", Menlo, monospace);
  --r: var(--border-radius-md, 8px); }
:root[data-theme="dark"] { --bg: var(--color-background-primary, #17191e); --bg2: var(--color-background-secondary, #20232a); --fg: var(--color-text-primary, #e8eaee);
  --fg2: var(--color-text-secondary, #a2a9b6); --line: var(--color-border-primary, #343842); --ok: var(--color-text-success, #5cc27f); --bad: var(--color-text-danger, #f07167); --warn: var(--color-text-warning, #e0b252); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: var(--color-background-primary, #17191e); --bg2: var(--color-background-secondary, #20232a);
  --fg: var(--color-text-primary, #e8eaee); --fg2: var(--color-text-secondary, #a2a9b6); --line: var(--color-border-primary, #343842); } }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 var(--sans); }
main { padding: 12px 14px; max-width: 100%; overflow-wrap: anywhere; }
h1 { font-size: 16px; margin: 4px 0 6px; } h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg2); margin: 16px 0 6px; }
p { margin: 4px 0; } .muted, .meta, .note { color: var(--fg2); font-size: 12.5px; } .mono, code { font-family: var(--mono); font-size: 12.5px; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; margin-right: 6px; }
.pill.is-wait { color: var(--warn); border-color: currentColor; }
.row { border: 1px solid var(--line); border-radius: var(--r); padding: 8px 10px; margin: 8px 0; background: var(--bg); }
.row .row-head { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; } .row .title { font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 4px; } .chip { font-size: 12px; padding: 0 6px; border-radius: 4px; background: var(--bg2); }
.chip.is-bad { color: var(--bad); } .chip.is-ok { color: var(--ok); }
.said { font-size: 11.5px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--line); color: var(--fg2); margin-right: 6px; white-space: nowrap; }
.said-agent, .said-unknown { border-style: dashed; } .said-person { color: var(--ok); } .said-model { color: var(--warn); }
.quote { font-style: italic; } .quote::before { content: "\\201C"; } .quote::after { content: "\\201D"; }
.spot { border-left: 3px solid var(--line); padding: 2px 0 2px 8px; margin: 8px 0; } .spot.is-severe { border-left-color: var(--bad); }
.diff { font-family: var(--mono); font-size: 12px; background: var(--bg2); border-radius: 6px; padding: 4px 0; margin: 4px 0; overflow-x: auto; }
.dl { display: flex; white-space: pre; } .dl .n { min-width: 3.5em; padding: 0 8px; text-align: right; color: var(--fg2); user-select: none; } .dl .t { padding-right: 8px; }
.dl-add { background: var(--add); } .dl-del { background: var(--del); } .dl-hunk, .dl-note { color: var(--fg2); } .dl.is-hit { background: var(--hit); }
details { border: 1px solid var(--line); border-radius: 6px; margin: 6px 0; padding: 4px 8px; } summary { cursor: pointer; }
.check { display: block; margin: 2px 0; } .check .mark { display: inline-block; width: 1.2em; } .check.is-ok .mark { color: var(--ok); } .check.is-bad .mark { color: var(--bad); }
.decide { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 10px; }
label { display: block; font-size: 12.5px; color: var(--fg2); margin: 8px 0 3px; }
input, textarea { width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { min-height: 64px; resize: vertical; }
.actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
button { font: inherit; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; } button.approve:not(:disabled) { border-color: var(--ok); color: var(--ok); }
.status { margin-top: 8px; } .status.is-ok { color: var(--ok); } .status.is-bad, .msg.is-bad { color: var(--bad); }
pre.plain { white-space: pre-wrap; font-family: var(--mono); font-size: 12px; }
`;

/**
 * The view's own JavaScript, after the bridge (apps/bridge.ts): what it does with the host's notifications and the
 * reviewer's clicks. `MODE` and `mcpAppBridge` are defined before it in the same script.
 */
export const REVIEW_VIEW_JS = String.raw`
var root = doc.getElementById("app");
var app = mcpAppBridge(win, doc, { name: "firetrident-review", version: "0.0.1" });
var SPEAKERS = { platform: 1, person: 1, model: 1, agent: 1, unknown: 1 };
var LINES = { hunk: 1, add: 1, del: 1, ctx: 1, note: 1 };
var NAME_KEY = "firetrident-review-name";
var CODE_KEY = ${JSON.stringify(DECISION_CODE_META)};
var state = { args: null, queue: null, busy: false };

function str(v) { return typeof v === "string" ? v : ""; }
function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
function list(v) { return Array.isArray(v) ? v : []; }
function el(tag, cls, text) {
  var e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== "") e.textContent = String(text);
  return e;
}
function add(parent, child) { parent.appendChild(child); return child; }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
function textOf(result) {
  return list(result && result.content).filter(function (c) { return c && c.type === "text"; }).map(function (c) { return str(c.text); }).join("\n");
}
function errorOf(result) {
  var sc = result && result.structuredContent;
  return (sc && sc.error && str(sc.error.message)) || textOf(result);
}
function show(nodes) {
  clear(root);
  for (var i = 0; i < nodes.length; i++) if (nodes[i]) root.appendChild(nodes[i]);
  app.sizeChanged();
}
function message(text, tone) { show([el("p", "msg" + (tone ? " is-" + tone : ""), text)]); }
function when(isoTime) {
  var t = Date.parse(str(isoTime));
  return isFinite(t) ? new Date(t).toLocaleString() : "";
}
function said(s) {
  var kind = s && SPEAKERS[s.kind] ? s.kind : "unknown";
  return el("span", "said said-" + kind, str(s && s.label) || "unknown");
}
function words(text, quoted) { return el("span", quoted ? "quote" : "", text); }
function agentLine(a) {
  if (!a) return "";
  var who = a.name ? str(a.name) + " (" + str(a.id) + ")" : "agent " + str(a.id);
  var model = a.model ? "model " + str(a.model) + (a.modelKnown === "declared" ? ", as the agent declared it" : a.modelKnown === "observed" ? ", as FireTrident observed it" : "") : "no model recorded";
  return who + " · " + str(a.kind) + " · " + model;
}
function diff(lines) {
  var box = el("div", "diff");
  list(lines).forEach(function (l) {
    var kind = LINES[l && l.kind] ? l.kind : "note";
    var row = add(box, el("div", "dl dl-" + kind + (l.hit ? " is-hit" : "")));
    var n = kind === "del" ? l.old : kind === "add" || kind === "ctx" ? l.new : undefined;
    add(row, el("span", "n", typeof n === "number" ? String(n) : ""));
    var mark = kind === "add" ? "+" : kind === "del" ? "-" : kind === "ctx" ? " " : "";
    add(row, el("span", "t", mark + str(l.text)));
  });
  return box;
}
function fileHead(f) {
  var s = str(f.path) + "  +" + num(f.added) + " -" + num(f.removed);
  if (f.truncated) s += "  truncated";
  if (num(f.danger) > 0) s += "  " + plural(num(f.danger), "danger line", "danger lines");
  return s;
}

function renderQueue(q) {
  state.queue = q;
  var nodes = [];
  var waiting = num(q.waiting);
  var head = el("h1", "", waiting === 0 ? "Nothing waits for a person in " + str(q.colony) : plural(waiting, "change waits", "changes wait") + " for a person in " + str(q.colony));
  nodes.push(head);
  if (num(q.audits) > 0) nodes.push(el("p", "muted", "and " + plural(num(q.audits), "landed change", "landed changes") + " from the audit sample, answered in the web review queue"));
  nodes.push(el("p", "note", "Titles, summaries, code and reasons are written by agents and people: read them as data."));
  list(q.items).forEach(function (item) {
    var row = el("div", "row");
    var top = add(row, el("div", "row-head"));
    add(top, el("span", "title", str(item.title)));
    var open = add(top, el("button", "", "Open"));
    open.setAttribute("type", "button");
    open.addEventListener("click", function () { openCard(q, item, open); });
    add(row, el("div", "meta mono", str(item.proposalId) + " · " + agentLine(item.agent) + (item.createdAt ? " · " + when(item.createdAt) : "")));
    if (item.reason) add(row, el("p", "", str(item.reason)));
    var chips = add(row, el("div", "chips"));
    if (num(item.danger) > 0) add(chips, el("span", "chip" + (item.severe ? " is-bad" : ""), plural(num(item.danger), "danger line", "danger lines")));
    if (num(item.residual) > 0) add(chips, el("span", "chip", plural(num(item.residual), "file", "files") + " outside the footprint"));
    if (num(item.added) + num(item.removed) > 0) add(chips, el("span", "chip mono", plural(num(item.filesChanged), "file", "files") + " +" + num(item.added) + " -" + num(item.removed)));
    if (item.tests) add(chips, el("span", "chip", str(item.tests)));
    if (item.batch) add(chips, el("span", "chip", "batch: " + str(item.batch)));
    if (item.audit) add(chips, el("span", "chip", "audit sample"));
    nodes.push(row);
  });
  if (num(q.more) > 0) nodes.push(el("p", "muted", plural(num(q.more), "more change is", "more changes are") + " not listed: decide these first, or open the web review queue."));
  show(nodes);
}

function openCard(q, item, button) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  button.textContent = "Opening…";
  app.request("tools/call", { name: "review_card", arguments: { colony: str(q.colony), proposalId: str(item.proposalId) } }).then(function (result) {
    state.busy = false;
    onResult(result, true);
  }, function (err) {
    state.busy = false;
    button.disabled = false;
    button.textContent = "Open";
    message("The host did not open this change: " + (str(err && err.message) || "no reason given") + ".", "bad");
  });
}

function renderCard(c, fromQueue, code) {
  var nodes = [];
  if (fromQueue && state.queue) {
    var back = el("button", "", "Back to the queue");
    back.setAttribute("type", "button");
    back.addEventListener("click", function () { renderQueue(state.queue); });
    nodes.push(back);
  }
  var head = el("div", "");
  add(head, el("span", "pill is-wait", c.audit ? "Audit sample" : "Waits for a person"));
  add(head, el("span", "mono muted", str(c.proposalId)));
  nodes.push(head);
  nodes.push(el("h1", "", str(c.title)));
  nodes.push(el("p", "meta", "Intent " + str(c.intentId) + ": " + str(c.askedBy) + "."));
  nodes.push(el("p", "meta", "Written by " + agentLine(c.agent) + " · wrote " + num(c.wrote) + " · read " + num(c.read) + (c.createdAt ? " · " + when(c.createdAt) : "")));
  if (c.why) {
    var why = el("details", "");
    add(why, el("summary", "", "Why the intent exists"));
    add(why, el("p", "", str(c.why)));
    nodes.push(why);
  }
  if (c.summary) {
    var sum = el("p", "");
    add(sum, said({ kind: "agent", label: "agent's claim" }));
    add(sum, words(str(c.summary), true));
    nodes.push(sum);
  }
  if (c.audit) nodes.push(el("p", "", str(c.audit) + " Answer it in the web review queue."));
  if (c.reason) { nodes.push(el("h2", "", "Why a person")); nodes.push(el("p", "", str(c.reason))); }
  if (c.tests) nodes.push(el("p", "", str(c.tests)));
  if (list(c.held).length > 0) nodes.push(el("p", "", "A merge waits for your approval: " + list(c.held).map(str).join(", ") + " merged with a newer trunk; approving lands the merge as it is."));
  if (c.reproduction) nodes.push(el("p", "", "Reproduced by recipe: " + str(c.reproduction)));
  if (c.batch) nodes.push(el("p", "muted", "Batch: " + str(c.batch)));

  var look = c.look || {};
  if (list(look.danger).length > 0 || list(look.residual).length > 0) {
    nodes.push(el("h2", "", "Look here first"));
    list(look.danger).forEach(function (s) {
      var spot = el("div", "spot" + (s.severe ? " is-severe" : ""));
      add(spot, el("div", "mono", str(s.where)));
      add(spot, el("div", "muted", list(s.what).map(str).join(" · ")));
      if (list(s.lines).length > 0) add(spot, diff(s.lines));
      nodes.push(spot);
    });
    if (num(look.moreDanger) > 0) nodes.push(el("p", "muted", "and " + plural(num(look.moreDanger), "more danger line", "more danger lines") + ", marked in the full change"));
    list(look.residual).forEach(function (r) {
      var spot = el("div", "spot");
      add(spot, el("div", "mono", fileHead(r)));
      add(spot, el("div", "muted", "changed outside the declared footprint"));
      if (r.none) add(spot, el("div", "muted", str(r.none)));
      if (list(r.lines).length > 0) add(spot, diff(r.lines));
      if (num(r.more) > 0) add(spot, el("div", "muted", plural(num(r.more), "more line", "more lines") + " in the full change"));
      nodes.push(spot);
    });
    if (list(look.residual).length > 0 && list(look.declared).length > 0) nodes.push(el("p", "muted mono", "declared: " + list(look.declared).map(str).join(", ")));
  }

  if (c.change) {
    nodes.push(el("h2", "", "Full change · " + plural(num(c.change.filesChanged), "file", "files") + " · +" + num(c.change.added) + " -" + num(c.change.removed)));
    list(c.change.files).forEach(function (f) {
      var d = el("details", "");
      add(d, el("summary", "mono", fileHead(f)));
      if (f.none) add(d, el("div", "muted", str(f.none)));
      if (list(f.lines).length > 0) add(d, diff(f.lines));
      if (num(f.more) > 0) add(d, el("div", "muted", plural(num(f.more), "more line is", "more lines are") + " in the web review queue"));
      d.addEventListener("toggle", function () { app.sizeChanged(); });
      nodes.push(d);
    });
    if (num(c.change.notKept) > 0) nodes.push(el("p", "muted", plural(num(c.change.notKept), "more changed file was", "more changed files were") + " not kept with this card."));
  } else {
    nodes.push(el("p", "muted", "No diff was kept with this card."));
  }

  nodes.push(el("h2", "", "Who said what"));
  if (list(c.decisions).length === 0) nodes.push(el("p", "muted", "No decision recorded on it yet."));
  list(c.decisions).forEach(function (d) {
    var p = el("p", "");
    add(p, said(d.speaker));
    add(p, el("span", "", (str(d.question) || str(d.layer)) + " → " + str(d.action) + (typeof d.p === "number" ? " (p " + d.p.toFixed(2) + ")" : "")));
    if (d.answer) { add(p, el("span", "", ": ")); add(p, words(str(d.answer), !(d.speaker && d.speaker.kind === "platform"))); }
    nodes.push(p);
  });
  list(c.checks).forEach(function (run) {
    var box = el("div", "");
    add(box, said(run.speaker));
    list(run.lines).forEach(function (l) {
      var row = add(box, el("span", "check " + (l.ok ? "is-ok" : "is-bad")));
      add(row, el("span", "mark", l.ok ? "✓" : "✕"));
      add(row, el("span", "", str(l.name)));
      if (l.text) { add(row, el("span", "", ": ")); add(row, words(str(l.text), !!l.quoted)); }
    });
    nodes.push(box);
  });
  if (c.notVerified) {
    var nv = el("p", "");
    add(nv, el("span", "", "Not verified "));
    add(nv, said(c.notVerified.speaker));
    add(nv, words(str(c.notVerified.text), !!c.notVerified.quoted));
    nodes.push(nv);
  }
  var web = str(c.web);
  if (!c.decidable) nodes.push(el("p", "muted", "This one is not decided here: answer it in the web review queue at " + web + "."));
  else if (!code) nodes.push(el("p", "muted", "This host did not hand the review view what it needs to decide, so decide this change in the web review queue at " + web + "."));
  else nodes.push(decideForm(c, code));
  show(nodes);
}

function decideForm(c, code) {
  var box = el("div", "decide");
  add(box, el("h2", "", "Your decision"));
  add(box, el("p", "note", "Nothing is decided until you click. Approve sends the change to its lane to land; Return sends it back to its agent with your reason as feedback."));
  add(box, el("label", "", "Your name (recorded as you give it)"));
  var name = add(box, el("input", ""));
  name.setAttribute("type", "text");
  name.setAttribute("maxlength", "200");
  name.setAttribute("autocomplete", "name");
  try { name.value = str(win.localStorage && win.localStorage.getItem(NAME_KEY)); } catch (e) { name.value = ""; }
  add(box, el("label", "", "Reason (required)"));
  var reason = add(box, el("textarea", ""));
  reason.setAttribute("maxlength", "5000");
  var actions = add(box, el("div", "actions"));
  var approve = add(actions, el("button", "approve", "Approve"));
  var giveBack = add(actions, el("button", "", "Return to the agent"));
  approve.setAttribute("type", "button");
  giveBack.setAttribute("type", "button");
  var status = add(box, el("p", "status", ""));
  var form = { name: name, reason: reason, approve: approve, giveBack: giveBack, status: status, done: false, code: code };
  function sync() {
    var ready = !state.busy && !form.done && str(name.value).trim() !== "" && str(reason.value).trim() !== "";
    approve.disabled = !ready;
    giveBack.disabled = !ready;
  }
  name.addEventListener("input", sync);
  reason.addEventListener("input", sync);
  approve.addEventListener("click", function () { decide(c, "approve", form, sync); });
  giveBack.addEventListener("click", function () { decide(c, "return", form, sync); });
  sync();
  return box;
}

function decide(c, decision, form, sync) {
  if (state.busy || form.done) return;
  var by = str(form.name.value).trim();
  var reason = str(form.reason.value).trim();
  if (by === "" || reason === "") {
    form.status.className = "status is-bad";
    form.status.textContent = "Write your name and a reason first.";
    return;
  }
  state.busy = true;
  sync();
  form.status.className = "status";
  form.status.textContent = decision === "approve" ? "Approving…" : "Returning…";
  try { if (win.localStorage) win.localStorage.setItem(NAME_KEY, by); } catch (e) { /* storage is optional */ }
  app.request("tools/call", { name: "decide", arguments: { colony: str(c.colony), proposalId: str(c.proposalId), decision: decision, reason: reason, by: by, code: form.code } }).then(function (result) {
    state.busy = false;
    if (!result || result.isError) {
      var refused = !!(result && result.structuredContent && result.structuredContent.error && result.structuredContent.error.kind === "auth");
      form.status.className = "status is-bad";
      form.status.textContent = (errorOf(result) || "The decision did not go through.") + (refused ? " This card can no longer decide: open the change again to decide it here." : "");
      if (refused) form.done = true;
    } else {
      form.done = true;
      form.status.className = "status is-ok";
      form.status.textContent = str(result.structuredContent && result.structuredContent.text) || textOf(result) || "Decided.";
    }
    sync();
    app.sizeChanged();
  }, function (err) {
    state.busy = false;
    form.status.className = "status is-bad";
    form.status.textContent = "The host answered with an error: " + (str(err && err.message) || "no reason given") + ". Read the queue again before you try again: the decision may not have reached FireTrident.";
    sync();
    app.sizeChanged();
  });
}

function codeOf(result) {
  var meta = result && result._meta;
  return meta && typeof meta === "object" && typeof meta[CODE_KEY] === "string" ? meta[CODE_KEY] : "";
}

function onResult(result, fromQueue) {
  if (!result || typeof result !== "object") return message("The host sent no result.", "bad");
  if (result.isError) return message(errorOf(result) || "The call failed.", "bad");
  var sc = result.structuredContent;
  if (sc && sc.kind === "queue") return renderQueue(sc);
  if (sc && sc.kind === "card") return renderCard(sc, !!fromQueue, codeOf(result));
  show([el("pre", "plain", textOf(result) || "Nothing to show.")]);
}

app.on("ui/notifications/tool-input", function (p) {
  state.args = p && typeof p.arguments === "object" && p.arguments ? p.arguments : {};
  message(MODE === "queue" ? "Reading what waits for a person in " + str(state.args.colony) + "…" : "Reading change " + str(state.args.proposalId) + "…");
});
app.on("ui/notifications/tool-result", function (p) { onResult(p, false); });
app.on("ui/notifications/tool-cancelled", function (p) { message("The call was cancelled" + (p && p.reason ? ": " + str(p.reason) : "") + ".", "bad"); });
app.start().catch(function (err) {
  message("The host did not start this view: " + (str(err && err.message) || "no reason given") + ". The tool's text answer holds everything this view shows.", "bad");
});
`;

/**
 * The document's own policy, inside whatever the host builds from `_meta.ui.csp`: the specification's restrictive
 * default (inline script and style, data: images) with no network origin, no frames, no plugins and no form posts.
 */
export const VIEW_DOCUMENT_POLICY = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

/** One view document, whole: the CSS, the bridge and the view's script inline, starting in `mode`. */
export function reviewAppHtml(mode: ReviewViewMode): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${VIEW_DOCUMENT_POLICY}">`,
    `<title>${mode === "queue" ? "FireTrident review queue" : "FireTrident review"}</title>`,
    `<style>${REVIEW_VIEW_CSS}</style>`,
    "</head>",
    "<body>",
    `<main id="app"><p class="msg">Waiting for the host to send ${mode === "queue" ? "the queue" : "the change"}.</p></main>`,
    `<script>(function (win, doc) {\n"use strict";\nvar MODE = ${JSON.stringify(mode)};\n${VIEW_BRIDGE_JS}\n${REVIEW_VIEW_JS}\n})(window, document);</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

