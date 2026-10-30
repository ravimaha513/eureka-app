import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "./OfflineBanner";

const setOnline = (online: boolean) => act(() => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
  window.dispatchEvent(new Event(online ? "online" : "offline"));
});

afterEach(() => vi.restoreAllMocks());

describe("OfflineBanner", () => {
  it("says nothing while online, warns while offline and clears on reconnect", () => {
    render(<OfflineBanner />);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    setOnline(false);
    expect(status).toHaveTextContent("You're offline. Changes won't be saved until the connection is back.");
    expect(status).toHaveClass("offline-banner");
    setOnline(true);
    expect(status).toBeEmptyDOMElement();
  });
});
