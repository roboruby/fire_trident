import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import type { TreeEntry } from "isomorphic-git";
import { buildTree, ensureRepo, memoryFs, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { applyTreeChangesCached } from "../../src/trunk/surgery.ts";
import { UnclearPushReply, outcomeOf, parseReceivePackResult, pktLine, readPktLines, receivePackRequest } from "../../src/trunk/push.ts";

const te = new TextEncoder();
const td = new TextDecoder();
const A = "a".repeat(40);
const B = "b".repeat(40);

/** A side-band-64k response: each report line pkt-encoded, then wrapped on band 1. */
function sideband(lines: string[], progress: string[] = []): Uint8Array {
  const report = [...lines.map((l) => pktLine(`${l}\n`)), te.encode("0000")];
  const inner = new Uint8Array(report.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of report) {
    inner.set(p, at);
    at += p.length;
  }
  const parts = [...progress.map((m) => pktLine(new Uint8Array([2, ...te.encode(m)]))), pktLine(new Uint8Array([1, ...inner])), te.encode("0000")];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("receive-pack protocol", () => {
  it("encodes pkt-lines and reads them back, flush packets as null", () => {
    expect(td.decode(pktLine("hello\n"))).toBe("000ahello\n");
    const bytes = new Uint8Array([...pktLine("one\n"), ...te.encode("0000"), ...pktLine("two")]);
    expect(readPktLines(bytes).map((l) => (l === null ? null : td.decode(l)))).toEqual(["one\n", null, "two"]);
    expect(() => readPktLines(te.encode("00ffshort"))).toThrow(/truncated/);
  });

  it("writes one ref update with the expected old value, capabilities after NUL, a flush, then the pack", () => {
    const pack = te.encode("PACKDATA");
    const body = receivePackRequest({ oldOid: A, newOid: B, ref: "refs/heads/main", capabilities: ["report-status", "side-band-64k"], pack });
    const command = `${A} ${B} refs/heads/main\0 report-status side-band-64k\n`;
    expect(td.decode(body)).toBe(`${(command.length + 4).toString(16).padStart(4, "0")}${command}0000PACKDATA`);
    const create = td.decode(receivePackRequest({ oldOid: null, newOid: B, ref: "refs/notes/x", capabilities: ["report-status"], pack }));
    expect(create.slice(4, 44)).toBe("0".repeat(40));
  });

  it("parses ok, a stale refusal, and an unpack failure, with or without side-band", () => {
    expect(parseReceivePackResult(sideband(["unpack ok", "ok refs/heads/main"], ["Resolving deltas"]), true)).toEqual({
      unpack: "ok",
      refs: { "refs/heads/main": { ok: true, error: "" } },
      messages: ["Resolving deltas"],
    });
    expect(parseReceivePackResult(sideband(["unpack ok", "ng refs/heads/main stale ref"]), true).refs).toEqual({ "refs/heads/main": { ok: false, error: "stale ref" } });
    const plain = new Uint8Array([...pktLine("unpack index-pack failed\n"), ...pktLine("ng refs/heads/main unpacker error\n"), ...te.encode("0000")]);
    expect(parseReceivePackResult(plain, false)).toMatchObject({ unpack: "index-pack failed", refs: { "refs/heads/main": { ok: false, error: "unpacker error" } } });
    expect(() => parseReceivePackResult(sideband(["hello"]), true)).toThrow(/unexpected receive-pack report/);
  });

  it("reads a report as ok, stale or refused, and a report without the ref's status as an unclear outcome", () => {
    const main = "refs/heads/main";
    expect(outcomeOf({ unpack: "ok", refs: { [main]: { ok: true, error: "" } }, messages: [] }, main)).toEqual({ ok: true });
    expect(outcomeOf({ unpack: "ok", refs: { [main]: { ok: false, error: "stale ref" } }, messages: [] }, main)).toMatchObject({ ok: false, stale: true });
    expect(outcomeOf({ unpack: "index-pack failed", refs: {}, messages: [] }, main)).toEqual({ ok: false, stale: false, detail: "unpack index-pack failed" });
    expect(outcomeOf({ unpack: "ok", refs: { [main]: { ok: false, error: "hook declined" } }, messages: [] }, main)).toEqual({ ok: false, stale: false, detail: "hook declined" });
    // The pack was unpacked but nothing says whether main moved: the caller must look at the remote.
    expect(() => outcomeOf({ unpack: "ok", refs: {}, messages: [] }, main)).toThrow(UnclearPushReply);
  });

  it("packs exactly a chain's new objects into a complete, valid pack", async () => {
    const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
    await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
    const base = await writeLocalBlob(r, te.encode("base\n"));
    const root = await buildTree(r, new Map([["a/one.txt", { blob: base, mode: "100644" }], ["b/two.txt", { blob: base, mode: "100644" }]]));
    const parent = await writeCommitObject(r, { tree: root, parents: [], message: "base", at: 1000 });
    const objects = new Set<string>();
    const trees = new Map<string, TreeEntry[]>();
    const added = await writeLocalBlob(r, te.encode("new\n"));
    objects.add(added);
    const t1 = await applyTreeChangesCached(r, trees, root, new Map([["a/new.txt", { blob: added, mode: "100644" }]]), objects);
    const c1 = await writeCommitObject(r, { tree: t1, parents: [parent], message: "one", at: 2000 });
    objects.add(c1);
    const t2 = await applyTreeChangesCached(r, trees, t1, new Map([["b/two.txt", null]]), objects);
    const c2 = await writeCommitObject(r, { tree: t2, parents: [c1], message: "two", at: 3000 });
    objects.add(c2);
    // Two commits, the new blob, and the rewritten trees: root and a/ for the first, root for the second (b/ is gone).
    expect(objects.size).toBe(6);
    const { packfile } = await git.packObjects({ fs: r.fs, dir: r.dir, oids: [...objects], write: false });
    expect(td.decode(packfile!.subarray(0, 4))).toBe("PACK");
    // A fresh repo holding only the base objects can index the pack and read the new commit's tree.
    const other: GitRepo = { fs: memoryFs(), dir: "/o", cache: {} };
    await ensureRepo(other, "https://example.invalid/git/ns/repo.git");
    await other.fs.promises.writeFile("/o/.git/objects/pack/pack-test.pack", packfile!);
    const { oids } = await git.indexPack({ fs: other.fs, dir: other.dir, filepath: ".git/objects/pack/pack-test.pack" });
    expect(new Set(oids)).toEqual(objects);
  });
});
