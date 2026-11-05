import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Menu } from "./Menu";

function setup() {
  render(
    <div>
      <input aria-label="Search" />
      <div data-testid="pane"><Menu label="More" items={[{ label: "Edit", onSelect: () => {} }]} /></div>
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
}

describe("Menu", () => {
  it("stays open when an unrelated input scrolls its own text", () => {
    setup();
    fireEvent.scroll(screen.getByRole("textbox", { name: "Search" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
  });

  it("closes when a scroll moves its button, or the window resizes", () => {
    setup();
    fireEvent.scroll(screen.getByTestId("pane"));
    expect(screen.queryByRole("menuitem")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
