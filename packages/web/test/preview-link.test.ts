import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewLine, previewHref } from "../src/components/PreviewLine.tsx";

/** An agent's preview on the Why tab: a link only for an https address; anything else stored before the API refused it is plain text. */

const draw = (url: string | undefined): string => renderToStaticMarkup(createElement(PreviewLine, { url }));

describe("an agent's preview link", () => {
  it("links an https address, opened apart from the app", () => {
    const html = draw("https://preview.example.com/pr/12");
    expect(html).toContain('<a class="link lin-preview" href="https://preview.example.com/pr/12" target="_blank" rel="noreferrer">Preview</a>');
    expect(html).toContain("said-agent");
  });

  it("shows any other stored address as plain text, never as a link", () => {
    for (const url of ["javascript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>", "http://preview.example.com/", "JAVASCRIPT:alert(1)", " https://x.example/", "https://exa\tmple.com/", "vbscript:msgbox(1)"]) {
      const html = draw(url);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("href=");
      expect(html).toContain("Preview (not linked, not an https address): ");
    }
    // Markup in the address is text, escaped.
    expect(draw("data:text/html,<script>alert(1)</script>")).toContain("&lt;script&gt;");
    // A long one is cut to one short line.
    expect(draw(`data:text/plain,${"a".repeat(3_000)}`).length).toBeLessThan(800);
  });

  it("draws nothing without one", () => {
    expect(draw(undefined)).toBe("");
    expect(draw("")).toBe("");
  });

  it("takes https addresses with a host only", () => {
    expect(previewHref("https://a.example/x?y=1#z")).toBe("https://a.example/x?y=1#z");
    expect(previewHref("HTTPS://A.EXAMPLE/")).toBe("HTTPS://A.EXAMPLE/");
    for (const bad of ["https://", "https:x", "//a.example/", "ftp://a.example/", 42, null]) expect(previewHref(bad)).toBeNull();
  });
});
