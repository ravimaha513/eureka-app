import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicFeedback } from "./PublicFeedback";

const token = "a".repeat(43);
const invitation = { firstName: "Alex", clientName: "Example client", startsAt: "2026-09-29T15:00:00Z", expiresAt: "2026-10-01T17:00:00Z" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.restoreAllMocks());

describe("candidate feedback", () => {
  it("reads without consuming then submits structured feedback once without a staff session", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(invitation)).mockResolvedValueOnce(response({ submitted: true }));
    render(<PublicFeedback token={token} />);
    await screen.findByText(/Hi Alex/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "4" }));
    fireEvent.change(screen.getByLabelText(/Interview format/), { target: { value: "Video" } });
    fireEvent.change(screen.getByLabelText(/Duration in minutes/), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText(/Topics covered/), { target: { value: "React, SQL" } });
    fireEvent.change(screen.getByLabelText(/Questions you found/), { target: { value: "Window functions" } });
    fireEvent.change(screen.getByLabelText(/Next steps discussed/), { target: { value: "Technical round" } });
    fireEvent.change(screen.getByLabelText(/Anything you'd like/), { target: { value: "  Clear discussion  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await screen.findByText("Thank you for your feedback");
    expect(fetch).toHaveBeenCalledTimes(2);
    const init = fetch.mock.calls[1]![1]!;
    expect(init).toMatchObject({ method: "POST", credentials: "omit", headers: { "content-type": "application/json" } });
    expect(JSON.parse(init.body as string)).toEqual({ rating: 4, notes: "Clear discussion", format: "Video", topics: ["React", "SQL"], difficultQuestions: "Window functions", durationMin: 45, nextStep: "Technical round" });
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument();
  });

  it.each([404, 410])("does not offer a form for a used or expired link (%s)", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}, status));
    render(<PublicFeedback token={token} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument();
  });

  it("rejects malformed tokens without requesting the API", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<PublicFeedback token="bad" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves answers on throttling and lets the candidate retry", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(invitation))
      .mockResolvedValueOnce(response({}, 429)).mockResolvedValueOnce(response({ submitted: true }));
    render(<PublicFeedback token={token} />);
    await screen.findByText(/Hi Alex/);
    fireEvent.click(screen.getByRole("radio", { name: "3" }));
    fireEvent.change(screen.getByLabelText(/Anything you'd like/), { target: { value: "My feedback" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("wait a minute");
    expect(screen.getByLabelText(/Anything you'd like/)).toHaveValue("My feedback");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send feedback" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await screen.findByText("Thank you for your feedback");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("offers a load retry after a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response(invitation));
    render(<PublicFeedback token={token} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't connect");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Hi Alex/);
  });
});
