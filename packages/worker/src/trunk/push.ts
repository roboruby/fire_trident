import git from "isomorphic-git";
import { ZERO_SHA, authHeaders, type GitRepo, type PushOutcome } from "../artifacts/git.ts";

/**
 * A direct compare-and-swap push of exactly the objects a trunk cycle created.
 *
 * isomorphic-git's push lists the objects to send by walking every tree of the new commits and
 * of the merge base, so its cost grows with the size of trunk. The trunk writer knows exactly
 * what it wrote (the cycle's blobs, rewritten trees and commits), so it packs those and sends one
 * git-receive-pack request: the ref update carries the expected old value, which the server
 * enforces (a stale value is refused per ref), exactly as the existing push.
 */

const te = new TextEncoder();
const td = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One pkt-line (4 hex digits of length, then the payload). */
export function pktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? te.encode(payload) : payload;
  return concat([te.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
}

/** Payloads of the pkt-lines in `bytes` (null for a flush or delimiter packet). */
export function readPktLines(bytes: Uint8Array): Array<Uint8Array | null> {
  const out: Array<Uint8Array | null> = [];
  let i = 0;
  while (i + 4 <= bytes.length) {
    const len = Number.parseInt(td.decode(bytes.subarray(i, i + 4)), 16);
    if (!Number.isFinite(len) || len < 0) throw new Error(`bad pkt-line length at ${i}`);
    if (len <= 1) {
      out.push(null);
      i += 4;
      continue;
    }
    if (len < 4 || i + len > bytes.length) throw new Error(`truncated pkt-line at ${i}`);
    out.push(bytes.subarray(i + 4, i + len));
    i += len;
  }
  return out;
}

/** The git-receive-pack request: one ref update (old value = compare-and-swap) with capabilities, a flush, then the pack. */
export function receivePackRequest(p: { oldOid: string | null; newOid: string; ref: string; capabilities: string[]; pack: Uint8Array }): Uint8Array {
  const command = `${p.oldOid ?? ZERO_SHA} ${p.newOid} ${p.ref}\0 ${p.capabilities.join(" ")}\n`;
  return concat([pktLine(command), te.encode("0000"), p.pack]);
}

/** A parsed report-status: the unpack result and each ref's ok/ng with its reason. */
export interface ReceivePackResult {
  unpack: string;
  refs: Record<string, { ok: boolean; error: string }>;
  messages: string[];
}

/**
 * Parse a git-receive-pack response. With side-band-64k the report-status lines travel on band 1
 * (band 2 is progress, band 3 a fatal error message); without it they are the response itself.
 */
export function parseReceivePackResult(bytes: Uint8Array, sideband: boolean): ReceivePackResult {
  const messages: string[] = [];
  let report = bytes;
  if (sideband) {
    const parts: Uint8Array[] = [];
    for (const line of readPktLines(bytes)) {
      if (line === null || line.length === 0) continue;
      const band = line[0];
      if (band === 1) parts.push(line.subarray(1));
      else if (band === 3) messages.push(`error: ${td.decode(line.subarray(1)).trim()}`);
      else if (band === 2) messages.push(td.decode(line.subarray(1)).trim());
    }
    report = concat(parts);
  }
  const lines = readPktLines(report)
    .filter((l): l is Uint8Array => l !== null)
    .map((l) => td.decode(l).replace(/\n$/, ""));
  const first = lines.shift() ?? "";
  if (!first.startsWith("unpack ")) throw new Error(`unexpected receive-pack report: ${JSON.stringify(first)}${messages.length ? ` (${messages.join("; ")})` : ""}`);
  const refs: ReceivePackResult["refs"] = {};
  for (const line of lines) {
    if (line.trim() === "") continue;
    const ok = line.startsWith("ok ");
    if (!ok && !line.startsWith("ng ")) continue;
    const rest = line.slice(3);
    const space = rest.indexOf(" ");
    const ref = space === -1 ? rest : rest.slice(0, space);
    refs[ref] = { ok, error: space === -1 ? "" : rest.slice(space + 1) };
  }
  return { unpack: first.slice("unpack ".length), refs, messages };
}

/** An HTTP error shaped like isomorphic-git's, so callers' auth retry (isAuthError) recognizes 401/403. */
function httpError(status: number, detail: string): Error {
  const e = new Error(`receive-pack HTTP ${status}: ${detail}`) as Error & { code: string; data: { statusCode: number } };
  e.code = "HttpError";
  e.data = { statusCode: status };
  return e;
}

/**
 * Pack `oids` from the local repo and update `ref` on the remote from `oldOid` to `newOid` in one
 * receive-pack request. Returns ok, stale (the remote ref is not `oldOid`), or a definitive
 * refusal; throws on transport errors (the outcome is then unknown to the caller).
 */
export async function pushPack(repo: GitRepo, p: { url: string; token: string; ref: string; oldOid: string | null; newOid: string; oids: string[] }): Promise<PushOutcome> {
  const { packfile } = await git.packObjects({ fs: repo.fs, dir: repo.dir, oids: [...new Set(p.oids)], write: false, cache: repo.cache });
  if (!packfile) throw new Error("packObjects returned no pack");
  const body = receivePackRequest({ oldOid: p.oldOid, newOid: p.newOid, ref: p.ref, capabilities: ["report-status", "side-band-64k"], pack: packfile });
  const res = await fetch(`${p.url.replace(/\/+$/, "")}/git-receive-pack`, {
    method: "POST",
    headers: { "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result", ...authHeaders(p.token) },
    body,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw httpError(res.status, td.decode(bytes.subarray(0, 200)).replace(/\s+/g, " "));
  return outcomeOf(parseReceivePackResult(bytes, true), p.ref);
}

/**
 * A reply whose outcome cannot be read: the pack was unpacked but the report has no status for the ref (a reply cut at
 * a packet boundary, for one). The update may have applied, so the caller must look at the remote ref.
 */
export class UnclearPushReply extends Error {}

/**
 * What a receive-pack report says about `ref`: ok, stale (the remote ref was not the expected old value), or a definitive
 * refusal (the pack was not unpacked, or the ref was refused for another reason). Throws UnclearPushReply when the pack
 * was unpacked but the report says nothing about the ref.
 */
export function outcomeOf(result: ReceivePackResult, ref: string): PushOutcome {
  if (result.unpack !== "ok") return { ok: false, stale: false, detail: `unpack ${result.unpack}` };
  const r = result.refs[ref];
  if (!r) throw new UnclearPushReply(`receive-pack reply has no status for ${ref}${result.messages.length ? ` (${result.messages.join("; ")})` : ""}`);
  if (r.ok) return { ok: true };
  return /stale|non-fast-forward|fetch first|lock/i.test(r.error) ? { ok: false, stale: true, remoteOid: null, detail: r.error } : { ok: false, stale: false, detail: r.error };
}
