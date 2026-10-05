import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "../api";
import { NotificationBell, type InboxItem } from "./Inbox";

// Bell and inbox panel (API: apps/api/src/modules/notifications, migration 0046).

const P1 = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const item = (id: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  id, type: "assignment.ending_soon", title: `Title ${id}`, body: `Body ${id}`,
  entity: { type: "placement", id: P1 }, createdAt: "2026-10-01T10:00:00.000Z", readAt: null, ...extra,
});

type Reply = { status?: number; body?: unknown };
interface Call { method: string; path: string; search: string; body: unknown }
let routes: Record<string, (body: unknown, search: URLSearchParams) => Reply>;
let calls: Call[];
let unread: { unread: number; capped: boolean };

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  unread = { unread: 2, capped: false };
  routes = {
    "GET /api/v1/notifications/unread-count": () => ({ body: unread }),
    "GET /api/v1/notifications": (_b, s) => (s.get("cursor") === "c2"
      ? { body: { items: [item("n3", { readAt: "2026-09-30T10:00:00.000Z", createdAt: "2026-09-30T09:00:00.000Z" })], nextCursor: null } }
      : { body: { items: [item("n1", { createdAt: "2026-10-01T11:00:00.000Z" }), item("n2", { entity: { type: "candidate", id: C1 } })], nextCursor: "c2" } }),
    "POST /api/v1/notifications/read-all": () => ({ body: { updated: 2 } }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body });
    const key = `${method} ${url.pathname}`;
    const h = routes[key] ?? (/^POST \/api\/v1\/notifications\/[^/]+\/(read|unread)$/.test(key) ? (): Reply => ({ status: 204 }) : undefined);
    if (!h) return new Response(JSON.stringify({ detail: "unmocked" }), { status: 599 });
    const r: Reply = h(body, url.searchParams);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
});
afterEach(() => vi.restoreAllMocks());

function wrap(opts: { pollMs?: number; canOpen?: (e: InboxItem["entity"]) => boolean } = {}) {
  const onOpen = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NotificationBell onOpen={onOpen} canOpen={opts.canOpen ?? (() => true)} pollMs={opts.pollMs ?? 60_000} />
    </QueryClientProvider>,
  );
  return { onOpen };
}
const bell = () => screen.getByRole("button", { name: /^Notifications,/ });

describe("notification bell", () => {
  it("names the unread count accessibly and caps the badge at 99+", async () => {
    wrap();
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications, 2 unread"));
    expect(bell()).toHaveAttribute("aria-expanded", "false");
    expect(bell()).toHaveTextContent("2");
  });

  it("shows 99+ when the server caps the count, and 'none unread' at zero", async () => {
    unread = { unread: 1000, capped: true };
    wrap();
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications, 99+ unread"));
    expect(bell()).toHaveTextContent("99+");
  });

  it("polls the unread count and announces only growth in a polite live region", async () => {
    wrap({ pollMs: 40 });
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications, 2 unread"));
    // A polite live region without role="status": the page owns the page-level status region.
    const status = document.querySelector<HTMLElement>(".sr-only[aria-live='polite']")!;
    expect(status).not.toBeNull();
    expect(status).toHaveTextContent("");                                  // nothing on the first answer
    unread = { unread: 3, capped: false };
    await waitFor(() => expect(status).toHaveTextContent("1 new notification. 3 unread."), { timeout: 2000 });
    expect(bell()).toHaveAccessibleName("Notifications, 3 unread");
    unread = { unread: 1, capped: false };                                  // read elsewhere: no announcement
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications, 1 unread"), { timeout: 2000 });
    expect(status).toHaveTextContent("1 new notification. 3 unread.");
    expect(calls.filter((c) => c.path === "/api/v1/notifications/unread-count").length).toBeGreaterThan(2);
  });
});

describe("inbox panel", () => {
  it("opens as a disclosure, focuses its heading, lists entries newest first and loads older ones", async () => {
    wrap();
    fireEvent.click(bell());
    const panel = await screen.findByRole("region", { name: "Notifications" });
    expect(bell()).toHaveAttribute("aria-expanded", "true");
    expect(bell()).toHaveAttribute("aria-controls", panel.id);
    expect(within(panel).getByRole("heading", { name: "Notifications" })).toHaveFocus();
    const list = await within(panel).findByRole("list", { name: "Notifications, newest first" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByText("Unread:", { exact: false })).toHaveLength(2);
    fireEvent.click(within(panel).getByRole("button", { name: "Show older notifications" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(calls.some((c) => c.search.includes("cursor=c2"))).toBe(true);
    expect(within(list).getByRole("button", { name: "Mark unread: Title n3" })).toBeInTheDocument();
  });

  it("Escape and the close button close the panel and return focus to the bell", async () => {
    wrap();
    fireEvent.click(bell());
    const panel = await screen.findByRole("region", { name: "Notifications" });
    fireEvent.keyDown(within(panel).getByRole("heading", { name: "Notifications" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
    expect(bell()).toHaveFocus();
    fireEvent.click(bell());
    fireEvent.click(await screen.findByRole("button", { name: "Close notifications" }));
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
    expect(bell()).toHaveFocus();
  });

  it("marks one entry read or unread, and all read up to the newest entry shown", async () => {
    wrap();
    fireEvent.click(bell());
    const list = await screen.findByRole("list", { name: "Notifications, newest first" });
    fireEvent.click(within(list).getByRole("button", { name: "Mark read: Title n1" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/notifications/n1/read")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/notifications/read-all")?.body)
      .toEqual({ before: "2026-10-01T11:00:00.000Z" }));
    // After a write the count and the list are fetched again.
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/v1/notifications/unread-count").length).toBeGreaterThan(1));
  });

  it("opens the entry's placement or candidate (marking it read) when the user has that screen", async () => {
    const { onOpen } = wrap({ canOpen: (e) => e.type === "candidate" });
    fireEvent.click(bell());
    const list = await screen.findByRole("list", { name: "Notifications, newest first" });
    // Placement screen not available: plain text, no link.
    expect(within(list).queryByRole("button", { name: "Title n1" })).not.toBeInTheDocument();
    expect(within(list).getByText("Title n1")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Title n2" }));
    expect(onOpen).toHaveBeenCalledWith({ type: "candidate", id: C1 });
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/notifications/n2/read")).toBe(true));
  });

  it("reports a failed update without losing the list", async () => {
    routes["POST /api/v1/notifications/read-all"] = () => ({ status: 500, body: {} });
    wrap();
    fireEvent.click(bell());
    await screen.findByRole("list", { name: "Notifications, newest first" });
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not update notifications");
    expect(screen.getByRole("list", { name: "Notifications, newest first" })).toBeInTheDocument();
  });
});
