// The throwaway Worker in front of the bench runner container: every request needs the RUNNER_KEY bearer, then goes
// to the one container instance (its HTTP server on 8080, container/server.mjs). The response carries the edge colo
// that served the Worker (x-edge-colo); the container's own colo comes from its /trace route.
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  RUNNER: DurableObjectNamespace<BenchRunner>;
  RUNNER_KEY?: string;
  FT_BASE?: string;
  FT_TOKEN?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}

export class BenchRunner extends Container<Env> {
  defaultPort = 8080;
  // A 1,000-agent run is about 45 minutes; the driver polls every half minute, which renews this anyway.
  sleepAfter = "4h";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = {
      FT_BASE: env.FT_BASE ?? "https://staging.firetrident.com",
      FT_TOKEN: env.FT_TOKEN ?? "",
      CF_ACCESS_CLIENT_ID: env.CF_ACCESS_CLIENT_ID ?? "",
      CF_ACCESS_CLIENT_SECRET: env.CF_ACCESS_CLIENT_SECRET ?? "",
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("authorization") ?? "";
    if (!env.RUNNER_KEY || auth !== `Bearer ${env.RUNNER_KEY}`) return new Response("unauthorized\n", { status: 401 });
    const cf = (request as Request & { cf?: { colo?: string; country?: string } }).cf;
    const colo = cf?.colo ?? "?";
    const url = new URL(request.url);
    if (url.pathname === "/_edge") return Response.json({ colo, country: cf?.country ?? null });
    // Kill the container so the next request starts a fresh one on the application's current image (a deploy's
    // rollout does not replace a running instance right away). Results on its disk are gone: fetch them first.
    if (url.pathname === "/_restart" && request.method === "POST") {
      await getContainer(env.RUNNER, "bench").destroy();
      return Response.json({ restarted: true, colo });
    }
    const res = await getContainer(env.RUNNER, "bench").fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("x-edge-colo", colo);
    return out;
  },
};
