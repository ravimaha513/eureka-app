import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SlotPicker, isoDay, slotStart, type Slot } from "./SlotPicker";

function Harness() {
  const [s, setS] = useState<Slot>({ day: "", time: "", durationMin: 60 });
  return <><SlotPicker value={s} onChange={setS} zone="America/New_York" /><output>{slotStart(s)?.toISOString() ?? ""}|{s.durationMin}</output></>;
}

describe("SlotPicker", () => {
  it("picks a day chip, a 15-minute start and a duration, and spells out the window", () => {
    render(<Harness />);
    const chips = screen.getAllByRole("button", { pressed: false }).map((b) => b.textContent);
    expect(chips.slice(0, 2)).toEqual(["Today", "Tomorrow"]);
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent === "Tomorrow")!);
    const select = screen.getByLabelText("Start time") as HTMLSelectElement;
    expect([...select.options].slice(1, 3).map((o) => o.value)).toEqual(["06:00", "06:15"]);
    fireEvent.change(select, { target: { value: "14:30" } });
    fireEvent.click(screen.getByRole("button", { name: "30 min" }));
    const t = new Date(); t.setDate(t.getDate() + 1);
    expect(document.querySelector("output")!.textContent).toBe(`${new Date(`${isoDay(t)}T14:30:00`).toISOString()}|30`);
    expect(screen.getByText(/America\/New_York/)).toBeInTheDocument();
  });
});
