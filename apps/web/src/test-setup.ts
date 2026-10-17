import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals, so Testing Library cannot register its own auto-cleanup.
afterEach(() => cleanup());

// jsdom keeps the URL between tests in a file; the shell routes from it, so each test starts at "/".
afterEach(() => window.history.replaceState(null, "", "/"));

// jsdom has no ResizeObserver, which Recharts' ResponsiveContainer needs.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
