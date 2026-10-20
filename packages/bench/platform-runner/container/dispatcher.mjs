// Preloaded with `node --import` when a run asks for a capped connection pool (server.mjs: conn=<n>). The process's
// global fetch then shares at most FT_BENCH_CONNECTIONS keep-alive connections per origin instead of opening one
// socket per in-flight call (1,000 agents at once meant 1,000 TCP+TLS connects and 1,000 DNS lookups through libuv's
// four threads, and undici's 10 s connect timeout tripped: see results/2026-10-20-contention-scale-platform). DNS
// answers are cached for two minutes and the connect timeout is 30 s. The scenario's code is unchanged; this only
// changes how its HTTP client reuses connections, the way an agent runtime with keep-alive would.
import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

const connections = Math.max(1, Number(process.env.FT_BENCH_CONNECTIONS ?? 256) || 256);
const TTL_MS = 120_000;
const cache = new Map();

function lookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const key = JSON.stringify([hostname, options?.family ?? 0, !!options?.all, options?.hints ?? 0]);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    queueMicrotask(() => callback(null, ...hit.args));
    return;
  }
  dns.lookup(hostname, options, (err, ...args) => {
    if (!err) cache.set(key, { args, expires: Date.now() + TTL_MS });
    callback(err, ...args);
  });
}

setGlobalDispatcher(
  new Agent({
    connections,
    pipelining: 1,
    connectTimeout: 30_000,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connect: { timeout: 30_000, lookup },
  }),
);
console.error(`[dispatcher] global fetch shares at most ${connections} keep-alive connections per origin (connect timeout 30 s, DNS cached ${TTL_MS / 1000} s)`);
