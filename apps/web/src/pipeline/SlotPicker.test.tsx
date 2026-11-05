import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SlotPicker, slotStart, type Slot } from "./SlotPicker";
import { wallToInstant } from "./zones";

const ZONE = "America/New_York";

function Harness({ onZone }: { onZone?: boolean }) {
  const [s, setS] = useState<Slot>({ day: "", time: "", durationMin: 60 });
  const [zone, setZone] = useState(ZONE);
  return <>
    <SlotPicker value={s} onChange={setS} zone={zone} onZoneChange={onZone ? setZone : undefined} />
    <output>{s.day}|{slotStart(s, zone)?.toISOString() ?? ""}|{s.durationMin}</output>
  </>;
}

describe("SlotPicker", () => {
  it("picks a working-day chip, a 15-minute start and a duration in the chosen zone, and spells out the window", () => {
    render(<Harness />);
    const chips = screen.getByRole("group", { name: "Day" });
    const days = [...chips.querySelectorAll("button")];
    expect(days).toHaveLength(5);
    // Working days only: no Saturday or Sunday chip.
    expect(days.map((b) => b.getAttribute("aria-label"))).not.toContainEqual(expect.stringMatching(/^(Saturday|Sunday)/));
    fireEvent.click(days[1]!);
    const select = screen.getByLabelText("Start time") as HTMLSelectElement;
    expect([...select.options].slice(1, 3).map((o) => o.value)).toEqual(["06:00", "06:15"]);
    fireEvent.change(select, { target: { value: "14:30" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Duration" }), { target: { value: "30" } });
    const [day, iso, len] = document.querySelector("output")!.textContent!.split("|");
    // 14:30 is read in New York, whatever the browser's zone.
    expect(iso).toBe(wallToInstant(day!, "14:30", ZONE)!.toISOString());
    expect(len).toBe("30");
    expect(screen.getAllByText(/America\/New_York/).length).toBeGreaterThan(0);
  });

  it("shows the time zone first when it can be changed", () => {
    render(<Harness onZone />);
    const zone = screen.getByRole("combobox", { name: "Time zone" });
    expect(zone).toHaveValue(ZONE);
    fireEvent.change(zone, { target: { value: "Asia/Kolkata" } });
    expect(zone).toHaveValue("Asia/Kolkata");
  });
});
