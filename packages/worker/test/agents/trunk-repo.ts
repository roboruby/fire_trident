import { blobId, sha1Hex, utf8Bytes } from "@fire_trident/core";
import type { Path, Sha } from "@fire_trident/core";
import type { ObjectEntry, TrunkObjects } from "../../src/agents/virtual.ts";

/** A file of a fake trunk commit: its text, or bytes, with an optional mode ("100755", "120000") or a submodule commit. */
export type FakeFile = string | Uint8Array | { content: string | Uint8Array; mode?: string } | { gitlink: Sha };

interface Dir {
  files: Map<string, ObjectEntry>;
  dirs: Map<string, Dir>;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
/** Git's id of an object of `type` with this body. */
const objectId = (type: string, body: Uint8Array): Sha => sha1Hex(concat([utf8Bytes(`${type} ${body.length}\0`), body]));
const sortKey = (e: ObjectEntry): string => (e.type === "tree" ? `${e.name}/` : e.name);

/**
 * A trunk repo in memory that answers like the Artifacts binding (TrunkObjects), with commits, trees and blobs
 * hashed exactly as git hashes them, so blob ids equal core's blobId and tree ids equal git's. It counts every
 * read, so tests can see which objects a virtual checkout asked for.
 */
export class FakeTrunkRepo implements TrunkObjects {
  readonly commits = new Map<Sha, { treeHash: Sha; parents: Sha[] }>();
  readonly trees = new Map<Sha, ObjectEntry[]>();
  readonly blobs = new Map<Sha, Uint8Array>();
  main: Sha | null = null;
  calls = { commit: 0, tree: 0, blob: 0, tip: 0 };
  /** Ids read, in order. */
  treeReads: Sha[] = [];
  blobReads: Sha[] = [];
  /** Milliseconds each read takes (0: answered after the current microtasks). */
  latencyMs = 0;

  /** Make a commit holding exactly `files` (path → content) on top of main, move main to it, and return its id. */
  commit(files: Record<Path, FakeFile>, message = "change"): Sha {
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, file] of Object.entries(files)) {
      const parts = path.split("/");
      let dir = root;
      for (const seg of parts.slice(0, -1)) {
        let next = dir.dirs.get(seg);
        if (!next) dir.dirs.set(seg, (next = { files: new Map(), dirs: new Map() }));
        dir = next;
      }
      dir.files.set(parts.at(-1)!, this.entryFor(parts.at(-1)!, file));
    }
    const treeHash = this.writeTree(root);
    const parents = this.main ? [this.main] : [];
    const body = `tree ${treeHash}\n${parents.map((p) => `parent ${p}\n`).join("")}author a <a@b> 0 +0000\ncommitter a <a@b> 0 +0000\n\n${message}\n`;
    const id = objectId("commit", utf8Bytes(body));
    this.commits.set(id, { treeHash, parents });
    this.main = id;
    return id;
  }

  /** The id of the tree at `dir` in a commit (for asserting what was read). */
  treeAt(commit: Sha, dir: Path): Sha | null {
    let id: Sha | null = this.commits.get(commit)?.treeHash ?? null;
    for (const seg of dir === "" ? [] : dir.split("/")) {
      const e = id ? this.trees.get(id)?.find((x) => x.name === seg && x.type === "tree") : undefined;
      id = e ? e.hash : null;
    }
    return id;
  }

  async readCommit(id: Sha): Promise<{ treeHash: Sha } | null> {
    this.calls.commit++;
    await this.wait();
    const c = this.commits.get(id);
    return c ? { treeHash: c.treeHash } : null;
  }

  async readTree(id: Sha): Promise<ObjectEntry[] | null> {
    this.calls.tree++;
    this.treeReads.push(id);
    await this.wait();
    const t = this.trees.get(id);
    return t ? t.map((e) => ({ ...e })) : null;
  }

  async readBlob(id: Sha): Promise<Uint8Array | null> {
    this.calls.blob++;
    this.blobReads.push(id);
    await this.wait();
    const b = this.blobs.get(id);
    return b ? b.slice() : null;
  }

  async tip(): Promise<Sha | null> {
    this.calls.tip++;
    await this.wait();
    return this.main;
  }

  /** Total reads of each kind since the last call (then reset). */
  takeCalls(): { commit: number; tree: number; blob: number; tip: number } {
    const out = this.calls;
    this.calls = { commit: 0, tree: 0, blob: 0, tip: 0 };
    return out;
  }

  private wait(): Promise<void> {
    return this.latencyMs > 0 ? new Promise((resolve) => setTimeout(resolve, this.latencyMs)) : Promise.resolve();
  }

  private entryFor(name: string, file: FakeFile): ObjectEntry {
    if (typeof file === "object" && !(file instanceof Uint8Array) && "gitlink" in file) return { name, mode: "160000", hash: file.gitlink, type: "gitlink" };
    const content = typeof file === "string" || file instanceof Uint8Array ? file : file.content;
    const mode = typeof file === "object" && !(file instanceof Uint8Array) && "mode" in file && file.mode ? file.mode : "100644";
    const bytes = typeof content === "string" ? utf8Bytes(content) : content;
    const hash = typeof content === "string" ? blobId(content) : objectId("blob", bytes);
    this.blobs.set(hash, bytes);
    const type = mode === "100755" ? "exec" : mode === "120000" ? "symlink" : "blob";
    return { name, mode, hash, type };
  }

  private writeTree(dir: Dir): Sha {
    const entries: ObjectEntry[] = [...dir.files.values()];
    for (const [name, sub] of dir.dirs) entries.push({ name, mode: "40000", hash: this.writeTree(sub), type: "tree" });
    entries.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    const body = concat(entries.flatMap((e) => [utf8Bytes(`${e.mode} ${e.name}\0`), hexBytes(e.hash)]));
    const id = objectId("tree", body);
    this.trees.set(id, entries);
    return id;
  }
}
