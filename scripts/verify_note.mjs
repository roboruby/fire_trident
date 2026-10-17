#!/usr/bin/env node
// Check one landing's lineage note with stock git: its bytes are exactly what FireTrident writes, and their SHA-256
// (without `certification`, added after landing) is the digest the commit carries in its FT-Note trailer.
// node scripts/verify_note.mjs <commit>   (in a clone, after: git fetch origin refs/notes/firetrident:refs/notes/firetrident)
// With --keys <url or file> (a deployment's /.well-known/firetrident-keys.json), an intact note's commit must also carry
// a good FT-Note-Signature, just above FT-Note: the Ed25519 signature of a key listed there (its id is the first 16 hex
// digits of the SHA-256 of the raw public key) over "firetrident-note-signature v1\n<note sha256>\n<tree>\n<parents>\n".
// It then prints "intact, signed by <key id>", "bad signature" or "unsigned (landed before signing)".
// A note that checks out gets a second line, "answerable: <who> (<why>)": the nearest person answerable for the landing,
// or "none" or "unknown" with the reason, by the rules of packages/core/src/answerable.ts (the Why tab says the same).
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const at = argv.indexOf("--keys");
const keysFrom = at >= 0 ? argv[at + 1] : undefined;
const commit = argv.filter((_, i) => at < 0 || (i !== at && i !== at + 1))[0];
if (commit === undefined || (at >= 0 && !keysFrom)) {
  console.error("usage: node verify_note.mjs <commit> [--keys <url or file of firetrident-keys.json>]");
  process.exit(2);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const lines = git("log", "-1", "--format=%B", commit).trimEnd().split("\n");
const trailer = /^FT-Note: sha256:([0-9a-f]{64})$/.exec(lines[lines.length - 1])?.[1];
let raw = null;
try { raw = git("notes", "--ref=firetrident", "show", commit); } catch {}
// The note as FireTrident writes it: keys sorted at every depth, 2-space indent, one final newline.
const canon = (v, i = "") => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const n = `${i}  `, a = Array.isArray(v);
  const items = a ? v.map((x) => canon(x, n)) : Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${canon(v[k], n)}`);
  return items.length ? `${a ? "[" : "{"}\n${n}${items.join(`,\n${n}`)}\n${i}${a ? "]" : "}"}` : a ? "[]" : "{}";
};
let verdict = !trailer ? "no FT-Note trailer" : raw === null ? "missing" : "altered";
let note = null;
try {
  note = JSON.parse(raw);
  const asWritten = `${canon(note)}\n` === raw;
  delete note.certification; // added after landing, outside the digest
  if (trailer && asWritten && createHash("sha256").update(`${canon(note)}\n`).digest("hex") === trailer) verdict = "intact";
} catch {}
if (keysFrom !== undefined && verdict === "intact") {
  const above = lines.length > 1 ? lines[lines.length - 2] : "";
  const sig = /^FT-Note-Signature: ed25519 ([0-9a-f]{16}) ([A-Za-z0-9_-]{86})$/.exec(above);
  verdict = !above.startsWith("FT-Note-Signature:") ? "unsigned (landed before signing)" : "bad signature";
  if (sig) {
    let doc;
    try {
      doc = /^https?:\/\//.test(keysFrom) ? await fetch(keysFrom).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))) : JSON.parse(readFileSync(keysFrom, "utf8"));
    } catch (e) {
      console.error(`the keys at ${keysFrom} could not be read: ${e instanceof Error ? e.message : e}`);
      process.exit(2);
    }
    // A key counts only under its own id, recomputed from its bytes.
    const idOf = (k) => createHash("sha256").update(Buffer.from(k, "base64url")).digest("hex").slice(0, 16);
    const key = (Array.isArray(doc?.keys) ? doc.keys : []).find((k) => k?.alg === "Ed25519" && k.id === sig[1] && typeof k.publicKey === "string" && idOf(k.publicKey) === sig[1]);
    const [tree, parents] = git("log", "-1", "--format=%T%n%P", commit).split("\n");
    try {
      const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey }, format: "jwk" });
      if (verify(null, Buffer.from(`firetrident-note-signature v1\n${trailer}\n${tree}\n${parents}\n`), publicKey, Buffer.from(sig[2], "base64url"))) verdict = `intact, signed by ${sig[1]}`;
    } catch {}
  }
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
console.log(verdict);
if (obj(note) && (verdict === "intact" || verdict.startsWith("intact, signed by ") || verdict.startsWith("unsigned"))) {
  const a = answerable(note);
  console.log(`answerable: ${a.who} (${a.why})`);
}
process.exit(verdict === "intact" || verdict.startsWith("intact, signed by ") ? 0 : 1);
