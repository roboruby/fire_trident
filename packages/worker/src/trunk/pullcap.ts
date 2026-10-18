import type { Path } from "@fire_trident/core";

/**
 * Byte caps on what the trunk writer pulls from an agent's workspace for one change (TrunkDO.pullBlobs). Each new blob
 * of a change is read into the trunk writer's memory, hashed and written to its local store, and a landing cycle pulls
 * many changes at once, so one huge file must send back only its own change, and never stop the cycle that holds
 * everyone else's. A blob's size is checked before its bytes are read, the change's files are counted as they come,
 * and a blob that reports no size is read as a stream that stops at a cap.
 *
 * The caps sit above an inline change's (core INLINE_LIMITS: 256 KB a file, 512 KB a change), so whatever an inline
 * change can carry also comes through a workspace, and inside a Worker's 128 MB of memory: a file is 2 MB at most (8
 * times the inline file, 4 times the largest file text merge reads), and a change 8 MB (the trunk writer's other per-cycle
 * text budgets, and 16 times the inline change), so a change in flight holds at most 8 MB of blobs and their copies
 * stay a small share of the isolate.
 */

/** Largest file (bytes) the trunk writer pulls from a workspace for one change. */
export const PULL_FILE_BYTES = 2 * 1024 * 1024;
/** Bytes the trunk writer pulls from a workspace for one change at most, all its new files together. */
export const PULL_CHANGE_BYTES = 8 * 1024 * 1024;

/** A file or change over its cap: the change goes back with this sentence (TrunkDO turns it into its ProposalProblem). */
export class PullRefused extends Error {}

/** One change's pull as it goes: the bytes its files took so far, against the caps. */
export class PullTally {
  private bytes = 0;

  constructor(
    readonly fileCap = PULL_FILE_BYTES,
    readonly changeCap = PULL_CHANGE_BYTES,
  ) {}

  /**
   * Count `n` more bytes of `path`, whose bytes so far are `sofar` (`whole`: that is the file's size, not only what
   * was read of it yet); throws PullRefused past either cap.
   */
  take(path: Path, n: number, sofar: number, whole: boolean): void {
    if (sofar > this.fileCap) throw new PullRefused(fileTooLarge(path, whole ? sofar : null, this.fileCap));
    this.bytes += n;
    if (this.bytes > this.changeCap) throw new PullRefused(changeTooLarge(this.changeCap));
  }
}

/** A size in the units a person reads: "3.2 MB", "512 KB". */
function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Number((bytes / (1024 * 1024)).toFixed(1))} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** What a change hears when one of its files is over the file cap (`size`: the file's size, null when not known). */
export function fileTooLarge(path: Path, size: number | null, cap: number): string {
  let what = `larger than ${sizeText(cap)}`;
  if (size !== null) what = sizeText(size) === sizeText(cap) ? `${size} bytes, larger than ${sizeText(cap)} (${cap} bytes)` : `${sizeText(size)}, larger than ${sizeText(cap)}`;
  return `${path} is ${what}, the most the trunk writer takes from a workspace for one file: leave a file that large out of the change (or out of the repository), then propose again`;
}

/** What a change hears when its files together are over the change cap. */
export function changeTooLarge(cap: number): string {
  return `this change's new files come to more than ${sizeText(cap)}, the most the trunk writer takes from a workspace for one change: split it into smaller changes and propose each`;
}

/** The parts of a Blob a pull reads (the Artifacts binding's readBlob answers a Blob). */
export type PulledBlob = { readonly size?: unknown; arrayBuffer(): Promise<ArrayBuffer>; stream(): ReadableStream<Uint8Array> };

/**
 * The bytes of one pulled blob within the caps: its size first, when the blob reports one, so a file over the cap is
 * refused before its bytes are copied; else a stream that is cancelled as soon as the file or the change passes a cap.
 */
export async function readCapped(blob: PulledBlob, path: Path, tally: PullTally): Promise<Uint8Array> {
  if (typeof blob.size === "number" && Number.isFinite(blob.size) && blob.size >= 0) {
    tally.take(path, blob.size, blob.size, true);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // A blob that held more than it said is refused all the same.
    if (bytes.length > blob.size) tally.take(path, bytes.length - blob.size, bytes.length, true);
    return bytes;
  }
  const reader = blob.stream().getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      tally.take(path, value.length, length, false);
      parts.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Read one blob of a change from its workspace within the caps (readCapped): null when the workspace does not have it.
 * A blob the workspace service will not hand over because of its size (an Artifacts MEMORY_LIMIT) is refused like one
 * over the file cap.
 */
export async function pullCapped(read: () => Promise<PulledBlob | null>, path: Path, tally: PullTally): Promise<Uint8Array | null> {
  let blob: PulledBlob | null;
  try {
    blob = await read();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "MEMORY_LIMIT") throw new PullRefused(fileTooLarge(path, null, tally.fileCap));
    throw err;
  }
  return blob === null ? null : readCapped(blob, path, tally);
}
