import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";
import { FilterBar } from "./FilterBar";
import { Menu } from "./Menu";
import { RecordLink } from "./RecordLink";
import { Tabs } from "./Tabs";

describe("Tabs", () => {
  const tabs = [{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }, { key: "c", label: "Gamma", count: 2 }] as const;

  it("uses roving tabindex and arrow/Home/End keys", () => {
    render(<Tabs label="Sections" tabs={tabs}>{(k) => <p>panel {k}</p>}</Tabs>);
    const [a, b, c] = screen.getAllByRole("tab");
    expect(a).toHaveAttribute("aria-selected", "true");
    expect(a).toHaveAttribute("tabindex", "0");
    expect(b).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(a!, { key: "ArrowRight" });
    expect(b).toHaveAttribute("aria-selected", "true");
    expect(b).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel b");
    fireEvent.keyDown(b!, { key: "End" });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c!, { key: "ArrowRight" });
    expect(a).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Alpha");
  });

  it("keeps the selected tab in the URL with urlKey", () => {
    window.history.replaceState(null, "", "/x?tab=c");
    render(<Tabs label="Sections" tabs={tabs} urlKey="tab">{(k) => <p>panel {k}</p>}</Tabs>);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel c");
    fireEvent.click(screen.getByRole("tab", { name: "Beta" }));
    expect(window.location.search).toBe("?tab=b");
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    expect(window.location.search).toBe("");
  });
});

describe("Menu", () => {
  it("opens on ArrowDown, moves with arrows, runs an item and returns focus", async () => {
    const del = vi.fn();
    render(<Menu label="More actions for Jane" items={[{ label: "Edit", onSelect: () => {} }, false, { label: "Delete", danger: true, onSelect: del }]} />);
    const btn = screen.getByRole("button", { name: "More actions for Jane" });
    expect(btn).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.keyDown(btn, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus());
    expect(btn).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(del).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(btn).toHaveFocus();
  });

  it("closes on Escape without closing an enclosing dialog", async () => {
    const onClose = vi.fn();
    render(<Dialog title="Edit" onClose={onClose}><Menu label="More" items={[{ label: "Edit", onSelect: () => {} }]} /></Dialog>);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders nothing without items", () => {
    const { container } = render(<Menu label="More" items={[false, null]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Dialog dirty", () => {
  it("asks before Escape discards unsaved changes", async () => {
    const onClose = vi.fn();
    render(<Dialog title="Edit" onClose={onClose} dirty><input aria-label="Name" /></Dialog>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Discard unsaved changes?");
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes straight away when not dirty", () => {
    const onClose = vi.fn();
    render(<Dialog title="Edit" onClose={onClose}><input aria-label="Name" /></Dialog>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("RecordLink", () => {
  it("links to the record and navigates in-app on a plain click", () => {
    window.history.replaceState(null, "", "/submissions");
    render(<RecordLink kind="candidate" id="c 1">Jane</RecordLink>);
    const a = screen.getByRole("link", { name: "Jane" });
    expect(a).toHaveAttribute("href", "/candidates/c%201");
    fireEvent.click(a);
    expect(window.location.pathname).toBe("/candidates/c%201");
  });

  it("is plain text without permission or a route", () => {
    render(<><RecordLink kind="candidate" id="1" allowed={false}>Jane</RecordLink><RecordLink kind="job" id="2">Java dev</RecordLink></>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Java dev")).toBeInTheDocument();
  });

  it("calls onOpen instead of navigating when given", () => {
    const onOpen = vi.fn();
    render(<RecordLink kind="submission" id="s1" onOpen={onOpen}>Sub</RecordLink>);
    fireEvent.click(screen.getByRole("link", { name: "Sub" }));
    expect(onOpen).toHaveBeenCalledWith("s1");
  });
});

describe("FilterBar", () => {
  function Harness() {
    const [loc, setLoc] = useState("x");
    return (
      <FilterBar label="Jobs filters" hasFilters={Boolean(loc)} onClear={() => setLoc("")}
        search={<div className="field inline fb-search"><label htmlFor="q">Search</label><input id="q" /></div>}
        primary={<div className="field inline"><label htmlFor="st">Status</label><select id="st"><option>Any</option></select></div>}
        more={<div className="field inline"><label htmlFor="loc">Location</label><select id="loc"><option>Any</option></select></div>}
        chips={loc ? [{ key: "loc", label: "Location: X", onRemove: () => setLoc("") }] : []}
        showLabel={loc ? "Show 3 jobs" : "Show 9 jobs"} />
    );
  }

  it("discloses More filters and clears chips", () => {
    const { container } = render(<Harness />);
    expect(screen.getByRole("search", { name: "Jobs filters" })).toBeInTheDocument();
    const more = screen.getByRole("button", { name: "More filters · 1" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".fb-more")).toHaveAttribute("hidden");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "More filters" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Location: X" }));
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("sheet footer: Reset clears every filter, the show button carries the result count", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(screen.getByRole("button", { name: "Show 3 jobs" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("button", { name: "Show 9 jobs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Show 9 jobs" }));
    expect(screen.getByRole("button", { name: /^Filters/ })).toHaveAttribute("aria-expanded", "false");
  });
});
