// Word timings for the script: align the script's words with Whisper's timed words (edit-distance
// alignment, so a misheard name is just a substitution), then interpolate the gaps.

const norm = (w) =>
  w
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "");

/** Script words with their character offsets. */
export function words(text) {
  const out = [];
  for (const m of text.matchAll(/\S+/g)) {
    const n = norm(m[0]);
    if (n) out.push({ n, raw: m[0], at: m.index });
  }
  return out;
}

/** Whisper's timed words (flattened from segments). */
export function timedWords(whisper) {
  const out = [];
  for (const seg of whisper?.segments ?? []) for (const w of seg.words ?? []) {
    const n = norm(w.word);
    if (n) out.push({ n, start: w.start, end: w.end });
  }
  return out;
}

/** For each script word, {start, end} in seconds of the audio Whisper heard. */
export function align(script, heard, duration) {
  const n = script.length;
  const m = heard.length;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const back = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) {
    cost[i][0] = i;
    back[i][0] = 1;
  }
  for (let j = 1; j <= m; j++) {
    cost[0][j] = j;
    back[0][j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = script[i - 1].n === heard[j - 1].n ? 0 : script[i - 1].n[0] === heard[j - 1].n[0] ? 0.8 : 1;
      const diag = cost[i - 1][j - 1] + same;
      const del = cost[i - 1][j] + 1;
      const ins = cost[i][j - 1] + 1;
      if (diag <= del && diag <= ins) {
        cost[i][j] = diag;
        back[i][j] = 0;
      } else if (del <= ins) {
        cost[i][j] = del;
        back[i][j] = 1;
      } else {
        cost[i][j] = ins;
        back[i][j] = 2;
      }
    }
  }
  const times = new Array(n).fill(null);
  let matched = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const b = back[i][j];
    if (i > 0 && j > 0 && b === 0) {
      times[i - 1] = { start: heard[j - 1].start, end: heard[j - 1].end };
      if (script[i - 1].n === heard[j - 1].n) matched++;
      i--;
      j--;
    } else if (i > 0 && (j === 0 || b === 1)) i--;
    else j--;
  }
  // Words Whisper skipped: interpolate between the neighbors that have times.
  for (let i = 0; i < n; i++) {
    if (times[i]) continue;
    let a = i - 1;
    while (a >= 0 && !times[a]) a--;
    let b = i + 1;
    while (b < n && !times[b]) b++;
    const t0 = a >= 0 ? times[a].end : 0;
    const t1 = b < n ? times[b].start : duration;
    const span = b - a;
    times[i] = { start: t0 + ((t1 - t0) * (i - a - 1)) / span, end: t0 + ((t1 - t0) * (i - a)) / span };
  }
  return { times, matched, total: n, wer: n ? 1 - matched / n : 0 };
}

/** Seconds (into the paragraph audio) where `phrase` starts, or null if it is not in the text. */
export function phraseTime(text, phrase, wordList, times) {
  const at = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (at < 0) return null;
  const i = wordList.findIndex((w) => w.at + w.raw.length > at);
  return i < 0 ? null : times[i].start;
}

/** Sentences of a paragraph with their audio start and end (for subtitles). */
export function sentences(text, wordList, times) {
  const out = [];
  const re = /[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g;
  for (const m of text.matchAll(re)) {
    const s = m[0].trim();
    if (!s) continue;
    const from = m.index;
    const to = m.index + m[0].length;
    const idx = wordList.map((w, i) => (w.at >= from && w.at < to ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    out.push({ text: s, start: times[idx[0]].start, end: times[idx[idx.length - 1]].end });
  }
  return out;
}
