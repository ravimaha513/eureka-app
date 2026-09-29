import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: { testTimeout: 30_000, hookTimeout: 90_000, fileParallelism: false },
});
