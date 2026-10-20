// The documentation pages of the site. After `vite build`, the repository's markdown (the README, docs/, the agent
// guides, the Artifacts spike, the changelog, contributing and security notes, every measured run's README and every
// other markdown file beside it) is rendered into dist/docs/<page>/index.html, so firetrident.com/docs/... serves the
// documents of the deployed build rather than the repository's. Every file under packages/bench/results (logs, JSON,
// reports) is published beside its run, and any other file a document links to (a script, the license) is published
// under /docs/files/<repository path>, so no link leaves the site for something the site can hold; only a folder
// outside the results still points at the repository. `npm run build` in this package runs it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DIST = resolve(HERE, "../dist");
const REPO = "https://github.com/roboruby/fire_trident";
const SITE = "https://firetrident.com";
const RESULTS = "packages/bench/results";

/** A markdown file's name as a path segment: "ARCHITECTURE.md" is "architecture", "AGENTS.template.md" is "agents-template". */
const slug = (file) => file.replace(/\.md$/, "").replace(/\./g, "-").toLowerCase();
/** A repository path as page segments: "sweep/coordination-10-agents.md" is "sweep/coordination-10-agents". */
const slugPath = (p) => p.split("/").map(slug).join("/");

/** The pages, by the repository path they come from: a markdown file, or a results folder with no README (a file list). */
const pages = new Map();
const put = (repo, path, group, label) => pages.set(repo, { repo, path, group, label });
/** Every other file the site publishes, by repository path: where it is written under dist, and what a link to it says. */
const files = new Map();

/** Extensions a browser shows in place; a file with any other gets .txt appended so it reads as text instead of downloading. */
const SHOWN = new Set(["html", "json", "js", "mjs", "css", "svg", "png", "jpg", "jpeg", "gif", "webp", "txt", "csv", "pdf"]);

/** Where a repository file is published: beside its run for a results file, under /docs/files/ for anything else. */
function publish(clean) {
  if (files.has(clean)) return files.get(clean);
  const under = clean.startsWith(`${RESULTS}/`) ? `/docs/results/${clean.slice(RESULTS.length + 1)}` : `/docs/files/${clean}`;
  let base = posix.basename(under);
  if (base === "index.html") base = "report.html"; // index.html is the folder's own page
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  const at = posix.join(posix.dirname(under), SHOWN.has(ext) ? base : `${base}.txt`);
  // The static assets serve x.html at /x and redirect /x.html there, so a link says /x.
  const entry = { at, href: at.replace(/\.html$/, "") };
  files.set(clean, entry);
  return entry;
}

put("README.md", "/docs/", "start", "Start here");
put("docs/try-it.md", "/docs/try-it/", "start", "Try it");
put("docs/agents/README.md", "/docs/agents/", "start", "Bring your own agent");
for (const f of readdirSync(join(ROOT, "docs/agents")).sort()) {
  if (f.endsWith(".md") && f !== "README.md") put(`docs/agents/${f}`, `/docs/agents/${slug(f)}/`, "agents", f.replace(/\.md$/, ""));
}
put("docs/ARCHITECTURE.md", "/docs/architecture/", "design", "Architecture");
put("docs/mechanisms.md", "/docs/mechanisms/", "design", "Mechanisms");
put("docs/glossary.md", "/docs/glossary/", "design", "Glossary");
put("docs/related-work.md", "/docs/related-work/", "design", "Related work");
for (const f of readdirSync(join(ROOT, "docs")).sort()) {
  if (f.endsWith(".md") && !pages.has(`docs/${f}`)) put(`docs/${f}`, `/docs/${slug(f)}/`, "design", f.replace(/\.md$/, ""));
}
put("docs/results.md", "/docs/results/", "evidence", "Results");
put("spike/RESULTS.md", "/docs/spike/", "evidence", "The Artifacts spike");
put("CHANGELOG.md", "/docs/changelog/", "project", "Changelog");
put("CONTRIBUTING.md", "/docs/contributing/", "project", "Contributing");
if (existsSync(join(ROOT, "SECURITY.md"))) put("SECURITY.md", "/docs/security/", "project", "Security");

/** The measured runs, newest first. */
const runs = readdirSync(join(ROOT, RESULTS))
  .filter((d) => statSync(join(ROOT, RESULTS, d)).isDirectory())
  .sort()
  .reverse();

