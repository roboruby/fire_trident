#!/usr/bin/env node
// Check one landing's lineage note with stock git: its bytes are exactly what FireTrident writes, and their SHA-256
// (without `certification`, added after landing) is the digest the commit carries in its FT-Note trailer.
// node scripts/verify_note.mjs <commit>   (in a clone, after: git fetch origin refs/notes/firetrident:refs/notes/firetrident)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const commit = process.argv[2];
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const trailer = /^FT-Note: sha256:([0-9a-f]{64})$/.exec(git("log", "-1", "--format=%B", commit).trimEnd().split("\n").pop())?.[1];
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
console.log(verdict);
process.exit(verdict === "intact" ? 0 : 1);
