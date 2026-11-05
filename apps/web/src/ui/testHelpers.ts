import { fireEvent, screen, within } from "@testing-library/react";

/** Opens the combobox labelled `label` (ui/Combobox) and clicks the option named `option`. */
export async function pickOption(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/** Clicks the choice named `option` in the segmented control labelled `label` (ui/Segmented). */
export function pickSegment(label: string, option: string) {
  fireEvent.click(within(screen.getByRole("radiogroup", { name: label })).getByRole("radio", { name: option }));
}

/** Opens the "More filters" panel of a candidate list. */
export function openMoreFilters() {
  fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
}
