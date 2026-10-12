import type { TreeEntry } from "isomorphic-git";

/**
 * Git objects built in memory: a synchronous SHA-1 and git's tree and commit encodings, so the
 * trunk writer can compute every id of a cycle's chain without touching the git store, then
 * write all of the cycle's objects at once. The encodings match isomorphic-git's writeTree and
 * writeCommit byte for byte (tests compare them), so ids are the same either way.
 */

const te = new TextEncoder();

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

/** SHA-1 of `bytes` as 40 lowercase hex digits. */
export function sha1Hex(bytes: Uint8Array): string {
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(total - 4, bitLen >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}

/** Git object id of `content` stored as `type` (sha1 of "<type> <length>\0" + content). */
export function objectId(type: "blob" | "tree" | "commit", content: Uint8Array): string {
  const header = te.encode(`${type} ${content.length}\0`);
  const all = new Uint8Array(header.length + content.length);
  all.set(header);
  all.set(content, header.length);
  return sha1Hex(all);
}

/** isomorphic-git's mode normalization (limitModeToAllowed). */
function normalMode(mode: string): string {
  if (/^0?4/.test(mode)) return "040000";
  if (/^1006/.test(mode)) return "100644";
  if (/^1007/.test(mode)) return "100755";
  if (/^120/.test(mode)) return "120000";
  if (/^160/.test(mode)) return "160000";
  throw new Error(`unexpected tree entry mode ${mode}`);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** The git encoding of a tree: entries in git order (a directory sorts as if named "<name>/"), "<mode> <name>\0<20-byte id>". */
export function treeContent(entries: TreeEntry[]): Uint8Array {
  const rows = entries.map((e) => {
    const mode = normalMode(e.mode);
    const name = te.encode(e.path);
    return { mode, name, key: mode === "040000" ? te.encode(`${e.path}/`) : name, oid: e.oid };
  });
  rows.sort((x, y) => compareBytes(x.key, y.key));
  const parts: Uint8Array[] = [];
  for (const r of rows) {
    parts.push(te.encode(`${r.mode.replace(/^0/, "")} `), r.name, new Uint8Array([0]));
    const id = new Uint8Array(20);
    for (let i = 0; i < 20; i++) id[i] = Number.parseInt(r.oid.slice(i * 2, i * 2 + 2), 16);
    parts.push(id);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The git encoding of a commit, as isomorphic-git writes it (timezone +0000, message ending in one newline). */
export function commitContent(c: { tree: string; parents: string[]; message: string; name: string; email: string; timestamp: number }): Uint8Array {
  const who = `${c.name} <${c.email}> ${c.timestamp} +0000`;
  const message = `${c.message.replace(/\r/g, "").replace(/^\n+/, "").replace(/\n+$/, "")}\n`;
  const headers = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${who}`, `committer ${who}`].join("\n");
  return te.encode(`${headers}\n\n${message}`);
}