/**
 * Every folder and file under the results: a README is its folder's page, another markdown file is a page of its own,
 * a folder with no README is a file list, and every other file is published as it is.
 */
function walkResults(rel) {
  const dir = rel ? `${RESULTS}/${rel}` : RESULTS;
  const names = readdirSync(join(ROOT, dir)).sort();
  if (rel) {
    if (names.includes("README.md")) put(`${dir}/README.md`, `/docs/results/${rel}/`, "runs", rel);
    else put(dir, `/docs/results/${rel}/`, "runs", rel);
  }
  for (const name of names) {
    const repo = `${dir}/${name}`;
    const sub = rel ? `${rel}/${name}` : name;
    if (statSync(join(ROOT, repo)).isDirectory()) {
      walkResults(sub);
      continue;
    }
    if (name === "README.md") continue;
    if (name.endsWith(".md")) put(repo, `/docs/results/${slugPath(sub)}/`, "runs", sub.replace(/\.md$/, ""));
    else publish(repo);
  }
}
walkResults("");

/** The page a repository path names: the file itself, or a folder's README, or a folder published as a file list. */
function pageFor(repoPath) {
  const clean = repoPath.replace(/\/+$/, "").replace(/^\.\//, "");
  return pages.get(clean) ?? pages.get(`${clean}/README.md`) ?? null;
}

/**
 * Where a repository path lives on the site: its page, its published file, or (a folder outside the results, a path
 * that does not exist) the repository. A markdown file met here for the first time becomes a page under /docs/files/.
 */
function place(clean, hash) {
  if (clean === RESULTS) return "/docs/results/#every-measured-run";
  const page = pageFor(clean);
  if (page) return page.path + hash;
  const onDisk = join(ROOT, clean);
  if (!existsSync(onDisk)) return `${REPO}/blob/main/${clean}${hash}`;
  if (statSync(onDisk).isDirectory()) return `${REPO}/tree/main/${clean}`;
  if (clean.endsWith(".md")) {
    put(clean, `/docs/files/${slugPath(clean)}/`, "files", clean);
    return pages.get(clean).path + hash;
  }
  return publish(clean).href + hash;
}

/** Where a link in `fromRepo` goes on the site: a page, a published file, the repository, or where it already pointed. */
function rewrite(fromRepo, href) {
  if (!href || href.startsWith("#") || /^mailto:/i.test(href)) return href;
  if (/^https?:/i.test(href)) {
    const m = /^https:\/\/github\.com\/roboruby\/fire_trident\/(?:blob|tree)\/main\/([^#?]*)(#.*)?$/.exec(href);
    return m ? place(m[1].replace(/\/+$/, ""), m[2] ?? "") : href;
  }
  const hashAt = href.indexOf("#");
  const target = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  if (target === "") return hash;
  const clean = posix.normalize(posix.join(posix.dirname(fromRepo), target)).replace(/\/+$/, "").replace(/^\.\//, "");
  return place(clean, hash);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub's heading ids, so the anchors the documents use among themselves keep working here. */
function headingId(text, seen) {
  let id = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
  const n = seen.get(id) ?? 0;
  seen.set(id, n + 1);
  if (n) id = `${id}-${n}`;
  return id;
}

/** The markdown of one document as HTML, its links rewritten and its headings given ids. */
function render(fromRepo, md) {
  const seen = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const id = headingId(html.replace(/<[^>]+>/g, ""), seen);
        return `<h${depth} id="${id}">${html} <a class="anchor" href="#${id}" aria-hidden="true">#</a></h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const to = rewrite(fromRepo, href);
        const external = /^https?:/i.test(to) && !to.startsWith(`${SITE}/`) && to !== SITE;
        return `<a href="${esc(to)}"${title ? ` title="${esc(title)}"` : ""}${external ? ' target="_blank" rel="noreferrer"' : ""}>${text}</a>`;
      },
    },
  });
  return marked.parse(md);
}

const STRIP = [
  ["Start here", "/docs/"],
  ["Try it", "/docs/try-it/"],
  ["Agents", "/docs/agents/"],
  ["Architecture", "/docs/architecture/"],
  ["Mechanisms", "/docs/mechanisms/"],
  ["Results", "/docs/results/"],
  ["Glossary", "/docs/glossary/"],
  ["Related work", "/docs/related-work/"],
  ["Spike", "/docs/spike/"],
  ["Changelog", "/docs/changelog/"],
  ["Contributing", "/docs/contributing/"],
  ["Security", "/docs/security/"],
];

const MARK =
  '<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><g fill="none" stroke="#f38020" stroke-width="2.6" stroke-linecap="round"><path d="M16 6.5V29"/><path d="M7.5 9v4a8.5 8.5 0 0 0 17 0V9"/></g><g fill="#f38020"><path d="M16 1.6l3.1 5h-6.2z"/><path d="M7.5 4.2l2.7 4.6H4.8z"/><path d="M24.5 4.2l2.7 4.6h-5.4z"/></g></svg>';
const GITHUB =
  '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

const CSS = `
:root{--bg:#05070b;--text:#e6eefc;--text-2:#b7c2d6;--text-3:#8a97ad;--line:#1a2231;--line-2:#2a3647;--accent:#f38020;--accent-2:#ffb469;--trail:#1fe08e;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent-2);text-decoration:none}a:hover{text-decoration:underline}
.nav{display:flex;align-items:center;gap:clamp(12px,2vw,28px);max-width:1180px;margin:0 auto;padding:18px 24px;font-size:14px;color:var(--text-2)}
.nav .brand{display:inline-flex;align-items:center;gap:10px;margin-right:auto;font-size:18px;font-weight:700;color:var(--text)}.nav a:hover{color:var(--text);text-decoration:none}
.nav .gh{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:1px solid var(--line-2);border-radius:50%;color:var(--text-2)}
.nav .btn{display:inline-flex;align-items:center;height:36px;padding:0 14px;border:1px solid var(--line-2);border-radius:10px;background:#0e141e;font-size:13.5px;font-weight:650;color:var(--text)}.nav .btn.primary{border-color:var(--accent);background:var(--accent);color:#fff}
.nav .links{display:none}@media(min-width:980px){.nav .links{display:contents}}
.strip{max-width:1180px;margin:0 auto;padding:0 24px 8px;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;border-bottom:1px solid var(--line)}.strip a{color:var(--text-3);padding:6px 0}.strip a.on{color:var(--accent-2);font-weight:650}
main{max-width:880px;margin:0 auto;padding:28px 24px 80px}
article h1{font-size:34px;line-height:1.15;letter-spacing:-0.02em;margin:0 0 20px}article h2{font-size:24px;margin:44px 0 12px;letter-spacing:-0.01em}article h3{font-size:18px;margin:30px 0 8px}article h4{font-size:16px;margin:22px 0 6px}
.anchor{margin-left:6px;color:var(--line-2);font-weight:400;text-decoration:none}h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{color:var(--text-3)}
article p,article li{color:var(--text-2)}article li{margin:4px 0}article strong{color:var(--text)}
article code{font:13.5px var(--mono);padding:1px 5px;border-radius:5px;background:#131a26;color:var(--text)}article pre{overflow:auto;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:#0b1018}article pre code{padding:0;background:none;font-size:13px;line-height:1.55}
article table{display:block;overflow-x:auto;border-collapse:collapse;margin:16px 0;font-size:14px}article th,article td{padding:8px 12px;border:1px solid var(--line);vertical-align:top;text-align:left}article th{color:var(--text);background:#0b1018}article td{color:var(--text-2)}
article blockquote{margin:16px 0;padding:4px 16px;border-left:3px solid var(--line-2);color:var(--text-3)}article hr{border:0;border-top:1px solid var(--line);margin:32px 0}article img{max-width:100%}
.runs,.files{columns:2;column-gap:24px;font-size:14px}@media(max-width:640px){.runs,.files{columns:1}}
footer{max-width:880px;margin:0 auto;padding:0 24px 48px;font-size:13px;color:var(--text-3);border-top:1px solid var(--line)}footer p{margin:16px 0 0}
`;

function nav() {
  return `<nav class="nav"><a class="brand" href="/">${MARK}<span>FireTrident</span></a><span class="links"><a href="/#questions">Answers</a><a href="/#results">Results</a><a href="/#how">How it works</a><a href="/#try">Try it</a><a href="/#run">Run it</a><a href="/limits">Limits</a><a href="/connect">Connect</a><a href="/docs/">Docs</a></span><a class="gh" href="${REPO}" target="_blank" rel="noreferrer" aria-label="Source on GitHub" title="Source on GitHub">${GITHUB}</a><a class="btn primary" href="/auth/github/start">Sign in</a><a class="btn" href="/account?request=1">Request invite</a></nav>`;
}

function strip(current) {
  return `<div class="strip">${STRIP.map(([label, path]) => `<a href="${path}"${path === current ? ' class="on"' : ""}>${label}</a>`).join("")}</div>`;
}

function html({ title, body, path, repo }) {
  const source = repo ? `<p>This page is <code>${esc(repo)}</code> of the deployed build, rendered at build time.</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title === "FireTrident" ? "FireTrident docs" : `${title} · FireTrident`)}</title>
<meta name="description" content="${esc(title)}: FireTrident documentation.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cg fill='none' stroke='%23f38020' stroke-width='2.6' stroke-linecap='round'%3E%3Cpath d='M16 6.5V29'/%3E%3Cpath d='M7.5 9v4a8.5 8.5 0 0 0 17 0V9'/%3E%3C/g%3E%3Cg fill='%23f38020'%3E%3Cpath d='M16 1.6l3.1 5h-6.2z'/%3E%3Cpath d='M7.5 4.2l2.7 4.6H4.8z'/%3E%3Cpath d='M24.5 4.2l2.7 4.6h-5.4z'/%3E%3C/g%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
${nav()}
${strip(path)}
<main><article>
${body}
</article></main>
<footer>${source}<p>FireTrident is MIT licensed. <a href="/">Home</a> · <a href="/docs/">Docs</a> · <a href="/limits">Limits</a></p></footer>
</body>
</html>
`;
}

/** The title of a document: its first heading, else its label. */
function titleOf(md, label) {
  const m = /^#\s+(.+?)\s*$/m.exec(md);
  return m ? m[1].replace(/[*_`]/g, "") : label;
}

/** What a results folder holds, each entry linked to its page or its published file. */
function folderList(repoDir) {
  const names = readdirSync(join(ROOT, repoDir)).sort();
  return names
    .map((name) => {
      const repo = `${repoDir}/${name}`;
      const dir = statSync(join(ROOT, repo)).isDirectory();
      return `<li><a href="${esc(place(repo, ""))}"><code>${esc(dir ? `${name}/` : name)}</code></a></li>`;
    })
    .join("\n");
}

/** A results folder with no README: its files. */
function fileListPage(repoDir, label) {
  return `<h1 id="run">${esc(label)}</h1>\n<p>This folder has no README. Its logs and data:</p>\n<ul class="files">\n${folderList(repoDir)}\n</ul>\n`;
}

/** Under a run's README: everything beside it. */
function inThisFolder(repoDir) {
  return `<h2 id="in-this-folder">In this folder <a class="anchor" href="#in-this-folder" aria-hidden="true">#</a></h2>\n<ul class="files">\n${folderList(repoDir)}\n</ul>\n`;
}

/** Every measured run, newest first, appended to the results page. */
function runsList() {
  const items = runs.map((d) => `<li><a href="/docs/results/${d}/">${esc(d)}</a></li>`).join("\n");
  return `<h2 id="every-measured-run">Every measured run <a class="anchor" href="#every-measured-run" aria-hidden="true">#</a></h2>\n<p>Each run's README, newest first, with its logs and data files beside it.</p>\n<ul class="runs">\n${items}\n</ul>\n`;
}

if (!existsSync(DIST)) {
  console.error("docs: packages/web/dist is missing; run vite build first");
  process.exit(1);
}
// A page's links may bring in a markdown file the site did not list (place() adds it), so the pass runs until every
// page it knows is written.
const written = new Set();
for (;;) {
  const page = [...pages.values()].find((p) => !written.has(p.repo));
  if (!page) break;
  written.add(page.repo);
  const isDir = !page.repo.endsWith(".md");
  const md = isDir ? null : readFileSync(join(ROOT, page.repo), "utf8");
  const title = isDir ? page.label : titleOf(md, page.label);
  let body = isDir ? fileListPage(page.repo, page.label) : render(page.repo, md);
  if (page.repo === "docs/results.md") body += runsList();
  if (page.repo.startsWith(`${RESULTS}/`) && page.repo.endsWith("/README.md")) body += inThisFolder(posix.dirname(page.repo));
  const dir = join(DIST, page.path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html({ title, body, path: page.path, repo: isDir ? null : page.repo }));
}
for (const [repo, { at }] of files) {
  const to = join(DIST, at);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(ROOT, repo), to);
}
console.log(`docs: ${written.size} pages and ${files.size} files under dist/docs`);
