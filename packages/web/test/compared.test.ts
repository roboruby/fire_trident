import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Compared } from "../src/landing/Compared.tsx";
import { COMPARED, LEDGER_HREF, MEASURED_TITLE, resultsHref } from "../src/landing/compared.ts";
import { REPO } from "../src/landing/questions.ts";

/**
 * The "with and without" panel of the landing page: every row complete (a mechanism, both values, where it was
 * measured and its run), every number copied from that mechanism's row of the README's ledger, and the panel drawn
 * right after the results strip.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const readme = read("../../../README.md");

/** What README.md's ledger says: the section "What each mechanism buys", up to the next section. */
const ledger = readme.slice(readme.indexOf("## What each mechanism buys"), readme.indexOf("## Watch a finished run"));

/** The ledger's table rows, without its header. */
const ledgerRows = ledger.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Mechanism") && !l.startsWith("| ---"));

/** The numbers in a text, as written ("5,000", "120.5"). */
const numbers = (s: string) => [...s.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]);

/** Text as React writes it into HTML. */
const html = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

describe("the panel's rows", () => {
  it("are six to eight, each with its own anchor", () => {
    expect(COMPARED.length).toBeGreaterThanOrEqual(6);
    expect(COMPARED.length).toBeLessThanOrEqual(8);
    expect(new Set(COMPARED.map((r) => r.id)).size).toBe(COMPARED.length);
  });

  it("each give a mechanism, what it moves, the value off and the value on, a note and a verdict", () => {
    for (const r of COMPARED) {
      for (const field of [r.mechanism, r.metric, r.off, r.on, r.note]) expect(field.trim(), r.id).not.toBe("");
      expect(r.off, r.id).not.toBe(r.on);
      expect(["earns", "trade", "costs"], r.id).toContain(r.verdict);
      if (r.flag !== null) expect(r.flag, r.id).toMatch(/^FT_[A-Z_]+$/);
    }
  });

  it("each say where they were measured and link to a results folder that is in the repository", () => {
    for (const r of COMPARED) {
      expect(["production", "preview", "simulated"], r.id).toContain(r.label);
      expect(MEASURED_TITLE[r.label], r.id).toBeTruthy();
      expect(r.folder, r.id).toMatch(/^2026-\d\d-\d\d(?:-[a-z0-9]+)?$/);
      expect(resultsHref(r.folder), r.id).toBe(`https://github.com/roboruby/fire_trident/tree/main/packages/bench/results/${r.folder}`);
      expect(existsSync(new URL(`../../bench/results/${r.folder}`, import.meta.url)), r.folder).toBe(true);
    }
  });

  it("are copied from the README's ledger: its row has the same run, label and flag, and every number of the panel's row", () => {
    expect(ledgerRows.length).toBeGreaterThanOrEqual(COMPARED.length);
    for (const r of COMPARED) {
      const rows = ledgerRows.filter((l) => l.startsWith(`| ${r.mechanism}`));
      expect(rows, r.mechanism).toHaveLength(1);
      const row = rows[0] ?? "";
      expect(row, r.id).toContain(`(packages/bench/results/${r.folder}/)`);
      expect(row, r.id).toContain(`**${r.label.toUpperCase()}**`);
      if (r.flag !== null) expect(row, r.id).toContain(`\`${r.flag}\``);
      for (const n of numbers(`${r.metric} ${r.off} ${r.on} ${r.note}`)) expect(row, `${r.id}: ${n}`).toContain(n);
    }
  });

  it("keep a row that costs more than it earns", () => {
    expect(COMPARED.filter((r) => r.verdict === "costs").map((r) => r.id)).toEqual(["async-publish"]);
  });

  it("give the queue math behind testing after landing as simulated, with the modeled queue and the cost beside it", () => {
    const q = COMPARED.find((r) => r.id === "after-landing");
    expect(q?.label).toBe("simulated");
    expect(q?.folder).toBe("2026-10-12");
    expect([q?.off, q?.on]).toEqual(["1.9", "164"]);
    expect(q?.note).toContain("a modeled merge queue re-runs a change's tests after every rebase");
    expect(q?.note).toContain("45% of agent work redone");
  });
});

describe("the panel", () => {
  const out = renderToStaticMarkup(createElement(Compared));

  it("shows each mechanism with its values without and with it, its label and its run", () => {
    for (const r of COMPARED) {
      expect(out).toContain(`id="cm-${r.id}"`);
      expect(out).toContain(`<h3 class="cm-name">${html(r.mechanism)}</h3>`);
      expect(out).toContain(`<div class="cm-val">${html(r.off)}</div>`);
      expect(out).toContain(`<div class="cm-val">${html(r.on)}</div>`);
      expect(out).toContain(html(r.note));
      expect(out).toContain(`class="cm-label cm-label-${r.label}"`);
      expect(out).toContain(`href="${resultsHref(r.folder)}" target="_blank" rel="noreferrer"`);
    }
    expect(out.match(/<article class="cm-row /g)).toHaveLength(COMPARED.length);
  });

  it("names each flag, or says the mechanism is built in", () => {
    for (const r of COMPARED) if (r.flag !== null) expect(out).toContain(`<code class="cm-flag">${r.flag}</code>`);
    expect(out).toContain('<span class="cm-flag">built in</span>');
  });

  it("links to the README's ledger, which holds every mechanism", () => {
    expect(LEDGER_HREF).toBe(`${REPO}#what-each-mechanism-buys`);
    expect(out).toContain(`href="${LEDGER_HREF}" target="_blank" rel="noreferrer"`);
    expect(ledgerRows.length).toBeGreaterThan(COMPARED.length);
  });

  it("sits right after the results strip, before the questions", () => {
    const landing = read("../src/landing/Landing.tsx");
    const results = landing.indexOf("<Results />");
    const compared = landing.indexOf("<Compared />");
    expect(results).toBeGreaterThan(0);
    expect(landing.slice(results + "<Results />".length, compared).trim()).toBe("");
    expect(landing.indexOf("<Questions />")).toBeGreaterThan(compared);
  });
});
