/** Axis-aligned rectangle in CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A directory's box in the treemap. */
export interface DirBox extends Rect {
  path: string;
  name: string;
  depth: number;
  files: number;
  /** Height of the label strip at the top of the box (0 = no label). */
  header: number;
}

/** A laid-out treemap: per-file tile rects in typed arrays plus directory boxes. */
export interface TreemapLayout {
  n: number;
  x: Float32Array;
  y: Float32Array;
  w: Float32Array;
  h: Float32Array;
  paths: string[];
  sizes: Float64Array;
  /** Base-tint group per tile (by file kind). */
  group: Uint8Array;
  /** Index into `dirs` of the tile's top-level directory (-1 for root files). */
  region: Int32Array;
  index: Map<string, number>;
  dirs: DirBox[];
  dirIndex: Map<string, number>;
}

interface Node {
  name: string;
  path: string;
  aliases: string[];
  value: number;
  files: number;
  children: Node[] | null;
  file: number;
}

/** Base-tint group of a file: 0 code, 1 ui, 2 test, 3 data, 4 docs, 5 config, 6 other. */
export function fileGroup(path: string): number {
  const lower = path.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(lower) || /\.(test|spec)\.[a-z]+$/.test(lower)) return 2;
  const dot = lower.lastIndexOf(".");
  const ext = dot < 0 ? "" : lower.slice(dot + 1);
  switch (ext) {
    case "ts":
    case "js":
    case "mjs":
    case "cjs":
    case "go":
    case "rs":
    case "rb":
    case "py":
      return 0;
    case "tsx":
    case "jsx":
    case "vue":
    case "svelte":
    case "css":
    case "html":
      return 1;
    case "sql":
    case "prisma":
      return 3;
    case "md":
    case "mdx":
    case "txt":
      return 4;
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "jsonc":
      return 5;
    default:
      return 6;
  }
}

function buildTree(files: ReadonlyArray<{ path: string; size: number }>): Node {
  const root: Node = { name: "", path: "", aliases: [], value: 0, files: 0, children: [], file: -1 };
  const dirs = new Map<string, Node>([["", root]]);
  const sorted = files.map((f) => Math.max(0, f.size || 0)).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] ?? 1024;
  const floor = Math.max(160, median * 0.12);
  const cap = Math.max(median * 28, floor * 4);
  files.forEach((f, idx) => {
    const parts = f.path.split("/");
    let parent = root;
    let acc = "";
    for (let d = 0; d < parts.length - 1; d++) {
      const seg = parts[d] ?? "";
      acc = acc ? `${acc}/${seg}` : seg;
      let node = dirs.get(acc);
      if (!node) {
        node = { name: seg, path: acc, aliases: [], value: 0, files: 0, children: [], file: -1 };
        dirs.set(acc, node);
        parent.children?.push(node);
      }
      parent = node;
    }
    const weight = Math.min(cap, Math.max(floor, f.size || 0));
    parent.children?.push({ name: parts[parts.length - 1] ?? f.path, path: f.path, aliases: [], value: weight, files: 1, children: null, file: idx });
  });
  const finish = (n: Node, depth: number): void => {
    if (!n.children) return;
    // Collapse single-directory chains (src/main/java) into one labeled box.
    let kids: Node[] = n.children;
    for (;;) {
      if (depth < 1 || kids.length !== 1) break;
      const only: Node | undefined = kids[0];
      if (!only || !only.children) break;
      n.aliases.push(n.path);
      n.name = `${n.name}/${only.name}`;
      n.path = only.path;
      kids = only.children;
    }
    n.children = kids;
    let v = 0;
    let c = 0;
    for (const ch of kids) {
      finish(ch, depth + 1);
      v += ch.value;
      c += ch.files;
    }
    n.value = v;
    n.files = c;
  };
  finish(root, 0);
  return root;
}

