import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Loading } from "./Loading";
import { QueryError } from "./QueryError";
import { Pager, type CursorPager } from "./Pager";

describe("Loading", () => {
  it("is a polite status with the label as its text", () => {
    render(<Loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });
});

describe("QueryError", () => {
  it("announces the message and disables Retry while the refetch runs", async () => {
    let done!: () => void;
    const query = { refetch: () => new Promise<void>((r) => { done = r; }) };
    render(<QueryError query={query} message="Couldn't load candidates." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load candidates.");
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    done();
    await waitFor(() => expect(retry).toBeEnabled());
  });
});

describe("Pager", () => {
  it("keeps Previous / Page n / Next and disables the ends", () => {
    const pager: CursorPager = { page: 0, cursor: null, reset: () => {}, prev: () => {}, next: () => {} };
    render(<Pager pager={pager} label="Candidates pages" nextCursor={null} />);
    expect(screen.getByRole("navigation", { name: "Candidates pages" })).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});
