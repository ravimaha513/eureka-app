import { availableParallelism } from "node:os";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// One file per core (more just contends for the CPU that Postgres also needs). minForks must not
// exceed maxForks (vitest's default is cores - 1; a conflict runs no tests at all and still exits 0).
const forks = Number(process.env.TEST_MAX_FORKS ?? availableParallelism());

export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  // Files run in parallel, each on its own copy of the migrated template database (test/global-setup.ts).
  test: {
    testTimeout: 30_000, hookTimeout: 90_000, globalSetup: ["test/global-setup.ts"],
    poolOptions: { forks: { maxForks: forks, minForks: Math.min(forks, 1) } },
  },
});
