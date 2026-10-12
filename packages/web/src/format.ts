const intFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** A finite number, or `fallback` for NaN, Infinity, and non-numbers. */
export function finite(n: unknown, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** A count for display: finite and never below zero. */
export function count(n: unknown): number {
  const v = finite(n);
  return v > 0 ? v : 0;
}

/** Integer with thousands separators (NaN and Infinity render as 0). */
export function fmtInt(n: number): string {
  const v = Math.round(finite(n));
  return intFormat.format(Object.is(v, -0) ? 0 : v);
}

/** A rate or ratio with fixed decimals. */
export function fmtFixed(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "0";
}

/** First `n` characters of a SHA, or a placeholder. */
export function shortSha(sha: string | undefined | null, n = 7): string {
  return sha ? sha.slice(0, n) : "·······";
}

/** A compact form of an opaque id: readable ids stay, long random ones keep their tail. */
export function shortId(id: string): string {
  if (id.length <= 14) return id;
  const cut = id.indexOf("_");
  const prefix = cut > 0 && cut < 6 ? id.slice(0, cut + 1) : "";
  return prefix + id.slice(-6);
}

/** Human time distance from `at` to `now`. */
export function timeAgo(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Wall-clock HH:MM:SS for an epoch time. */
export function clock(at: number): string {
  const d = new Date(finite(at, Date.now()));
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Last path segment. */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Everything before the last path segment, with a trailing slash ("" for root files). */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

/** First `depth` directory segments of a path ("." for root files). */
export function regionOf(path: string, depth = 1): string {
  const parts = path.split("/");
  if (parts.length <= 1) return ".";
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

/** Byte count as B / KB / MB. */
export function fmtBytes(n: number): string {
  const v = count(n);
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10 * 1024 ? 1 : 0)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/** Probability as a percentage string (clamped to 0-100%). */
export function fmtPct(p: number, digits = 0): string {
  const v = Math.max(0, Math.min(1, finite(p)));
  return `${(v * 100).toFixed(digits)}%`;
}

/** A duration in ms as "<1 ms", "340 ms", or "2.4 s". */
export function fmtMs(ms: number): string {
  const v = count(ms);
  if (v < 1) return "<1 ms";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
}

/** A span of time for people: "62 s", "7 min 44 s", "1 h 5 min". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(finite(ms) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** A replay clock position: "0:42", "12:05", "1:02:09". */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(finite(ms) / 1000));
  const p = (x: number) => String(x).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

/** A day and time for labels: "Oct 12, 05:09" (local time). */
export function fmtWhen(at: number): string {
  const d = new Date(finite(at, Date.now()));
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const p = (x: number) => String(x).padStart(2, "0");
  return `${day}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "1 file", "3 files". */
export function plural(n: number, word: string, many = `${word}s`): string {
  const v = count(n);
  return `${fmtInt(v)} ${v === 1 ? word : many}`;
}

/** Escape text for safe insertion into HTML built by hand (tooltips). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

/** A git remote or web URL without the scheme and a trailing ".git", e.g. github.com/org/repo. */
export function prettyUrl(url: string | undefined | null): string {
  if (!url) return "";
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\.git$/, "").replace(/\/$/, "");
}
