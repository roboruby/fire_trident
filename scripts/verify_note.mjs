#!/usr/bin/env node
// Check FireTrident's lineage notes with stock git and Node alone (no dependencies, no FireTrident server).
// In a clone, after: git fetch origin refs/notes/firetrident:refs/notes/firetrident
//
//   node verify_note.mjs <commit>              one landing's note: its bytes are exactly what FireTrident writes, and their
//                                              SHA-256 (without `certification`, added after landing) is the digest the
//                                              commit carries in its FT-Note trailer. Prints intact, altered, missing or
//                                              no FT-Note trailer. --commit <ref> is the same as <commit>.
//   --keys <url or file>                       a deployment's /.well-known/firetrident-keys.json: an intact note's commit
//                                              must also carry a good FT-Note-Signature, just above FT-Note, the Ed25519
//                                              signature of a key listed there (its id is the first 16 hex digits of the
//                                              SHA-256 of the raw public key) over
//                                              "firetrident-note-signature v1\n<note sha256>\n<tree>\n<parents>\n", by a key
//                                              whose window (since to until, to the second, both ends included; null is
//                                              open) covers the commit's committer time: the list holds the current key
//                                              and every retired one, so a rotated key's signatures still check out. Prints
//                                              "intact, signed by <key id>", "bad signature" (with why when the key was not
//                                              signing at the commit's time) or "unsigned (landed before signing)".
// The same commits carry a gpgsig header, an SSH signature by the same key, that stock git checks on its own:
//   curl -s <deployment>/.well-known/firetrident-allowed-signers > allowed_signers
//   git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=allowed_signers verify-commit <commit>
//   --tamper [--tamper-field <path>]           copy the note in memory, change one field (a decision's approver, else a blob
//                                              id the change read), and require the copy to fail against its commit.
//                                              Nothing is written to git.
//   --colony <root sha>                        pin the colony by its root commit (the first commit of trunk, first parent
//                                              from the tip): a history whose root is another fails.
//   --all [--from <ref>] [--limit <n>]         walk trunk's first-parent chain (from the branch tip by default) and check
//                                              each landing: note intact, signature good (with --keys), and the commit
//                                              changing exactly the files and blob ids its note's write sets name. Commits
//                                              that are not landings are listed and skipped. Ends with a summary line.
// A note that checks out gets a second line, "answerable: <who> (<why>)": the nearest person answerable for the landing,
// or "none" or "unknown" with the reason, by the rules of packages/core/src/answerable.ts (the Why tab says the same);
// with --all, each landing's line ends with it.
// Exits 0 when every check passes, 1 when one fails, 2 when the arguments, the clone or the keys cannot be read.
// packages/cli/src/clonecheck.ts (ft verify --all) does the same; packages/cli/test/clonecheck-git.test.ts holds them in step.
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage = "usage: node verify_note.mjs <commit> [--keys <url or file of firetrident-keys.json>] [--tamper [--tamper-field <path>]] [--colony <root sha>]\n       node verify_note.mjs --all [--from <ref>] [--limit <n>] [--keys ...] [--tamper ...] [--colony ...]";
const stop = (message) => {
  console.error(message);
  process.exit(2);
};
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: { commit: { type: "string" }, keys: { type: "string" }, tamper: { type: "boolean" }, "tamper-field": { type: "string" }, colony: { type: "string" }, all: { type: "boolean" }, from: { type: "string" }, limit: { type: "string" } },
  });
} catch (e) {
  stop(`${e.message}\n${usage}`);
}
const o = args.values;
// The commit is the one argument, or --commit (as ft verify takes it).
const target = o.commit ?? args.positionals[0];
if (args.positionals.length > (o.commit !== undefined ? 0 : 1) || o.commit === "" || (o.all ? target !== undefined : target === undefined) || (!o.all && (o.from !== undefined || o.limit !== undefined))) stop(usage);
if (o.keys === "" || (o["tamper-field"] !== undefined && (!o.tamper || fieldPath(o["tamper-field"]) === null))) stop(usage);
if (o.limit !== undefined && !/^[1-9]\d{0,6}$/.test(o.limit)) stop(`--limit must be a whole number from 1\n${usage}`);
const pinned = o.colony?.toLowerCase();
if (o.colony !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pinned)) stop(`--colony takes the colony's full root commit (40 hex digits), as ft status and the colony page show it\n${usage}`);

