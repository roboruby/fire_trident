import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The server side of MCP Apps, the MCP extension that lets a tool's result render as an interactive view inside the
 * host (io.modelcontextprotocol/ui, specification version 2026-01-26). Written by hand from the
 * specification: a tool names a `ui://` resource in `_meta.ui.resourceUri`, the server registers that resource with
 * the MIME type `text/html;profile=mcp-app`, and its `_meta.ui` declares the Content Security Policy the host builds
 * around the view. A host without the extension ignores `_meta` and reads the tool's text.
 */

/** The MIME type of an HTML view resource. */
export const UI_MIME_TYPE = "text/html;profile=mcp-app";
/** The specification version followed here; the view sends it in `ui/initialize`. */
export const UI_PROTOCOL_VERSION = "2026-01-26";

/** Who may call a tool: the host's model, the view (from this server only), or both (the default when absent). */
export type UiVisibility = "model" | "app";

/** The origins a view may reach; an empty or absent list allows none (the specification's secure default). */
export interface UiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/** A view resource's `_meta.ui`: its Content Security Policy and whether it asks the host for a border. */
export interface UiResourceMeta {
  csp?: UiCsp;
  prefersBorder?: boolean;
}

/** A tool's `_meta.ui`: the view that renders its results, and who may call it. */
export interface UiToolMeta {
  resourceUri?: string;
  visibility?: UiVisibility[];
}

/** No network origin of any kind: no fetches, no external scripts, styles, fonts or images, no frames. */
export const NO_NETWORK_CSP: Readonly<Required<UiCsp>> = Object.freeze({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });

/** Whether a URI is a view resource's (the `ui://` scheme). */
export function isUiUri(uri: string): boolean {
  return /^ui:\/\/[^\s]+$/.test(uri);
}

/** The flat key older hosts read a tool's view from (deprecated by the specification; still set beside `ui.resourceUri`). */
export const LEGACY_RESOURCE_URI_KEY = "ui/resourceUri";

/**
 * A tool's `_meta` naming its view (and, when given, who may call it). With a view it also carries the deprecated flat
 * `ui/resourceUri` key, as the extension's own server helper does, so a host that reads only that key finds the view.
 */
export function toolUi(meta: UiToolMeta): { ui: UiToolMeta; [LEGACY_RESOURCE_URI_KEY]?: string } {
  if (meta.resourceUri !== undefined && !isUiUri(meta.resourceUri)) throw new Error(`a view resource URI must use the ui:// scheme: ${meta.resourceUri}`);
  const ui: UiToolMeta = { ...(meta.resourceUri !== undefined ? { resourceUri: meta.resourceUri } : {}), ...(meta.visibility ? { visibility: [...meta.visibility] } : {}) };
  return meta.resourceUri !== undefined ? { ui, [LEGACY_RESOURCE_URI_KEY]: meta.resourceUri } : { ui };
}

/** One view resource: its `ui://` URI, its name and description, its whole HTML document and its `_meta.ui`. */
export interface UiResource {
  uri: string;
  name: string;
  title?: string;
  description: string;
  html: string;
  meta: UiResourceMeta;
}

/**
 * Register a view resource on `server`: listed (resources/list) and read (resources/read) with the view MIME type and
 * its `_meta.ui` on both the listing and the content, so a host can review the policy before it fetches the HTML.
 */
export function registerUiResource(server: McpServer, r: UiResource): void {
  if (!isUiUri(r.uri)) throw new Error(`a view resource URI must use the ui:// scheme: ${r.uri}`);
  const meta = { ui: r.meta };
  server.registerResource(r.name, r.uri, { mimeType: UI_MIME_TYPE, description: r.description, ...(r.title ? { title: r.title } : {}), _meta: meta }, async () => ({
    contents: [{ uri: r.uri, mimeType: UI_MIME_TYPE, text: r.html, _meta: meta }],
  }));
}
