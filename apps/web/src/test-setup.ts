import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals, so Testing Library cannot register its own auto-cleanup.
afterEach(() => cleanup());

// jsdom has no ResizeObserver, which Recharts' ResponsiveContainer needs.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
