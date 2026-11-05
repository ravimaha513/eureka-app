import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRoutedId } from "./router";

describe("useRoutedId", () => {
  it("does not report the id it was seeded with from the URL (mount)", () => {
    const onChange = vi.fn();
    renderHook(() => useRoutedId(null, onChange));
    renderHook(() => useRoutedId("abc", onChange));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports opening and closing a record", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useRoutedId(null, onChange));
    act(() => result.current[1]("abc"));
    expect(onChange).toHaveBeenLastCalledWith("abc");
    act(() => result.current[1](null));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("follows back/forward without reporting it back (the URL already says it)", () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(({ routeId }) => useRoutedId(routeId, onChange), { initialProps: { routeId: null as string | null } });
    rerender({ routeId: "abc" });
    expect(result.current[0]).toBe("abc");
    rerender({ routeId: null });
    expect(result.current[0]).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    // A change after a back/forward is still reported.
    act(() => result.current[1]("def"));
    expect(onChange).toHaveBeenCalledWith("def");
  });

  it("without onChange it is plain state seeded from the route", () => {
    const { result } = renderHook(() => useRoutedId("abc"));
    expect(result.current[0]).toBe("abc");
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
  });
});
