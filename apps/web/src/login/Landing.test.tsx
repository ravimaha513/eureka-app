import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe("landing page", () => {
  beforeEach(() => {
    localStorage.removeItem("eureka-landing-seen");
    window.history.replaceState(null, "", "/");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === "/api/v1/me" ? new Response(JSON.stringify({ status: 401 }), { status: 401 })
        : new Response(JSON.stringify({ google: true, password: true }), { status: 200 }));
  });
  afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem("eureka-landing-seen"); window.history.replaceState(null, "", "/"); });

  it("greets a first-time visitor at / and Sign in goes to the sign-in form", async () => {
    wrap(<App />);
    expect(await screen.findByRole("heading", { name: /The bench, the pipeline/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Sign in to Eureka" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });

  it("Get started leads to sign-in, and a returning visitor skips the landing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = wrap(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    vi.advanceTimersByTime(2000);
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    vi.useRealTimers();
    unmount();
    window.history.replaceState(null, "", "/");
    wrap(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in to Eureka" })).toBeInTheDocument();
  });

  it("a sign-in error at / goes straight to the form", async () => {
    window.history.replaceState(null, "", "/?error=expired");
    wrap(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in to Eureka" })).toBeInTheDocument();
  });
});
