// 16-bit mono PCM WAV helpers. The synthesizer streams its WAV, so the header's chunk sizes are
// placeholders; the data chunk is read to the end of the file instead.
import { readFileSync, writeFileSync } from "node:fs";

export const RATE = 48_000;

/** Samples of a 16-bit PCM WAV (mono, or the first channel). */
export function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path} is not a WAV file`);
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error(`${path}: expected 16-bit PCM`);
      const end = size > 0 && body + size <= buf.length ? body + size : buf.length;
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const out = new Int16Array(frames);
      for (let i = 0; i < frames; i++) out[i] = buf.readInt16LE(body + i * 2 * fmt.channels);
      return { samples: out, rate: fmt.rate };
    }
    off = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

/** Write 16-bit mono PCM. */
export function writeWav(path, samples, rate = RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length * 2, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]));
}

/**
 * Trim leading and trailing near-silence, keeping padMs of air on each side; returns the samples
 * and how many were cut from the front (so word timings can be shifted).
 */
export function trimSilence(samples, rate = RATE, { threshold = 500, padMs = 60, windowMs = 10 } = {}) {
  const win = Math.max(1, Math.round((rate * windowMs) / 1000));
  const loud = (i) => {
    let peak = 0;
    for (let j = i; j < Math.min(samples.length, i + win); j++) peak = Math.max(peak, Math.abs(samples[j]));
    return peak >= threshold;
  };
  let a = 0;
  while (a < samples.length && !loud(a)) a += win;
  let b = samples.length;
  while (b > a && !loud(Math.max(0, b - win))) b -= win;
  const pad = Math.round((rate * padMs) / 1000);
  const start = Math.max(0, a - pad);
  const end = Math.min(samples.length, b + pad);
  return { samples: samples.slice(start, end), cut: start };
}

/** Short fade at both ends so joins never click. */
export function fadeEdges(samples, rate = RATE, ms = 8) {
  const n = Math.min(Math.round((rate * ms) / 1000), Math.floor(samples.length / 2));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    samples[i] = Math.round(samples[i] * g);
    samples[samples.length - 1 - i] = Math.round(samples[samples.length - 1 - i] * g);
  }
  return samples;
}