const git = (args, input) => execFileSync("git", args, { input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "ignore"] });
try {
  git(["rev-parse", "--git-dir"]);
} catch {
  stop("run it inside a git clone of the colony");
}

// The note as FireTrident writes it: keys sorted at every depth, 2-space indent, one final newline.
const canon = (v, i = "") => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  const n = `${i}  `, a = Array.isArray(v);
  const items = a ? v.map((x) => canon(x, n)) : Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${canon(v[k], n)}`);
  return items.length ? `${a ? "[" : "{"}\n${n}${items.join(`,\n${n}`)}\n${i}${a ? "]" : "}"}` : a ? "[]" : "{}";
};
const digestOf = (note) => {
  const { certification: _added, ...rest } = note; // added after landing, outside the digest
  return createHash("sha256").update(`${canon(rest)}\n`).digest("hex");
};
const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const short = (sha) => sha.slice(0, 12);
const n = (x) => x.toLocaleString("en-US");

/** A note's bytes against its commit's digest. */
function noteState(raw, digest) {
  if (raw === null) return "missing";
  let note;
  try {
    note = JSON.parse(raw);
  } catch {
    return "altered";
  }
  if (!isRecord(note) || `${canon(note)}\n` !== raw) return "altered";
  return digestOf(note) === digest ? "intact" : "altered";
}
const trailerOf = (message) => {
  const lines = message.trimEnd().split("\n");
  return /^FT-Note: sha256:([0-9a-f]{64})$/.exec(lines[lines.length - 1] ?? "")?.[1] ?? null;
};

// Signatures: the line just above FT-Note, against the published keys.
let keys;
if (o.keys !== undefined) {
  try {
    keys = /^https?:\/\//.test(o.keys) ? await fetch(o.keys).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))) : JSON.parse(readFileSync(o.keys, "utf8"));
  } catch (e) {
    console.error(`the keys at ${o.keys} could not be read: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
}
// Why key `id`, listed with since and until, was not signing at `time` (Unix seconds), or null when its window covers it.
function windowWhy(id, since, until, time) {
  const edge = (v) => (v === undefined || v === null ? null : typeof v === "string" && Number.isFinite(Date.parse(v)) ? Math.floor(Date.parse(v) / 1000) : undefined);
  const from = edge(since), to = edge(until);
  if (from === null && to === null) return null;
  const span = `it signed from ${typeof since === "string" ? since : "its first commit"} until ${typeof until === "string" ? until : "now"}`;
  if (from === undefined || to === undefined) return `key ${id} is listed with a window that cannot be read`;
  if (typeof time !== "number" || !Number.isFinite(time)) return `key ${id} has a window, and this commit's time is not known`;
  if ((from !== null && time < from) || (to !== null && time > to)) return `key ${id} was not signing on ${new Date(time * 1000).toISOString()}: ${span}`;
  return null;
}
function signatureState(c, digest) {
  const lines = c.message.trimEnd().split("\n");
  const above = lines.length > 1 ? lines[lines.length - 2] : "";
  if (!above.startsWith("FT-Note-Signature:")) return { status: "unsigned" };
  const sig = /^FT-Note-Signature: ed25519 ([0-9a-f]{16}) ([A-Za-z0-9_-]{86})$/.exec(above);
  if (!sig) return { status: "bad" };
  // A key counts only under its own id, recomputed from its bytes.
  const idOf = (k) => createHash("sha256").update(Buffer.from(k, "base64url")).digest("hex").slice(0, 16);
  const key = list(keys?.keys).find((k) => k?.alg === "Ed25519" && k.id === sig[1] && typeof k.publicKey === "string" && idOf(k.publicKey) === sig[1]);
  if (!key) return { status: "bad" };
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey }, format: "jwk" });
    if (!verify(null, Buffer.from(`firetrident-note-signature v1\n${digest}\n${c.tree}\n${c.parents}\n`), publicKey, Buffer.from(sig[2], "base64url"))) return { status: "bad" };
  } catch {
    return { status: "bad" };
  }
  const why = windowWhy(sig[1], key.since, key.until, c.time);
  return why === null ? { status: "signed", keyId: sig[1] } : { status: "bad", why };
}
const signatureWords = (s) => (s.status === "signed" ? `signed by ${s.keyId}` : s.status === "bad" ? (s.why ? `bad signature (${s.why})` : "bad signature") : "unsigned (landed before signing)");

