import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Combobox } from "./Combobox";
import { Segmented } from "./Segmented";

const OPTS = [{ value: "d", label: "Dallas" }, { value: "a", label: "Atlanta" }, { value: "au", label: "Austin" }];

function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [v, setV] = useState("");
  return <Combobox label="Location" value={v} options={OPTS} anyLabel="Any location" onChange={(x) => { setV(x); onChange?.(x); }} />;
}

describe("Combobox", () => {
  it("narrows the list as you type and picks with the keyboard", () => {
    const spy = vi.fn();
    render(<Harness onChange={spy} />);
    const input = screen.getByRole("combobox", { name: "Location" });
    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Dallas", "Atlanta", "Austin"]);
    fireEvent.change(input, { target: { value: "au" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Austin"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(spy).toHaveBeenCalledWith("au");
    expect(input).toHaveValue("Austin");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("moves with arrows, closes on Escape without changing, and clears", () => {
    const spy = vi.fn();
    render(<Harness onChange={spy} />);
    const input = screen.getByRole("combobox", { name: "Location" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("listbox", { name: "Location" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringContaining("opt-1"));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(input);
    fireEvent.click(screen.getByRole("option", { name: "Dallas" }));
    expect(spy).toHaveBeenLastCalledWith("d");
    fireEvent.click(screen.getByRole("button", { name: "Clear Location" }));
    expect(spy).toHaveBeenLastCalledWith("");
    expect(input).toHaveValue("");
  });

  it("says when nothing matches", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "zz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});

describe("Segmented", () => {
  it("is a labelled radio group", () => {
    const spy = vi.fn();
    render(<Segmented label="Resume" value="" options={[["", "Any"], ["yes", "On file"]] as const} onChange={spy} />);
    const group = screen.getByRole("radiogroup", { name: "Resume" });
    expect(screen.getByRole("radio", { name: "Any" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "On file" }));
    expect(spy).toHaveBeenCalledWith("yes");
    expect(group).toBeInTheDocument();
  });
});
