import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangePassword, Login } from "./App";

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("password sign-in screen", () => {
  it("shows the email and password form when the server offers it, and posts the credentials", async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined });
      return url.endsWith("/api/auth/methods") ? json({ password: true, google: true, dev: false }) : json({ mustChangePassword: false });
    });
    const done = vi.fn();
    wrap(<Login onSignedIn={done} devMode={false} />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "r1a@eureka.example" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Secret-pass-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    const login = calls.find((c) => c.url.endsWith("/api/auth/password-login"))!;
    expect(JSON.parse(login.body!)).toEqual({ email: "r1a@eureka.example", password: "Secret-pass-1" });
  });

  it("says so when the password is wrong", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/api/auth/methods") ? json({ password: true, google: false, dev: false }) : json({ status: 401, title: "Unauthorized" }, 401));
    wrap(<Login onSignedIn={() => undefined} devMode={false} />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "bad-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password.");
  });

  it("does not offer a password form when the server does not", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ password: false, google: true, dev: false }));
    wrap(<Login onSignedIn={() => undefined} devMode={false} />);
    expect(await screen.findByText("Sign in with Google")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
});

describe("change a temporary password", () => {
  it("refuses mismatching passwords without calling the server", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    wrap(<ChangePassword onDone={() => undefined} onSignOut={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "Temp-pass-123" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Brand-new-pass-1" } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: "different-pass-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(f).not.toHaveBeenCalled();
  });

  it("posts the change and continues", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const done = vi.fn();
    wrap(<ChangePassword onDone={done} onSignOut={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "Temp-pass-123" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Brand-new-pass-1" } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: "Brand-new-pass-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
  });
});