// Tamper: a copy in memory with one field changed must no longer match its commit's digest.
function fieldPath(text) {
  const out = [];
  for (const part of text.trim().split(".")) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m || (m[1] === "" && m[2] === "")) return null;
    if (m[1] !== "") out.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]);
    for (const i of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(i[1]));
  }
  return out.length > 0 ? out : null;
}
const fieldText = (path) => path.map((k, i) => (typeof k === "number" ? `[${k}]` : i === 0 ? k : `.${k}`)).join("");
function defaultField(note) {
  const proposals = list(note.proposals);
  const decided = (human) => {
    for (const [i, p] of proposals.entries())
      for (const [j, d] of list(isRecord(p) ? p.decisions : undefined).entries()) if (isRecord(d) && typeof d.by === "string" && d.by !== "" && (!human || d.layer === "human")) return ["proposals", i, "decisions", j, "by"];
    return null;
  };
  const blob = (set) => {
    for (const [i, p] of proposals.entries()) for (const [j, f] of list(isRecord(p) ? p[set] : undefined).entries()) if (isRecord(f) && typeof f.blob === "string") return ["proposals", i, set, j, "blob"];
    return null;
  };
  return decided(true) ?? decided(false) ?? blob("readSet") ?? blob("writeSet") ?? (typeof note.landingId === "string" ? ["landingId"] : null);
}
function tamperValue(v) {
  if (typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)) return `${v.slice(0, -1)}${(parseInt(v.slice(-1), 16) ^ 1).toString(16)}`;
  if (typeof v === "string") return v === "mallory" ? "trent" : "mallory";
  if (typeof v === "number") return v + 1;
  if (typeof v === "boolean") return !v;
  return "mallory";
}
const shown = (v) => {
  const s = typeof v === "string" ? (v === "" ? '""' : v.replace(/[\u0000-\u001f\u007f]+/g, " ")) : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};
function tamper(raw, digest, field) {
  if (raw === null) return { ok: false, reason: "the commit has no note to copy" };
  let note;
  try {
    note = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "the note is not JSON" };
  }
  if (!isRecord(note)) return { ok: false, reason: "the note is not a JSON object" };
  const path = field !== undefined ? fieldPath(field) : defaultField(note);
  if (path === null) return { ok: false, reason: field !== undefined ? `"${field}" is not a field path` : "the note has no field to change" };
  const copy = JSON.parse(raw);
  let at = copy;
  for (const k of path.slice(0, -1)) at = at !== null && typeof at === "object" ? at[k] : undefined;
  const last = path[path.length - 1];
  const holder = at !== null && typeof at === "object" ? at : null;
  const has = holder !== null && (Array.isArray(holder) ? typeof last === "number" && last < holder.length : typeof last === "string" && Object.hasOwn(holder, last));
  if (!has) return { ok: false, reason: `the note has no field ${fieldText(path)}` };
  const from = holder[last];
  if (from !== null && typeof from === "object") return { ok: false, reason: `${fieldText(path)} holds ${Array.isArray(from) ? "a list" : "an object"}; pick a field that holds one value` };
  const to = tamperValue(from);
  holder[last] = to;
  return { ok: true, field: fieldText(path), from, to, caught: digestOf(copy) !== digest };
}
function tamperLine(t) {
  if (!t.ok) return `tampered copy: none (${t.reason})`;
  const change = `${t.field} changed from ${shown(t.from)} to ${shown(t.to)}`;
  return t.caught ? `tampered copy: altered (${change}): the digest no longer matches` : `tampered copy: intact (${change}): the digest still matches, so this check cannot see that change`;
}

// Git, read in a few calls: the chain with its messages, the commit objects (their parents), the notes, the diffs.
const parentsIn = (raw) =>
  (raw.split("\n\n")[0] ?? "")
    .split("\n")
    .flatMap((l) => (l.startsWith("parent ") ? [l.slice(7).trim()] : []))
    .join(" ");
