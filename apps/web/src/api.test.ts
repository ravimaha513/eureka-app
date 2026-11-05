import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, BUSY_EVENT, STALE_EVENT, api, commonProblem, ifMatch } from "./api";
import { BUSY_MESSAGE, RATE_LIMIT_MESSAGE, STALE_MESSAGE, limitText } from "./lib/errorText";
import { queryRetry, refetchOnStale } from "./lib/queryClient";

const problem = (status: number, detail?: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ title: "Error", status, ...(detail ? { detail } : {}) }), {
    status, headers: { "content-type": "application/problem+json", ...headers },
  });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as ApiError);

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("503 + Retry-After", () => {
  it("a GET shows the busy state, waits Retry-After and retries once", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(problem(503, "database_busy", { "retry-after": "2" }))
      .mockResolvedValueOnce(ok({ items: [1] }));
    const busy: number[] = [];
    const onBusy = (e: Event) => busy.push((e as CustomEvent<number>).detail);
    window.addEventListener(BUSY_EVENT, onBusy);
    const p = api<{ items: number[] }>("/api/v1/things");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(busy).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ items: [1] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(busy).toEqual([1, -1]);
    window.removeEventListener(BUSY_EVENT, onBusy);
  });

  it("a GET that is still busy fails once, marked retried, with readable text", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => problem(503, "database_busy", { "retry-after": "1" }));
    const p = caught(api("/api/v1/things"));
    await vi.advanceTimersByTimeAsync(1000);
    const e = await p;
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(e).toMatchObject({ status: 503, detail: "database_busy", retryAfter: 1, retried: true, message: BUSY_MESSAGE });
    expect(commonProblem(e)).toBe(BUSY_MESSAGE);
  });

  it("writes are never repeated, and a server sentence is shown as is", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem(503, "Too many reports are running right now; try again in a few seconds", { "retry-after": "5" }));
    const e = await caught(api("/api/v1/reports/x", { method: "POST" }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(e).toMatchObject({ retried: false, retryAfter: 5, message: "Too many reports are running right now. Try again in a few seconds." });
  });

  it("a Retry-After too long to wait for fails at once", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem(503, "report_timeout", { "retry-after": "30" }));
    const e = await caught(api("/api/v1/reports/x"));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(e.retryAfter).toBe(30);
  });
});

describe("React Query retry (no double retry)", () => {
  const err = (status: number, extra: Partial<ApiError> = {}) => Object.assign(new ApiError(status, "x"), extra);
  it.each([
    ["network error", new TypeError("fetch failed"), true],
    ["500", err(500), true],
    ["503 without Retry-After", err(503), true],
    ["503 apiFetch already retried", err(503, { retryAfter: 1, retried: true }), false],
    ["503 with a long Retry-After", err(503, { retryAfter: 30 }), false],
    ["404", err(404), false],
    ["429", err(429), false],
  ] as const)("%s → retry %s", (_n, e, expected) => {
    expect(queryRetry(0, e)).toBe(expected);
    expect(queryRetry(1, e)).toBe(false);
  });
});

describe("429", () => {
  it.each([
    ["too_many_restricted_opens", "You've reached the daily limit for opening restricted documents. It resets within 24 hours."],
    ["bulk_budget_exceeded", "You've used today's allowance for bulk-adding candidates. Try again tomorrow."],
    ["Too many exports; try again in a few minutes", "Too many exports. Try again in a few minutes."],
    ["some_unknown_code", RATE_LIMIT_MESSAGE],
    [undefined, RATE_LIMIT_MESSAGE],
  ])("%s → readable text", async (detail, text) => {
    expect(limitText(detail)).toBe(text);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem(429, detail));
    const e = await caught(api("/api/v1/documents/d1/download", { method: "POST" }));
    expect(e.detail).toBe(detail); // the code stays machine-readable
    expect(e.message).toBe(text);
    expect(commonProblem(e)).toBe(text);
  });
});

describe("412 stale and If-Match", () => {
  it("ifMatch quotes the version, keeps 0 and omits an unknown one", () => {
    expect(ifMatch(3)).toEqual({ "if-match": "\"3\"" });
    expect(ifMatch(0)).toEqual({ "if-match": "\"0\"" });
    expect(ifMatch(undefined)).toEqual({});
    expect(ifMatch(null)).toEqual({});
  });

  it("a stale write reads as 'reload' and refetches the screens on view", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const stop = refetchOnStale(client);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem(412, "stale"));
    const e = await caught(api("/api/v1/candidates/c1", { method: "PATCH", body: "{}", headers: ifMatch(3) }));
    expect(e.message).toBe(STALE_MESSAGE);
    expect(commonProblem(e)).toBe(STALE_MESSAGE);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch).mock.calls[0]![1]!.headers).toMatchObject({ "if-match": "\"3\"" });
    stop();
    window.dispatchEvent(new Event(STALE_EVENT));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("other 412s and 4xx keep their code as the message and are left to the screen", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem(412, "precondition_failed"));
    const e = await caught(api("/api/v1/x", { method: "PATCH" }));
    expect(e.message).toBe("precondition_failed");
    expect(commonProblem(e)).toBeNull();
  });
});
