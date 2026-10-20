# Platform runner for the contention-scale scenario

A throwaway Cloudflare Worker (`ft-bench-runner`) with one Cloudflare Container that runs
`packages/bench/src/scenarios/contention-scale.ts` from inside Cloudflare's network, so the client's thousands of
connections to the deployment do not cross a laptop's uplink (the 2026-10-19 laptop run lost its connections at about
1,000 concurrent agents). Nothing here is part of the product; deploy it for a run and delete it after.

## Parts

- `Dockerfile` — node 24 (type-stripping runs the TypeScript as is), stock git, the monorepo's `core` and `bench`
  packages and esbuild (the check's parser) at the lockfile's version. `prepare.rb` assembles that context under
  `build/` (gitignored) from the current checkout and records the source commit in `build/SOURCE`.
- `container/server.mjs` — the HTTP server inside the container: `POST /start` runs the scenario as a child process
  with `--out /data/results/<tag>`, `GET /log` tails its output, `GET /status`, `GET /ls` and `GET /file` read the
  results back, `GET /trace` reports the container's colo, `GET /about` asks the deployment for its build.
- `src/worker.ts` — the Worker: a bearer key (`RUNNER_KEY`) on every request, then the one container instance.
  `wrangler.jsonc` gives the container `standard-3` (2 vCPU, 8 GiB) and a 4 h idle timeout.
- `drive.rb` — `start`, `watch`, `fetch`, `get`, `stop` against the deployed Worker, reading `.runner-url` and
  `.runner-key` (gitignored; the key is a random string you make).

## Run

```
ruby prepare.rb
npm install
<wrangler> deploy
echo https://ft-bench-runner.<subdomain>.workers.dev > .runner-url
openssl rand -hex 24 > .runner-key
# FT_TOKEN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET from the staging env file, RUNNER_KEY from .runner-key:
<env with the staging secrets> ruby -rjson -e '...' | <wrangler> secret bulk
ruby drive.rb get /health && ruby drive.rb get /trace
ruby drive.rb start 1000 3000 platform && ruby drive.rb watch platform
ruby drive.rb fetch platform ../results/<date>-contention-scale-platform
```

Runs started with the same tag share `--out`, so the scenario rebuilds one README covering every run in it. Secrets
go in as Worker secrets and reach the scenario only as the container's environment; the scenario redacts them from
what it writes. When done: `<wrangler> delete`, then `wrangler containers list` / `containers delete <app id>` and
`containers images list` / `containers images delete`, and confirm both lists are empty of `ft-bench-runner`.