// The committer time a raw commit object names, in Unix seconds, or null.
const committedIn = (raw) => {
  const line = (raw.split("\n\n")[0] ?? "").split("\n").find((l) => l.startsWith("committer "));
  const m = line ? / (\d+) [+-]\d{4}$/.exec(line) : null;
  return m ? Number(m[1]) : null;
};
function readObjects(ids) {
  const out = new Map();
  if (ids.length === 0) return out;
  const buf = git(["cat-file", "--batch"], `${ids.join("\n")}\n`);
  let at = 0;
  for (const id of ids) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const head = buf.toString("utf8", at, nl).split(" ");
    at = nl + 1;
    if (head[1] === "missing" || head.length < 3) continue;
    const size = Number(head[2]);
    out.set(id, buf.toString("utf8", at, at + size));
    at += size + 1;
  }
  return out;
}
function walk(from, limit) {
  let out;
  try {
    out = git(["log", "--first-parent", "--no-show-signature", "--format=%x1e%H%x00%T%x00%B", ...(limit !== undefined ? [`--max-count=${limit}`] : []), from, "--"]).toString("utf8");
  } catch {
    stop(`${from} is not a commit in this clone`);
  }
  const commits = out
    .split("\x1e")
    .slice(1)
    .map((rec) => {
      const [sha = "", tree = "", ...rest] = rec.split("\0");
      return { sha, tree, message: rest.join("\0") };
    });
  // The parents a commit was built and signed with, from the object itself: git log shows none past a shallow boundary.
  const objects = readObjects(commits.map((c) => c.sha));
  return commits.map((c) => ({ ...c, parents: parentsIn(objects.get(c.sha) ?? ""), time: committedIn(objects.get(c.sha) ?? "") }));
}
function notesList() {
  const map = new Map();
  let out = "";
  try {
    out = git(["notes", "--ref=firetrident", "list"]).toString("utf8");
  } catch {}
  for (const line of out.split("\n")) {
    const [blob, commit] = line.trim().split(/\s+/);
    if (blob && commit) map.set(commit, blob);
  }
  return map;
}
function parseRawDiff(out) {
  const parts = out.split("\0"), entries = [];
  const blob = (b) => (/^0+$/.test(b) ? null : b);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(parts[i]);
    if (m) entries.push({ path: parts[i + 1], oldMode: m[1], newMode: m[2], oldBlob: blob(m[3]), newBlob: blob(m[4]) });
  }
  return entries;
}
function diffOf(sha, parents) {
  const parent = parents.split(" ").filter(Boolean)[0];
  return parseRawDiff(git(["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", ...(parent ? [parent, sha] : ["--root", sha])]).toString("utf8"));
}
function heldAt(sha, paths) {
  const out = new Map();
  if (paths.length === 0) return out;
  for (const entry of git(["--literal-pathspecs", "ls-tree", "-r", "-z", sha, "--", ...paths]).toString("utf8").split("\0")) {
    const m = /^\d{6} \w+ ([0-9a-f]+)\t(.*)$/s.exec(entry);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// Write sets: the commit's change against its first parent is exactly what its note says it wrote.
const wrote = (blob) => (blob === null ? "deletes it" : `writes ${short(blob)}`);
const said = (blob) => (blob === null ? "it deleted it" : `it wrote ${short(blob)}`);
function modeProblem(d) {
  if (d.oldMode !== "000000" && d.newMode !== "000000" && d.oldMode !== d.newMode) return `${d.path}: its mode changed from ${d.oldMode} to ${d.newMode}, which a landing never does`;
  if (d.oldMode === "000000" && d.newMode !== "100644") return `${d.path}: added with mode ${d.newMode}, where a landing adds files as 100644`;
  return null;
}
function noteWrites(note) {
  const out = new Map();
  for (const p of list(note.proposals)) for (const w of list(isRecord(p) ? p.writeSet : undefined)) if (isRecord(w) && typeof w.path === "string") out.set(w.path, typeof w.blob === "string" ? w.blob : null);
  return out;
}
function writeProblems(expected, diff, held) {
  const problems = [], changed = new Set();
  for (const d of diff) {
    changed.add(d.path);
    const mode = modeProblem(d);
    if (mode) problems.push(mode);
    if (!expected.has(d.path)) problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, and no write set in the note names it`);
    else if ((expected.get(d.path) ?? null) !== d.newBlob) problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, the note says ${said(expected.get(d.path) ?? null)}`);
  }
  for (const [path, blob] of expected) {
    if (changed.has(path)) continue;
    const has = held.get(path) ?? null;
    if (has !== blob) problems.push(`${path}: the commit leaves it ${has === null ? "absent" : `at ${short(has)}`}, the note says ${said(blob)}`);
  }
  return problems;
}
function antibodyProblems(path, diff) {
  const problems = [];
  for (const d of diff) {
    const mode = modeProblem(d);
    if (mode) problems.push(mode);
    if (d.path !== path) problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, and the antibody note names only ${path}`);
    else if (d.newBlob === null) problems.push(`${path}: the commit deletes it, the antibody note says it wrote it`);
  }
  if (!diff.some((d) => d.path === path)) problems.push(`${path}: the antibody note names it, and the commit does not change it`);
  return problems;
}
function revertProblems(diff, target, targetSha, whole) {
  const before = new Map(target.map((t) => [t.path, t.oldBlob]));
  const problems = [];
  for (const d of diff) {
    const mode = modeProblem(d);
    if (mode) problems.push(mode);
    if (!before.has(d.path)) problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, and ${short(targetSha)}, the commit it reverts, did not change it`);
    else if ((before.get(d.path) ?? null) !== d.newBlob) {
      const was = before.get(d.path) ?? null;
      problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, and before ${short(targetSha)} it was ${was === null ? "absent" : short(was)}`);
    }
  }
  if (whole) for (const t of target) if (!diff.some((d) => d.path === t.path)) problems.push(`${t.path}: ${short(targetSha)} changed it, and the revert does not put it back`);
  return problems;
}
function pathsVerdict(c, note) {
  let diff;
  try {
    diff = diffOf(c.sha, c.parents);
  } catch {
    return { text: "paths not compared: its parent is not in this clone (a shallow clone)", matched: null };
  }
  const files = (k) => `${n(k)} file${k === 1 ? "" : "s"}`;
  const verdict = (problems, what) =>
    problems.length === 0 ? { text: `paths match (${what})`, matched: true } : { text: `paths do not match: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; and ${problems.length - 3} more` : ""}`, matched: false };
  const system = note.system;
  if (system !== undefined) {
    // An antibody commit: its note carries the rejected proposal, whose writes never landed.
    if (isRecord(system) && system.kind === "antibody" && typeof system.path === "string") return verdict(antibodyProblems(system.path, diff), `antibody file ${system.path}; the note does not record its blob`);
    return { text: `paths not compared: a system commit of kind ${shown(isRecord(system) ? system.kind : system)}, which this check does not know`, matched: null };
  }
  const revert = note.revert;
  if (revert !== undefined) {
    const target = isRecord(revert) && typeof revert.commit === "string" && /^[0-9a-f]{40,64}$/.test(revert.commit) ? revert.commit : null;
    if (target === null) return { text: "paths not compared: the revert note does not name the commit it reverts", matched: null };
    let targetDiff;
    try {
      const raw = readObjects([target]).get(target);
      if (raw === undefined) throw new Error("not in this clone");
      targetDiff = diffOf(target, parentsIn(raw));
    } catch {
      return { text: `paths not compared: ${short(target)}, the commit it reverts, is not in this clone`, matched: null };
    }
    return verdict(revertProblems(diff, targetDiff, target, !(isRecord(revert) && typeof revert.proposal === "string")), `revert of ${short(target)}: ${files(diff.length)} put back`);
  }
  const expected = noteWrites(note);
  const unchanged = [...expected.keys()].filter((p) => !diff.some((d) => d.path === p));
  let held;
  try {
    held = heldAt(c.sha, unchanged);
  } catch {
    return { text: "paths not compared: the commit's files could not be listed", matched: null };
  }
  return verdict(writeProblems(expected, diff, held), files(diff.length));
}

// Who answers for the landing, first match wins for each change: a person who approved it (a human "approve" decision),
// the person who approved the rule whose deterministic proof landed it, the person who asked for the intent (source
// human), else none, with who declared the intent and what landed it; unknown where the note predates the record.
const UNNAMED = new Set(["", "api", "human", "unknown", "person", "someone"]);
const ln = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const obj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const named = (v) => (UNNAMED.has(ln(v).slice(0, 200).toLowerCase()) ? null : ln(v).slice(0, 200));
const change = (p) => {
  const ds = Array.isArray(p.decisions) ? p.decisions : [];
  const cs = obj(p.evidence) && Array.isArray(p.evidence.checks) ? p.evidence.checks : [];
  const it = obj(p.intent) ? p.intent : {};
  let gate = null;
  for (let i = cs.length - 1; i >= 0; i--) {
    const c = cs[i];
    if (!obj(c) || c.name !== "gate" || c.by === "agent" || typeof c.detail !== "string") continue;
    const m = /→ (\S+) by (\S+)/.exec(c.detail);
    const k = /\(confirmations: ([^)]*)\)/.exec(c.detail);
    if (m) gate = { action: m[1], layer: m[2], conf: k ? k[1].split("+").map((s) => s.trim()).filter(Boolean) : [] };
    break;
  }
  const model = (layer) => {
    const d = [...ds].reverse().find((x) => obj(x) && x.layer === layer && x.action === "land" && ln(x.by) !== "");
    if (d) return ln(d.by);
    const c = [...cs].reverse().find((x) => obj(x) && x.by !== "agent" && typeof x.name === "string" && x.name.startsWith(`${layer}: `));
    return c ? ln(c.name.slice(layer.length + 2)) : "";
  };
  const by = (m) => (m ? `model ${m}` : "a model");
  const lander = !gate
    ? "it landed with no review recorded"
    : gate.layer === "deterministic"
      ? "a deterministic proof landed it"
      : gate.layer === "llm"
        ? `${by(model("llm"))} approved it`
        : gate.layer === "reflex"
          ? `${by(model("reflex"))} landed it${gate.conf.includes("autonomy") ? " on earned autonomy" : ""}`
          : `the ${gate.layer} layer landed it`;
  const approval = [...ds].reverse().find((d) => obj(d) && d.layer === "human" && d.action === "approve");
  if (approval) return { basis: "approved", who: named(approval.by) ?? "an unnamed person", why: "approved this change" };
  const rule = ln(it.ruleId);
  const known = typeof it.source === "string" && it.source !== "";
  if (rule && gate?.layer === "deterministic" && gate.action === "land") {
    if (typeof it.ruleApprovedBy === "string") return { basis: "rule", who: named(it.ruleApprovedBy) ?? "an unnamed person", why: `approved rule ${rule}, whose deterministic proof landed this change` };
    return { basis: "unknown", who: "unknown", why: known ? `the note does not record who approved rule ${rule}, whose proof landed this change` : "the note was written before notes recorded who approved each rule" };
  }
  if (!known) return { basis: "unknown", who: "unknown", why: "the note was written before notes recorded who asked for each intent" };
  const source = ln(it.source);
  if (source === "human") return { basis: "asked", who: named(it.createdBy) ?? "an unnamed person", why: "asked for this intent" };
  const declarer = { agent: `agent ${ln(it.createdBy) || "unknown"} declared the intent`, rule: `rule ${rule || "unknown"} declared the intent`, certify: "trunk certification declared the intent", system: "FireTrident declared the intent" }[source] ?? `an intent of source ${source} was declared`;
  return { basis: "none", who: "none", why: `${declarer} and ${lander}` };
};
const answerable = (n) => {
  if (obj(n.revert)) return { who: named(n.revert.by) ?? "an unnamed person", why: `reverted ${ln(n.revert.of) || "a landing"}` };
  if (obj(n.system)) return n.system.kind === "antibody" ? { who: named(n.system.by) ?? "an unnamed person", why: `rejected ${ln(n.system.rejected) || "a change"}, which taught this antibody` } : { who: "none", why: "FireTrident made this commit on its own" };
  const changes = (Array.isArray(n.proposals) ? n.proposals : []).filter(obj).map(change);
  if (changes.length === 0) return { who: "unknown", why: "the note lists no change" };
  const groups = [];
  for (const c of changes) {
    const g = groups.find((x) => x.c.basis === c.basis && x.c.who === c.who && x.c.why === c.why);
    if (g) g.n++;
    else groups.push({ c, n: 1 });
  }
  if (groups.length === 1) return groups[0].c;
  const all = changes.some((c) => c.basis === "none") ? "none" : changes.some((c) => c.basis === "unknown") ? "unknown" : null;
  const people = [...new Set(changes.filter((c) => c.basis !== "none" && c.basis !== "unknown").map((c) => c.who))];
  const phrase = (c) => (c.basis === "none" ? `no person: ${c.why}` : c.basis === "unknown" ? `unknown: ${c.why}` : `${c.who} ${c.why}`);
  return { who: all ?? people.join(", "), why: groups.map((g) => `${g.n} of ${changes.length}: ${phrase(g.c)}`).join("; ") };
};
/** The answerable line of a note's bytes that check out (after "answerable: "), or null when they are not a JSON object. */
const answerableOf = (raw) => {
  let note = null;
  try {
    note = JSON.parse(raw);
  } catch {}
  if (!obj(note)) return null;
  const a = answerable(note);
  return `${a.who} (${a.why})`;
};

