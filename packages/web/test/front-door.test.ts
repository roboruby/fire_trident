import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Questions } from "../src/landing/Questions.tsx";
import { PUBLIC_MCP_COMMAND, QUESTIONS, SITE, VERIFY_COMMANDS } from "../src/landing/questions.ts";

/**
 * The front door for agents: the questions answered on the landing page, in public/llms.txt and public/start.md, in the
 * static summary of index.html and at the top of the README, word for word, with numbers the README's results hold.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const llms = read("../public/llms.txt");
const start = read("../public/start.md");
const readme = read("../../../README.md");
const indexHtml = read("../index.html");

/** Text of some HTML: tags dropped, the few entities index.html uses decoded. */
function htmlText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

/** What README.md's results section says: the rows of "What it has done". */
const results = readme.slice(readme.indexOf("## What it has done"), readme.indexOf("## Watch a finished run"));

/** The numbers in a text, as written ("1,287", "19.4"), leaving out the one in "SHA-256". */
const numbers = (s: string) => [...s.replaceAll("SHA-256", "").matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]);

/** The static summary inside #root, which React replaces on load. */
const summary = /<div id="root">([\s\S]*?)<\/div>\s*<script type="module"/.exec(indexHtml)?.[1] ?? "";

describe("the questions", () => {
  it("are the four questions a git platform for agents must answer, then whether an agent can join", () => {
    expect(QUESTIONS.map((q) => q.question)).toEqual([
      "How do agents coordinate?",
      "What happens when their changes conflict?",
      "How is work reviewed?",
      "How is the why recorded?",
      "Can my agent join?",
    ]);
  });

  it("answer each in one sentence with a measured number from the README's results and one link", () => {
    expect(results.length).toBeGreaterThan(1000);
    for (const q of QUESTIONS) {
      expect(q.answer.match(/[.!?](?=\s|$)/g), q.id).toHaveLength(1);
      for (const n of numbers(q.figure)) expect(q.answer, q.id).toContain(n);
      for (const n of numbers(q.answer)) expect(results, `${q.id}: ${n}`).toContain(n);
      expect(q.link.href).toMatch(/^https:\/\//);
    }
  });

  it("read the same, word for word, in llms.txt, start.md, the README and the static page", () => {
    const page = htmlText(summary);
    for (const q of QUESTIONS) {
      for (const [name, text] of [["llms.txt", llms], ["start.md", start], ["README.md", readme], ["index.html", page]] as const) {
        expect(text, `${name}: ${q.id} question`).toContain(q.question);
        expect(text, `${name}: ${q.id} answer`).toContain(q.answer);
      }
      expect(llms, q.id).toContain(`[${q.link.label}](${q.link.href})`);
      expect(start, q.id).toContain(q.link.href);
    }
  });

  it("give the commands that check them: the stock-git clone, notes and verifier, and the public MCP", () => {
    for (const [name, text] of [["start.md", start], ["README.md", readme], ["index.html", htmlText(summary)]] as const) {
      expect(text, name).toContain(VERIFY_COMMANDS);
      expect(text, name).toContain(PUBLIC_MCP_COMMAND);
    }
    // byo-demo's newest note is sealed; hono's newest predate sealing, so the check runs on byo-demo.
    expect(VERIFY_COMMANDS).toContain(`git clone ${SITE}/git/byo-demo.git`);
    expect(VERIFY_COMMANDS).toContain("git fetch origin refs/notes/firetrident:refs/notes/firetrident");
    expect(VERIFY_COMMANDS).toMatch(/verify_note\.mjs HEAD/);
  });
});

describe("llms.txt and start.md", () => {
  it("are plain ASCII, so they read the same whatever charset a server names", () => {
    for (const text of [llms, start]) expect(text.match(/[^\x09\x0a\x0d\x20-\x7e]/g)).toBeNull();
  });

  it("llms.txt has a title, a summary and a section per question, in order", () => {
    expect(llms.startsWith("# FireTrident\n\n> ")).toBe(true);
    const sections = [...llms.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(sections).toEqual([...QUESTIONS.map((q) => q.question), "Optional"]);
  });

  it("say how to ask a showcase colony with no token and how to join one with a token", () => {
    for (const text of [llms, start]) {
      expect(text).toContain(`${SITE}/public/mcp`);
      expect(text).toContain("docs/agents/README.md");
      expect(text).toContain("Authorization: Bearer");
    }
    expect(start).toContain('"method":"tools/call"');
  });
});

describe("the static page", () => {
  it("sits inside #root, so React replaces it on load, and shows only after a moment", () => {
    expect(summary).toContain('<main class="ft-static">');
    expect(indexHtml).toMatch(/\.ft-static \{[^}]*animation: ft-static-reveal 0s 1\.5s both;/);
  });

  it("has the pitch, what a colony is, and the production runs, with numbers the README's results hold", () => {
    const text = htmlText(summary);
    expect(text).toContain("A colony, not a queue. Git coordination for coding agents that share one repository, built on Cloudflare Workers, Durable Objects and Artifacts.");
    expect(text).toContain("A colony is one codebase");
    const runs = htmlText(/<section id="runs">([\s\S]*?)<\/section>/.exec(summary)?.[1] ?? "");
    expect(runs).toContain("958 violations to 0 in 62 s");
    const unknown = numbers(runs).filter((n) => !results.includes(n));
    expect(unknown).toEqual([]);
  });

  it("points agents at start.md", () => {
    expect(indexHtml).toContain('<link rel="alternate" type="text/markdown" href="/start.md"');
    expect(summary).toContain('<a href="/start.md">');
    expect(summary).toContain('<a href="/llms.txt">');
  });
});

describe("the landing section", () => {
  const html = renderToStaticMarkup(createElement(Questions));

  it("shows each question with its number and its link, after the results", () => {
    for (const q of QUESTIONS) {
      expect(html).toContain(`id="q-${q.id}"`);
      expect(html).toContain(q.question);
      expect(html).toContain(`<div class="qa-fig">${q.figure}</div>`);
      expect(html).toContain(q.answer.replaceAll("'", "&#x27;"));
    }
    const landing = read("../src/landing/Landing.tsx");
    expect(landing.indexOf("<Questions />")).toBeGreaterThan(landing.indexOf("<Results />"));
  });

  it("keeps the site's own pages on the deployment serving it, and opens the rest in a new tab", () => {
    expect(html).toContain('href="/c/hono?replay=1"');
    expect(html).toContain('href="/c/hono?path=src/index.ts"');
    expect(html).not.toContain(`href="${SITE}/c/`);
    expect(html).toContain('href="https://github.com/roboruby/fire_trident/tree/main/packages/bench/results/2026-10-13-round2" target="_blank" rel="noreferrer"');
  });

  it("gives the two commands as code to copy", () => {
    expect(html.match(/class="code"/g)).toHaveLength(2);
    expect(html).toContain("git fetch origin refs/notes/firetrident:refs/notes/firetrident");
    expect(html).toContain("claude mcp add --transport http firetrident-public https://firetrident.com/public/mcp");
  });
});
