import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MultiCombobox } from "./Combobox";
import { Segmented } from "./Segmented";

const OPTS = [{ value: "d", label: "Dallas" }, { value: "a", label: "Atlanta" }, { value: "au", label: "Austin" }];

function Harness({ onChange, counts, initial = [] }: { onChange?: (v: string[]) => void; counts?: Map<string, number>; initial?: string[] }) {
  const [v, setV] = useState<string[]>(initial);
  const [not, setNot] = useState(false);
  return (
    <MultiCombobox label="Location" values={v} options={OPTS} anyLabel="Any location" counts={counts}
      negated={not} onNegate={setNot} onChange={(x) => { setV(x); onChange?.(x); }} />
  );
}

const names = () => screen.getAllByRole("option").map((o) => within(o).queryByText(/./, { selector: ".lab" })?.textContent ?? o.textContent);

describe("MultiCombobox", () => {
  it("narrows as you type, ticks several values and stays open", () => {
    const spy = vi.fn();
    render(<Harness onChange={spy} />);
    const input = screen.getByRole("combobox", { name: "Location" });
    fireEvent.change(input, { target: { value: "a" } });
    expect(names()).toEqual(["Dallas", "Atlanta", "Austin"]);
    fireEvent.change(input, { target: { value: "au" } });
    expect(names()).toEqual(["Austin"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith(["au"]);
    expect(screen.getByRole("listbox", { name: "Location" })).toHaveAttribute("aria-multiselectable", "true");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("option", { name: /Dallas/ }));
    expect(spy).toHaveBeenLastCalledWith(["au", "d"]);
    expect(screen.getByRole("option", { name: /Dallas/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("option", { name: /Austin/ }));
    expect(spy).toHaveBeenLastCalledWith(["d"]);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("Dallas");
    expect(input).toHaveAccessibleDescription("Is any of: Dallas");
  });

  it("moves with arrows, toggles with Space, clears", () => {
    const spy = vi.fn();
    render(<Harness onChange={spy} />);
    const input = screen.getByRole("combobox", { name: "Location" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringContaining("opt-1"));
    fireEvent.keyDown(input, { key: " " });
    expect(spy).toHaveBeenLastCalledWith(["a"]);
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Clear Location" }));
    expect(spy).toHaveBeenLastCalledWith([]);
  });

  it("shows counts, dims empty values, and switches to 'is none of'", () => {
    render(<Harness counts={new Map([["d", 12], ["a", 0]])} initial={["d", "a", "au"]} />);
    const input = screen.getByRole("combobox", { name: "Location" });
    expect(input).toHaveValue("Dallas +2");
    fireEvent.click(input);
    expect(screen.getByRole("option", { name: /Dallas/ })).toHaveTextContent("12");
    expect(screen.getByRole("option", { name: /Atlanta/ })).not.toHaveClass("zero"); // selected: never dimmed
    fireEvent.click(screen.getByRole("button", { name: "is none of" }));
    expect(screen.getByRole("button", { name: "is none of" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAccessibleDescription("Is none of: Dallas, Atlanta, Austin");
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
    expect(screen.getByRole("radiogroup", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Any" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "On file" }));
    expect(spy).toHaveBeenCalledWith("yes");
  });
});
