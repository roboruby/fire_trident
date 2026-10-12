// A read-only static server for the recorder: video/ (cards, terminal, transcripts) at /,
// and the benchmark result pages at /bench/. Bound to 127.0.0.1 on a random port.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

/** Start the server; mounts maps a URL prefix ("/", "/bench/") to a directory. */
export async function serve(mounts) {
  const roots = Object.entries(mounts)
    .map(([prefix, dir]) => [prefix, resolve(dir)])
    .sort((a, b) => b[0].length - a[0].length);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const mount = roots.find(([prefix]) => path.startsWith(prefix));
    if (!mount) return void res.writeHead(404).end();
    const [prefix, dir] = mount;
    let file = normalize(join(dir, path.slice(prefix.length)));
    if (file !== dir && !file.startsWith(dir + sep)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
