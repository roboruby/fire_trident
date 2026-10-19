import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const durableObjects = {
  COLONY: { className: "ColonyDO", useSQLite: true },
  REGION: { className: "RegionDO", useSQLite: true },
  TRUNK: { className: "TrunkDO", useSQLite: true },
  POOL: { className: "PoolDO", useSQLite: true },
};

/**
 * The accounts end-to-end tests run the Worker itself (src/index.ts, through test/e2e/worker.ts) with every Durable
 * Object class it exports and accounts on. Their GitHub, Cloudflare and Artifacts are fakes behind the global fetch
 * (test/e2e/fakes.ts); the values below are test fixtures, not secrets.
 */
const e2eObjects = {
  ...durableObjects,
  AGENT: { className: "AgentDO", useSQLite: true },
  MCP: { className: "FireTridentMcp", useSQLite: true },
  ACCOUNTS: { className: "AccountsDO", useSQLite: true },
  CF_GRANTS: { className: "CloudflareGrantDO", useSQLite: true },
};
/**
 * The deployment's own Workers AI in the e2e tests: an auxiliary worker that answers every run and counts the calls
 * (RPC `calls()`), so a test can show that a person's colony never runs a model on the deployment's account.
 */
const deploymentAi = `import { WorkerEntrypoint } from "cloudflare:workers";
const calls = [];
export default class extends WorkerEntrypoint {
  async run(model) {
    calls.push(model);
    return { response: "the deployment's Workers AI answered", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }
  async calls() {
    return calls.slice();
  }
}`;
const e2eBindings = {
  FT_ACCOUNTS: "on",
  FT_PUBLIC_URL: "https://ft.test",
  FT_ADMIN_TOKEN: "test-admin",
  FT_MCP_TOKEN: "test-mcp",
  FT_DEFAULT_MODEL: "@cf/test/author-model",
  FT_INLINE: "on",
  FT_GITHUB_CLIENT_ID: "test-client-id",
  FT_GITHUB_CLIENT_SECRET: "test-client-secret",
  FT_SESSION_KEY: "test-session-key-test-session-key-0123",
  FT_CF_CLIENT_ID: "ft-test-client",
  FT_CF_CLIENT_SECRET: "test-client-secret-value",
  FT_GRANT_KEY: "test-grant-key-material-0123456789abcdef",
};

/**
 * Four projects:
 * - unit:    pure helpers in Node (fast, no runtime).
 * - do:      Durable Object integration tests inside workerd. The harness worker
 *            (test/do/harness.ts) exports the real ColonyDO and RegionDO plus
 *            in-memory stand-ins for TrunkDO and PoolDO, so coordination can be
 *            tested without Artifacts.
 * - certify: the same harness with trunk certification on (FT_TRUNK_TESTS) and a
 *            Worker Loader, so tests run in real Dynamic Workers (test/do/certify).
 * - e2e:     the Worker itself with accounts on (FT_ACCOUNTS), every Durable Object
 *            real, and fakes for GitHub, Cloudflare and Artifacts (test/e2e).
 */
export default defineConfig({
  test: {
    // burst.test.ts's hundreds of concurrent takes can leave a module load in flight when its file's environment
    // closes, and the pool then reports `Closing rpc while "resolve" was pending` after every test in it passed (a
    // harness race that shows only under load). Only that error from that file is ignored: its tests still run and
    // must pass, with one retry.
    onUnhandledError(error) {
      const e = error as { name?: string; VITEST_TEST_PATH?: string };
      if (e.name === "EnvironmentTeardownError" && e.VITEST_TEST_PATH?.endsWith("test/do/burst.test.ts")) return false;
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/do/**", "test/e2e/**"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./test/do/harness.ts",
            miniflare: {
              compatibilityDate: "2026-08-01",
              compatibilityFlags: ["nodejs_compat"],
              bindings: { FT_ADMIN_TOKEN: "test-admin", FT_DEFAULT_MODEL: "test-model" },
              durableObjects,
            },
          }),
        ],
        test: {
          name: "do",
          include: ["test/do/**/*.test.ts"],
          exclude: ["test/do/certify/**"],
          testTimeout: 30_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./test/do/harness.ts",
            miniflare: {
              compatibilityDate: "2026-08-01",
              compatibilityFlags: ["nodejs_compat"],
              bindings: { FT_ADMIN_TOKEN: "test-admin", FT_DEFAULT_MODEL: "test-model", FT_TRUNK_TESTS: "on" },
              workerLoaders: { LOADER: {} },
              durableObjects,
            },
          }),
        ],
        test: {
          name: "certify",
          include: ["test/do/certify/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./test/e2e/worker.ts",
            miniflare: {
              compatibilityDate: "2026-08-01",
              compatibilityFlags: ["nodejs_compat"],
              bindings: e2eBindings,
              durableObjects: e2eObjects,
              serviceBindings: { AI: "deployment-ai" },
              workers: [{ name: "deployment-ai", modules: true, compatibilityDate: "2026-08-01", script: deploymentAi }],
            },
          }),
        ],
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
