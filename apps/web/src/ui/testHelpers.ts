import { fireEvent, screen, within } from "@testing-library/react";

/** Opens the combobox labelled `label` (ui/Combobox), ticks each named option, then closes it. */
export async function pickOption(label: string, ...options: string[]) {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.click(input);
  const list = await screen.findByRole("listbox", { name: label });
  for (const o of options) fireEvent.click(await within(list).findByRole("option", { name: new RegExp(`^${escape(o)}(, \\d+ candidates?)?$`) }));
  fireEvent.keyDown(input, { key: "Escape" });
}

/** Opens the combobox labelled `label` and switches it to "is none of". */
export function negate(label: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("button", { name: "is none of" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Escape" });
}

/** Clicks the choice named `option` in the segmented control labelled `label` (ui/Segmented). */
export function pickSegment(label: string, option: string) {
  fireEvent.click(within(screen.getByRole("radiogroup", { name: label })).getByRole("radio", { name: option }));
}

/** Opens the "More filters" panel of a candidate list. */
export function openMoreFilters() {
  fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
