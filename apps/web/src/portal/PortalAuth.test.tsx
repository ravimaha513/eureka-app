import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, problem, wrap } from "../pipeline/testkit";
import { PortalApp } from "./PortalApp";

const ME = { id: "a1", firstName: "Rakesh", lastName: "Uvsn", email: "rakesh@example.com", phone: "+14695550101", emailVerified: true, csrfToken: "ptok" };
const SENT = "If the address can receive email, we sent a sign-in link to it. It works once and expires in 15 minutes.";

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/portal/me": () => problem(401),
    "POST /api/portal/auth/sign-up": () => ({ status: 202, body: { message: SENT } }),
    "POST /api/portal/auth/request-link": () => ({ status: 202, body: { message: SENT } }),
    "GET /api/portal/jobs": () => ({ body: { items: [], nextCursor: null } }),
    "GET /api/portal/applications": () => ({ body: { items: [] } }),
  });
});
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("portal sign-up and sign-in", () => {
  it("validates, then signs up with the portal header and shows the generic answer", async () => {
    window.history.replaceState(null, "", "/portal/sign-up");
    wrap(<PortalApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign up" }));
    expect(await screen.findByText("Enter your first name.")).toBeInTheDocument();
    expect(screen.getByText(/Include the country code|international format/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Rakesh" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Uvsn" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+1 469 555 0101" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "rakesh@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    expect(await screen.findByRole("status")).toHaveTextContent(SENT);
    const w = api.writes()[0]!;
    expect(w.path).toBe("/api/portal/auth/sign-up");
    expect(w.headers["x-eureka-portal"]).toBe("1");
    expect(w.body).toEqual({ firstName: "Rakesh", lastName: "Uvsn", email: "rakesh@example.com", phone: "+1 469 555 0101" });
  });

  it("asks for a sign-in link by email", async () => {
    window.history.replaceState(null, "", "/portal/sign-in");
    wrap(<PortalApp />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "rakesh@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(SENT);
    expect(api.writes()[0]!.body).toEqual({ email: "rakesh@example.com" });
  });

  it("verify: takes the token from the fragment, clears it from the address bar and posts it only on Continue", async () => {
    let verified = false;
    api.routes["POST /api/portal/auth/verify"] = () => { verified = true; return { status: 204 }; };
    api.routes["GET /api/portal/me"] = () => (verified ? { body: ME } : problem(401));
    window.history.replaceState(null, "", "/portal/verify#token=abc.def");
    wrap(<PortalApp />);
    const btn = await screen.findByRole("button", { name: "Continue" });
    expect(window.location.hash).toBe("");
    expect(api.writes()).toHaveLength(0);
    fireEvent.click(btn);
    await waitFor(() => expect(api.writes()[0]!.body).toEqual({ token: "abc.def" }));
    expect(await screen.findByRole("navigation", { name: "Portal" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/portal/jobs");
  });

  it("explains a used or expired link", async () => {
    api.routes["POST /api/portal/auth/verify"] = () => problem(400, { detail: "link_invalid" });
    window.history.replaceState(null, "", "/portal/verify#token=abc.def");
    wrap(<PortalApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or was already used/);
  });

  it("signed in: portal shell with the applicant's CSRF token on writes; sign out", async () => {
    api.routes["GET /api/portal/me"] = () => ({ body: ME });
    api.routes["POST /api/portal/auth/sign-out"] = () => ({ status: 204 });
    window.history.replaceState(null, "", "/portal/jobs");
    wrap(<PortalApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Rakesh Uvsn" }));
    await waitFor(() => expect(api.writes()[0]!.headers["x-csrf-token"]).toBe("ptok"));
  });
});
