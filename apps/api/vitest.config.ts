import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  // Files run in parallel, each on its own copy of the migrated template database (test/global-setup.ts).
  test: {
    testTimeout: 30_000, hookTimeout: 90_000, globalSetup: ["test/global-setup.ts"],
    poolOptions: { forks: { maxForks: Number(process.env.TEST_MAX_FORKS ?? 4) } },
  },
});
