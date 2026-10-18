import { describe, expect, it } from "vitest";
import { PULL_CHANGE_BYTES, PULL_FILE_BYTES, PullRefused, PullTally, changeTooLarge, fileTooLarge, pullCapped, readCapped, type PulledBlob } from "../../src/trunk/pullcap.ts";
import { INLINE_LIMITS } from "@fire_trident/core";

/** A blob that reports no size and hands out `chunks` chunks of `size` bytes, counting what was read and whether it was cancelled. */
function unsized(chunks: number, size: number): PulledBlob & { read: number; cancelled: boolean } {
  const out = {
    read: 0,
    cancelled: false,
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      throw new Error("an unsized blob is read as a stream");
    },
    stream: (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (out.read >= chunks) return controller.close();
          out.read++;
          controller.enqueue(new Uint8Array(size).fill(out.read));
        },
        cancel() {
          out.cancelled = true;
        },
      }),
  };
  return out;
}

describe("the pull caps (trunk/pullcap.ts)", () => {
  it("sit above an inline change's limits", () => {
    expect(PULL_FILE_BYTES).toBeGreaterThan(INLINE_LIMITS.fileBytes);
    expect(PULL_CHANGE_BYTES).toBeGreaterThan(INLINE_LIMITS.totalBytes);
    expect(PULL_CHANGE_BYTES).toBeGreaterThanOrEqual(PULL_FILE_BYTES);
  });

  it("reads a blob within the caps whole", async () => {
    const tally = new PullTally();
    const bytes = await readCapped(new Blob([new Uint8Array([1, 2, 3])]), "src/a.ts", tally);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("refuses a file over the file cap by its size, before reading its bytes", async () => {
    let read = false;
    const big: PulledBlob = {
      size: PULL_FILE_BYTES + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
      stream: () => new ReadableStream(),
    };
    await expect(readCapped(big, "assets/model.bin", new PullTally())).rejects.toThrow(PullRefused);
    expect(read).toBe(false);
    await expect(readCapped({ ...big, size: 3_500_000 }, "a.bin", new PullTally())).rejects.toThrow("a.bin is 3.3 MB, larger than 2 MB, the most");
    await expect(readCapped(big, "assets/model.bin", new PullTally())).rejects.toThrow(
      "assets/model.bin is 2097153 bytes, larger than 2 MB (2097152 bytes), the most the trunk writer takes from a workspace for one file: leave a file that large out of the change (or out of the repository), then propose again",
    );
  });

  it("refuses the file that takes a change over the change cap, counting every file of the change", async () => {
    const tally = new PullTally(10, 25);
    await readCapped(new Blob([new Uint8Array(10)]), "a", tally);
    await readCapped(new Blob([new Uint8Array(10)]), "b", tally);
    await expect(readCapped(new Blob([new Uint8Array(10)]), "c", tally)).rejects.toThrow(changeTooLarge(25));
    // A file at the file cap exactly is fine on a fresh change.
    await expect(readCapped(new Blob([new Uint8Array(10)]), "d", new PullTally(10, 25))).resolves.toHaveLength(10);
  });

  it("reads a blob that reports no size as a stream, and stops it as soon as a cap is passed", async () => {
    const small = unsized(3, 4);
    expect([...(await readCapped(small, "a", new PullTally(100, 100)))]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    const endless = unsized(1_000, 4);
    await expect(readCapped(endless, "logs/huge.log", new PullTally(10, 100))).rejects.toThrow(fileTooLarge("logs/huge.log", null, 10));
    expect(endless.read).toBe(3);
    expect(endless.cancelled).toBe(true);
  });

  it("refuses a blob the workspace service will not hand over for its size, and passes on a missing blob and other errors", async () => {
    const tally = new PullTally();
    await expect(pullCapped(() => Promise.reject(Object.assign(new Error("too big"), { code: "MEMORY_LIMIT" })), "data.bin", tally)).rejects.toThrow(
      "data.bin is larger than 2 MB, the most the trunk writer takes from a workspace for one file",
    );
    await expect(pullCapped(async () => null, "gone.ts", tally)).resolves.toBeNull();
    const other = Object.assign(new Error("internal"), { code: "INTERNAL_ERROR" });
    await expect(pullCapped(() => Promise.reject(other), "x.ts", tally)).rejects.toBe(other);
  });
});
