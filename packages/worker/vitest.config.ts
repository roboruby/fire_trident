import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const durableObjects = {
  COLONY: { className: "ColonyDO", useSQLite: true },
  REGION: { className: "RegionDO", useSQLite: true },
  TRUNK: { className: "TrunkDO", useSQLite: true },
  POOL: { className: "PoolDO", useSQLite: true },
};

/**
 * Three projects:
 * - unit:    pure helpers in Node (fast, no runtime).
 * - do:      Durable Object integration tests inside workerd. The harness worker
 *            (test/do/harness.ts) exports the real ColonyDO and RegionDO plus
 *            in-memory stand-ins for TrunkDO and PoolDO, so coordination can be
 *            tested without Artifacts.
 * - certify: the same harness with trunk certification on (FT_TRUNK_TESTS) and a
 *            Worker Loader, so tests run in real Dynamic Workers (test/do/certify).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/do/**"],
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
    ],
  },
});
