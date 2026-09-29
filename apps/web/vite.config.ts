import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [react()],
  // API_PORT points the dev proxy at an API on another port (e.g. a second local stack for e2e).
  server: { port: 5173, proxy: { "/api": `http://localhost:${process.env.API_PORT ?? "3000"}` } },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], include: ["src/**/*.test.{ts,tsx}"] },
});