/** Lay out files as a squarified treemap inside `rect`, grouped by directory. */
export function layoutTreemap(files: ReadonlyArray<{ path: string; size: number }>, rect: Rect): TreemapLayout {
  const n = files.length;
  const L: TreemapLayout = {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    w: new Float32Array(n),
    h: new Float32Array(n),
    paths: new Array<string>(n),
    sizes: new Float64Array(n),
    group: new Uint8Array(n),
    region: new Int32Array(n).fill(-1),
    index: new Map(),
    dirs: [],
    dirIndex: new Map(),
  };
  files.forEach((f, i) => {
    L.paths[i] = f.path;
    L.sizes[i] = f.size;
    L.group[i] = fileGroup(f.path);
    L.index.set(f.path, i);
  });
  if (!n) return L;

  const place = (node: Node, r: Rect, depth: number, region: number): void => {
    if (!node.children) {
      // Snap to whole pixels: neighbors share rounded edges, so every gap is exactly 1px and outlines stay crisp.
      const i = node.file;
      const x0 = Math.round(r.x);
      const y0 = Math.round(r.y);
      const w = Math.round(r.x + r.w) - x0;
      const h = Math.round(r.y + r.h) - y0;
      const gap = w >= 3 && h >= 3 ? 1 : 0;
      L.x[i] = x0;
      L.y[i] = y0;
      L.w[i] = Math.max(0, w - gap);
      L.h[i] = Math.max(0, h - gap);
      L.region[i] = region;
      return;
    }
    let inner = r;
    let myRegion = region;
    if (depth >= 1) {
      const pad = depth === 1 ? 3 : depth === 2 ? 2 : 1;
      const header = depth === 1 ? (r.h > 46 && r.w > 44 ? 18 : 0) : depth === 2 && r.h > 64 && r.w > 84 ? 14 : 0;
      const idx = L.dirs.length;
      const bx = Math.round(r.x);
      const by = Math.round(r.y);
      L.dirs.push({ x: bx, y: by, w: Math.round(r.x + r.w) - bx, h: Math.round(r.y + r.h) - by, path: node.path, name: node.name, depth, files: node.files, header });
      L.dirIndex.set(node.path, idx);
      for (const a of node.aliases) L.dirIndex.set(a, idx);
      if (depth === 1) myRegion = idx;
      inner = { x: r.x + pad, y: r.y + pad + header, w: Math.max(0, r.w - pad * 2), h: Math.max(0, r.h - pad * 2 - header) };
    }
    const kids = [...node.children].sort((a, b) => b.value - a.value);
    const rects = squarify(
      kids.map((k) => k.value),
      inner,
    );
    kids.forEach((k, j) => place(k, rects[j] ?? { x: inner.x, y: inner.y, w: 0, h: 0 }, depth + 1, myRegion));
  };
  place(buildTree(files), rect, 0, -1);
  return L;
}

function worst(sum: number, min: number, max: number, side: number): number {
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): split `rect` into one rectangle
 * per value (values sorted descending, all positive), keeping aspect ratios near 1.
 */
export function squarify(values: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = [];
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0) || rect.w <= 0 || rect.h <= 0) return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const scale = (rect.w * rect.h) / total;
  const areas = values.map((v) => Math.max(v, 0) * scale);
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const first = areas[i] ?? 0;
    let sum = first;
    let min = first;
    let max = first;
    let best = worst(sum, min, max, side);
    let j = i + 1;
    while (j < areas.length) {
      const a = areas[j] ?? 0;
      const nSum = sum + a;
      const nMin = Math.min(min, a);
      const nMax = Math.max(max, a);
      const nWorst = worst(nSum, nMin, nMax, side);
      if (nWorst > best) break;
      sum = nSum;
      min = nMin;
      max = nMax;
      best = nWorst;
      j++;
    }
    if (w >= h) {
      const stripW = h > 0 ? Math.min(w, sum / h) : 0;
      let yy = y;
      for (let k = i; k < j; k++) {
        const hh = stripW > 0 ? (areas[k] ?? 0) / stripW : 0;
        out.push({ x, y: yy, w: stripW, h: hh });
        yy += hh;
      }
      x += stripW;
      w -= stripW;
    } else {
      const stripH = w > 0 ? Math.min(h, sum / w) : 0;
      let xx = x;
      for (let k = i; k < j; k++) {
        const ww = stripH > 0 ? (areas[k] ?? 0) / stripH : 0;
        out.push({ x: xx, y, w: ww, h: stripH });
        xx += ww;
      }
      y += stripH;
      h -= stripH;
    }
    i = j;
  }
  return out;
}
