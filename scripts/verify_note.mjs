#!/usr/bin/env node
// Check one landing's lineage note with stock git: its bytes are exactly what FireTrident writes, and their SHA-256
// (without `certification`, added after landing) is the digest the commit carries in its FT-Note trailer.
// node scripts/verify_note.mjs <commit>   (in a clone, after: git fetch origin refs/notes/firetrident:refs/notes/firetrident)
// With --keys <url or file> (a deployment's /.well-known/firetrident-keys.json), an intact note's commit must also carry
// a good FT-Note-Signature, just above FT-Note: the Ed25519 signature of a key listed there (its id is the first 16 hex
// digits of the SHA-256 of the raw public key) over "firetrident-note-signature v1\n<note sha256>\n<tree>\n<parents>\n".
// It then prints "intact, signed by <key id>", "bad signature" or "unsigned (landed before signing)".
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
try {
  const note = JSON.parse(raw);
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
console.log(verdict);
process.exit(verdict === "intact" || verdict.startsWith("intact, signed by ") ? 0 : 1);
