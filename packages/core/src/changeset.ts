import type { FileVersion, Sha } from "./types.ts";

/**
 * Inline changes: a proposal that carries the text of every file it writes (`Proposal.contents`, keyed
 * by git blob id) instead of a commit pushed to the agent's workspace repo. The trunk writer then never
 * reads the change back from a workspace, and an agent never needs a clone to make one. Its id, where
 * a pushed change has its head commit, is a hash of the base commit and the write set, so a decision
 * bound to it is bound to that exact content. Pure and synchronous: the hashing below needs no runtime
 * crypto, so Workers, Node and browsers compute the same ids.
 */

/** Caps on one inline change. A larger change goes the git way (a commit pushed to the workspace). */
export const INLINE_LIMITS = { files: 64, fileBytes: 256 * 1024, totalBytes: 512 * 1024 } as const;

const NULL_BLOB = "0".repeat(40);

/** UTF-8 bytes of a string, as TextEncoder gives them (a lone surrogate becomes U+FFFD). */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** SHA-1 of some bytes, as 40 lowercase hex characters (git's object hash). */
export function sha1Hex(msg: Uint8Array): string {
  const length = msg.length;
  const padded = ((length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padded);
  buf.set(msg);
  buf[length] = 0x80;
  const bits = length * 8;
  const hi = Math.floor(bits / 0x100000000);
  const lo = bits >>> 0;
  buf[padded - 8] = hi >>> 24;
  buf[padded - 7] = (hi >>> 16) & 0xff;
  buf[padded - 6] = (hi >>> 8) & 0xff;
  buf[padded - 5] = hi & 0xff;
  buf[padded - 4] = lo >>> 24;
  buf[padded - 3] = (lo >>> 16) & 0xff;
  buf[padded - 2] = (lo >>> 8) & 0xff;
  buf[padded - 1] = lo & 0xff;
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!;
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
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
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
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

/** The git blob id of a UTF-8 text, as `git hash-object` computes it: SHA-1 of "blob <byte length>\0" and the bytes. */
export function blobId(text: string): Sha {
  const body = utf8Bytes(text);
  const head = utf8Bytes(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head, 0);
  all.set(body, head.length);
  return sha1Hex(all);
}

/**
 * The id of an inline change: SHA-1 of its base commit and its write set (sorted by path, each path
 * with its new blob, or forty zeros for a deletion). The same change on the same base has the same id.
 */
export function changesetId(baseSha: Sha, writeSet: readonly FileVersion[]): Sha {
  const lines = [...writeSet]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((w) => `${w.path}\0${w.blob ?? NULL_BLOB}\n`)
    .join("");
  return sha1Hex(utf8Bytes(`changeset ${baseSha}\n${lines}`));
}

/**
 * Why an inline change's contents cannot be accepted, or null when they can: every written blob has
 * its text, each text hashes to its blob id, no text carries a NUL byte (text files only), nothing
 * extra is sent, and the change stays within INLINE_LIMITS.
 */
export function inlineProblem(writeSet: readonly FileVersion[], contents: Readonly<Record<string, unknown>>): string | null {
  const written = writeSet.filter((w) => w.blob !== null);
  if (written.length > INLINE_LIMITS.files) return `an inline change writes at most ${INLINE_LIMITS.files} files (this one writes ${written.length}); push larger changes to the workspace`;
  const wanted = new Set(written.map((w) => w.blob as Sha));
  for (const key of Object.keys(contents)) {
    if (!wanted.has(key)) return `contents has ${key.slice(0, 12)}, which no written file uses`;
  }
  let total = 0;
  for (const w of written) {
    const text = contents[w.blob as Sha];
    if (typeof text !== "string") return `no contents for ${w.path} (blob ${(w.blob as Sha).slice(0, 12)})`;
    if (text.includes("\0")) return `${w.path} is not text (it has a NUL byte); push binary files to the workspace`;
    const bytes = utf8Bytes(text).length;
    if (bytes > INLINE_LIMITS.fileBytes) return `${w.path} is ${bytes} bytes, over the ${INLINE_LIMITS.fileBytes}-byte limit for an inline change`;
    total += bytes;
    if (total > INLINE_LIMITS.totalBytes) return `the change is over the ${INLINE_LIMITS.totalBytes}-byte limit for an inline change; push it to the workspace`;
    const id = blobId(text);
    if (id !== w.blob) return `the contents of ${w.path} hash to ${id.slice(0, 12)}, not its blob ${(w.blob as Sha).slice(0, 12)}`;
  }
  return null;
}