// The root: the last commit of the first-parent chain.
function rootLine(from) {
  const chain = git(["rev-list", "--first-parent", from, "--"]).toString("utf8").trim().split("\n");
  const root = chain[chain.length - 1] ?? "";
  if (root === pinned) return { text: `root ${root} matches the pinned colony`, failed: false };
  let shallow = false;
  try {
    shallow = git(["rev-parse", "--is-shallow-repository"]).toString("utf8").trim() === "true";
  } catch {}
  return { text: `this history's root is ${root}, not the pinned ${pinned}${shallow ? " (this clone is shallow: a clone made with --depth stops before the root; clone without --depth)" : ""}`, failed: true };
}

const out = [];
let failed = false;
const say = (text, bad) => {
  out.push(text);
  failed ||= bad;
};
const notes = notesList();
if (!o.all) {
  // One commit, as this script has always checked it; then the tampered copy and the root.
  const ref = target;
  const c = walk(ref, 1)[0];
  if (!c) stop(`${ref} is not a commit in this clone`);
  const digest = trailerOf(c.message);
  const blob = notes.get(c.sha);
  const raw = blob !== undefined ? (readObjects([blob]).get(blob) ?? null) : null;
  let verdict = digest === null ? "no FT-Note trailer" : noteState(raw, digest);
  if (keys !== undefined && verdict === "intact") {
    const s = signatureState(c, digest);
    verdict = s.status === "signed" ? `intact, ${signatureWords(s)}` : signatureWords(s);
  }
  say(verdict, !(verdict === "intact" || verdict.startsWith("intact, signed by ")));
  // A note that checks out (signed, or landed before signing): who answers for its landing.
  const who = verdict === "intact" || verdict.startsWith("intact, signed by ") || verdict.startsWith("unsigned") ? answerableOf(raw) : null;
  if (who !== null) say(`answerable: ${who}`, false);
  if (o.tamper) {
    const t = digest === null ? { ok: false, reason: "the commit carries no FT-Note trailer to check a copy against" } : tamper(raw, digest, o["tamper-field"]);
    say(tamperLine(t), !(t.ok && t.caught));
  }
  if (pinned !== undefined) {
    const r = rootLine(c.sha);
    say(r.text, r.failed);
  }
} else {
  // The whole first-parent chain: one line per landing, runs of other commits on one line.
  const from = o.from ?? "HEAD";
  const commits = walk(from, o.limit === undefined ? undefined : Number(o.limit));
  if (commits.length === 0) stop(`${from} is not a commit in this clone`);
  const sealed = commits.filter((c) => trailerOf(c.message) !== null);
  const blobs = readObjects([...new Set(sealed.map((c) => notes.get(c.sha)).filter((b) => b !== undefined))]);
  const rawOf = (sha) => (notes.has(sha) ? (blobs.get(notes.get(sha)) ?? null) : null);
  const verdicts = commits.map((c) => {
    const digest = trailerOf(c.message);
    if (digest === null) return { kind: "skip", sha: c.sha, unsealed: /(^|\n)FT-Landing: \S/.test(c.message) };
    const raw = rawOf(c.sha);
    const state = noteState(raw, digest);
    const signature = keys !== undefined && state === "intact" ? signatureState(c, digest) : null;
    const who = state === "intact" && signature?.status !== "bad" ? answerableOf(raw) : null;
    return { kind: "landing", sha: c.sha, note: state, signature, paths: state === "intact" ? pathsVerdict(c, JSON.parse(raw)) : null, who };
  });
  // An unsigned landing newer than a signed one was not built by a trunk writer that signs: it fails.
  const lateUnsigned = new Set();
  let signedBelow = false;
  for (let i = verdicts.length - 1; i >= 0; i--) {
    const v = verdicts[i];
    if (v.kind !== "landing" || !v.signature) continue;
    if (v.signature.status === "signed") signedBelow = true;
    else if (v.signature.status === "unsigned" && signedBelow) lateUnsigned.add(v.sha);
  }
  const count = { landings: 0, intact: 0, signed: 0, matched: 0, failures: 0, skipped: 0, unsealed: 0 };
  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i];
    if (v.kind === "skip") {
      let j = i;
      while (j + 1 < verdicts.length && verdicts[j + 1].kind === "skip" && verdicts[j + 1].unsealed === v.unsealed) j++;
      const k = j - i + 1;
      const what = v.unsealed ? "landed before notes were sealed (no FT-Note trailer)" : "not a landing (no FT-Note trailer)";
      out.push(k === 1 ? `${short(v.sha)}  ${what}` : `${short(v.sha)}..${short(verdicts[j].sha)}  ${n(k)} commits ${v.unsealed ? "that " : ""}${what.replace(/^not a landing/, "that are not landings")}`);
      count[v.unsealed ? "unsealed" : "skipped"] += k;
      i = j;
      continue;
    }
    count.landings++;
    const parts = [v.note];
    let bad = v.note !== "intact";
    if (v.note === "intact") count.intact++;
    if (v.signature) {
      if (v.signature.status === "signed") count.signed++;
      if (v.signature.status === "bad" || lateUnsigned.has(v.sha)) bad = true;
      parts.push(lateUnsigned.has(v.sha) ? "unsigned, though an older landing is signed" : signatureWords(v.signature));
    }
    if (v.paths) {
      parts.push(v.paths.text);
      if (v.paths.matched === true) count.matched++;
      if (v.paths.matched === false) bad = true;
    }
    if (v.who !== null) parts.push(`answerable: ${v.who}`);
    if (bad) count.failures++;
    say(`${short(v.sha)}  ${parts.join(", ")}`, bad);
  }
  if (sealed.length > 0 && notes.size === 0) say("this clone has no lineage notes: fetch them with git fetch origin refs/notes/firetrident:refs/notes/firetrident, then check again", true);
  if (pinned !== undefined) {
    const r = rootLine(from);
    say(r.text, r.failed);
  }
  if (o.tamper) {
    const newest = sealed[0];
    const t = newest ? tamper(rawOf(newest.sha), trailerOf(newest.message), o["tamper-field"]) : { ok: false, reason: "no commit in this history carries a sealed note to copy" };
    say(newest ? `${short(newest.sha)}  ${tamperLine(t)}` : tamperLine(t), !(t.ok && t.caught));
  }
  const signed = keys !== undefined ? `${n(count.signed)} signed` : "signatures not checked (give --keys)";
  const skipped = [count.skipped > 0 ? `${n(count.skipped)} ${count.skipped === 1 ? "not a landing" : "not landings"}` : "", count.unsealed > 0 ? `${n(count.unsealed)} landed before notes were sealed` : ""].filter(Boolean).join(", ");
  out.push(
    `checked ${n(count.landings)} landing${count.landings === 1 ? "" : "s"} in ${n(commits.length)} commit${commits.length === 1 ? "" : "s"}: ${n(count.intact)} intact, ${signed}, ${n(count.matched)} paths match, ${n(count.failures)} failure${count.failures === 1 ? "" : "s"}${skipped ? ` (skipped: ${skipped})` : ""}`,
  );
}
console.log(out.join("\n"));
process.exit(failed ? 1 : 0);
