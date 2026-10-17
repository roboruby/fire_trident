import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS, connectInfo, connectLlmsItems, connectMarkdown, publicAddCommand, tokenAddCommand } from "@fire_trident/core";
import { ConnectPage } from "../src/connect/Connect.tsx";
import { ConnectLinks } from "../src/connect/ConnectLinks.tsx";
import { RunIt } from "../src/landing/RunIt.tsx";
import { SITE } from "../src/landing/questions.ts";
import { parseRoute } from "../src/route.ts";

/**
 * Connect your agent, on the web: the /connect page (and ?colony=<id>), the landing page's column and the colony page's
 * links, all from core/connect.ts, the read-only server first; and the blocks of public/start.md and public/llms.txt,
 * word for word what scripts/connect_docs.ts writes from the same source.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Text as React writes it into HTML. */
const html = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

const HOST = "https://ft.example";

describe("the /connect route", () => {
  it("is its own page, for one colony with ?colony=", () => {
    expect(parseRoute("/connect", "")).toEqual({ kind: "connect", colonyId: null });
    expect(parseRoute("/connect/", "?colony=hono")).toEqual({ kind: "connect", colonyId: "hono" });
    expect(parseRoute("/connect", "?colony=%20")).toEqual({ kind: "connect", colonyId: null });
    expect(parseRoute("/connectx", "")).toEqual({ kind: "landing" });
    expect(parseRoute("/c/connect", "")).toMatchObject({ kind: "colony", colonyId: "connect" });
  });
});

describe("the /connect page", () => {
  const out = renderToStaticMarkup(createElement(ConnectPage, { site: HOST, colony: "hono" }));
  const info = connectInfo(HOST, "hono");

  it("renders every client as a tab with its panel, the first shown and the rest hidden", () => {
    for (const c of info.clients) {
      expect(out).toContain(`id="cx-tab-${c.id}"`);
      expect(out).toContain(`id="cx-panel-${c.id}"`);
    }
    expect(out.match(/role="tabpanel"/g)).toHaveLength(info.clients.length);
    expect(out.match(/role="tabpanel"[^>]* hidden=""/g)).toHaveLength(info.clients.length - 1);
    expect(out).toMatch(/id="cx-panel-claude-code" aria-labelledby="cx-tab-claude-code">/);
  });

  it("gives every snippet of every client to copy, the read-only server first", () => {
    for (const c of info.clients) {
      for (const s of c.variants.flatMap((v) => v.snippets)) for (const line of s.text.split("\n")) expect(out, `${c.id}: ${line}`).toContain(html(line));
      const panel = out.slice(out.indexOf(`id="cx-panel-${c.id}"`));
      expect(panel.indexOf("Read only, no token")).toBeLessThan(panel.indexOf("Join and propose, with the MCP token"));
    }
    expect(out.indexOf(html(publicAddCommand(info)))).toBeLessThan(out.indexOf(html(tokenAddCommand(info))));
  });

  it("makes the one-click links buttons for Cursor and VS Code", () => {
    for (const c of info.clients) {
      for (const s of c.variants.flatMap((v) => v.snippets).filter((x) => x.kind === "link")) expect(out).toContain(`<a class="l-btn cx-install" href="${html(s.text)}">Add to ${c.name}</a>`);
    }
    expect(out.match(/class="l-btn cx-install"/g)).toHaveLength(3);
  });

  it("says what each server is, where the token lives, and that MCP files committed to a colony go to a person", () => {
    for (const n of info.notes) expect(out).toContain(html(n));
    expect(out).toContain(html("Committing a client's MCP configuration (.mcp.json, .cursor/ or .vscode/) to a colony's trunk goes to a person"));
    for (const t of MCP_TOOLS) expect(out).toContain(`<code>${t}</code>`);
  });

  it("names the colony: what to ask it, its page and its SKILL.md", () => {
    expect(out).toContain("Bring an agent to hono.");
    expect(out).toContain(html(info.prompts.public));
    expect(out).toContain(html(info.prompts.token));
    expect(out).toContain(`href="${HOST}/api/colonies/hono/skill" download="SKILL.md"`);
    expect(out).toContain('href="/c/hono"');
  });

  it("leaves a value that is not a colony id out of every command, and says so", () => {
    const bad = renderToStaticMarkup(createElement(ConnectPage, { site: HOST, colony: "x' && rm -rf ~" }));
    expect(bad).toContain("is not a colony id");
    expect(bad).not.toContain("rm -rf ~&quot;");
    expect(bad).not.toContain("download=");
    expect(bad).toContain(html('"<colony>"'));
    const none = renderToStaticMarkup(createElement(ConnectPage, { site: HOST, colony: null }));
    expect(none).toContain("Bring an agent to a colony.");
    expect(none).not.toContain("is not a colony id");
  });
});

describe("the landing page's column and the colony page's links", () => {
  it("connect from the same source, the read-only server first, with every tool and no placeholder token", () => {
    const out = renderToStaticMarkup(createElement(RunIt));
    const info = connectInfo(SITE);
    expect(out).toContain("Connect your agent");
    expect(out.indexOf(html(publicAddCommand(info)))).toBeGreaterThan(0);
    expect(out.indexOf(html(publicAddCommand(info)))).toBeLessThan(out.indexOf(html(tokenAddCommand(info))));
    expect(out).toContain('href="/connect"');
    expect(out).not.toContain("Bearer &lt;your-token&gt;");
    for (const t of MCP_TOOLS) expect(out).toContain(`<code>${t}</code>`);
    expect(read("../src/landing/Landing.tsx")).toContain('<a href="/connect">Connect</a>');
  });

  it("put the colony's connect page and SKILL.md under its name", () => {
    const out = renderToStaticMarkup(createElement(ConnectLinks, { colonyId: "hono" }));
    expect(out).toContain('href="/connect?colony=hono"');
    expect(out).toContain('href="/api/colonies/hono/skill" download="SKILL.md"');
    expect(read("../src/components/TopBar.tsx")).toContain("<ConnectLinks colonyId={store.colonyId} />");
  });
});

describe("start.md and llms.txt", () => {
  const info = connectInfo(SITE);

  it("start.md's connect block is what core writes, word for word (scripts/connect_docs.ts rewrites it)", () => {
    const start = read("../public/start.md");
    const begin = "<!-- connect:begin -->";
    const end = "<!-- connect:end -->";
    expect(start).toContain(begin);
    const block = start.slice(start.indexOf(begin) + begin.length, start.indexOf(end));
    expect(block, "run node --experimental-transform-types scripts/connect_docs.ts").toBe(`\n\n${connectMarkdown(info)}\n\n`);
    // Inside "Can my agent join?", after the token section.
    expect(start.indexOf(begin)).toBeGreaterThan(start.indexOf("### Join a colony, with a token"));
    expect(start.indexOf(begin)).toBeLessThan(start.indexOf("## More"));
  });

  it("llms.txt carries core's connect items in its join section, word for word", () => {
    const llms = read("../public/llms.txt");
    const section = llms.slice(llms.indexOf("## Can my agent join?"), llms.indexOf("## Optional"));
    for (const item of connectLlmsItems(info)) expect(section.split("\n"), "run node --experimental-transform-types scripts/connect_docs.ts").toContain(item);
  });
});
