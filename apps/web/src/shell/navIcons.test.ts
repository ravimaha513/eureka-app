import { describe, expect, it } from "vitest";
import { NAV, SETTINGS_NAV } from "../nav";
import { NAV_ICONS } from "./ui";

describe("sidebar icons", () => {
  it("every screen has one: without it the label sits out of line with the rest", () => {
    expect([...NAV, SETTINGS_NAV].filter((i) => !NAV_ICONS[i.key]).map((i) => i.key)).toEqual([]);
  });
});
