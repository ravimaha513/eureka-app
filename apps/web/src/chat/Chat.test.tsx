import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCsrf, type Me } from "../api";
import { browser } from "../sales/resumesApi";
import { ChatPage } from "./ChatPage";
import { attachmentState, mergeMessages, type ConversationDetail, type ConversationSummary, type Message } from "./chatApi";
import { splitLinks } from "./linkify";

// Chat screen (API: apps/api/src/modules/chat, docs/chat-api.md).

const ME = "00000000-0000-4000-8000-000000000001";
const HR = "00000000-0000-4000-8000-000000000002";
const CONV = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const me: Me = { id: ME, email: "me@eureka.example", displayName: "Riya Recruiter", roles: [], capabilities: ["chat:use"], csrfToken: "t" };

const summary = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: CONV, kind: "direct", title: "Hema HR", counterpart: { id: HR, name: "Hema HR", designation: "HR Executive", online: true },
  memberCount: 2, archived: false, favorite: false, muted: false, unread: 2, unreadCapped: false,
  lastMessage: { id: "m2", preview: "See you", mine: false, sender: { id: HR, name: "Hema HR" }, createdAt: new Date().toISOString() },
  activityAt: new Date().toISOString(), ...over,
});
const detail = (over: Partial<ConversationDetail> = {}): ConversationDetail => ({
  id: CONV, kind: "direct", title: "Hema HR", name: null, rowVersion: 1, createdAt: "2026-10-01T10:00:00.000Z",
  archived: false, favorite: false, muted: false, myRole: "member", canManage: false,
  members: [
    { id: ME, name: "Riya Recruiter", designation: null, role: "member", online: true, me: true },
    { id: HR, name: "Hema HR", designation: "HR Executive", role: "member", online: true, me: false },
  ], ...over,
});
let seq = 0;
const msg = (over: Partial<Message> = {}): Message => {
  seq += 1;
  return {
    id: `m-${seq}`, conversationId: CONV, seq, rev: seq, sender: { id: HR, name: "Hema HR" }, mine: false, body: `message ${seq}`,
    deleted: false, createdAt: new Date().toISOString(), editedAt: null, attachments: [], ...over,
  };
};

type Reply = { status?: number; body?: unknown };
interface Call { method: string; path: string; search: string; body: unknown }
let routes: Record<string, (body: unknown, search: URLSearchParams) => Reply>;
let calls: Call[];

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  seq = 0;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const first = [msg({ body: "Hi, see https://example.com/docs.", createdAt: yesterday }), msg({ mine: true, sender: { id: ME, name: "Riya Recruiter" }, body: "Thanks" })];
  routes = {
    "GET /api/v1/chat/conversations": (_b, s) => ({ body: { items: s.get("filter") === "group" ? [] : [summary()], nextCursor: null } }),
    "GET /api/v1/chat/unread": () => ({ body: { unread: 2, capped: false, conversations: 1 } }),
    "GET /api/v1/chat/people": () => ({ body: { items: [{ id: HR, name: "Hema HR", designation: "HR Executive", online: true },
      { id: "00000000-0000-4000-8000-000000000003", name: "Lalit Lead", designation: null, online: false }] } }),
    [`GET /api/v1/chat/conversations/${CONV}`]: () => ({ body: detail() }),
    [`GET /api/v1/chat/conversations/${CONV}/messages`]: (_b, s) => (s.get("after") !== null
      ? { body: { items: [], cursor: 10, more: false } }
      : { body: { items: first, nextCursor: null, cursor: 10 } }),
    [`POST /api/v1/chat/conversations/${CONV}/read`]: () => ({ status: 204 }),
    [`POST /api/v1/chat/conversations/${CONV}/messages`]: (b) => ({ status: 201, body: {
      message: msg({ mine: true, sender: { id: ME, name: "Riya Recruiter" }, body: (b as { body: string }).body }), uploads: [] } }),
    "POST /api/v1/chat/conversations/group": () => ({ status: 201, body: detail({ id: GROUP, kind: "group", title: "Desk", name: "Desk", canManage: true, myRole: "owner" }) }),
    [`GET /api/v1/chat/conversations/${GROUP}`]: () => ({ body: detail({ id: GROUP, kind: "group", title: "Desk", name: "Desk", canManage: true, myRole: "owner" }) }),
    [`GET /api/v1/chat/conversations/${GROUP}/messages`]: () => ({ body: { items: [], nextCursor: null, cursor: 0 } }),
    [`POST /api/v1/chat/conversations/${GROUP}/read`]: () => ({ status: 204 }),
    [`DELETE /api/v1/chat/conversations/${CONV}`]: () => ({ status: 204 }),
    "POST /api/v1/chat/attachments/a-1/download": () => ({ body: { url: "/files/x", expiresAt: "2026-10-05T00:00:00Z" } }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body });
    const h = routes[`${method} ${url.pathname}`];
    if (!h) return new Response(JSON.stringify({ detail: "unmocked" }), { status: 599 });
    const r = h(body, url.searchParams);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const renderPage = (initial: string | null = null) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChatPage me={me} initialConversationId={initial} />
    </QueryClientProvider>,
  );

describe("linkify", () => {
  it("links https URLs only and keeps trailing punctuation as text", () => {
    expect(splitLinks("see https://example.com/a?b=1. ok")).toEqual([
      { kind: "text", text: "see " }, { kind: "link", text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" }, { kind: "text", text: ". ok" },
    ]);
    expect(splitLinks("(https://en.wikipedia.org/wiki/Foo_(bar))").map((p) => p.text))
      .toEqual(["(", "https://en.wikipedia.org/wiki/Foo_(bar)", ")"]);
    for (const t of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "www.example.com", "https://user:pw@example.com/"]) {
      expect(splitLinks(t).every((p) => p.kind === "text"), t).toBe(true);
    }
  });
  it("never turns markup into elements", async () => {
    await renderLinkified("<img src=x onerror=alert(1)> https://ok.example/");
    expect(document.querySelector("img")).toBeNull();
    const a = screen.getByRole("link", { name: "https://ok.example/" });
    expect(a).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(a).toHaveAttribute("target", "_blank");
  });
});

function renderLinkified(text: string) {
  // Through the page: a message body is rendered with Linkified.
  routes[`GET /api/v1/chat/conversations/${CONV}/messages`] = () => ({ body: { items: [msg({ body: text })], nextCursor: null, cursor: 1 } });
  renderPage(CONV);
  return waitFor(() => screen.getByText(/onerror/));
}

describe("helpers", () => {
  it("merges messages by id, newest revision wins, in send order", () => {
    const a = msg({ body: "a" });
    const b = msg({ body: "b" });
    const edited = { ...a, body: "a2", rev: 99 };
    expect(mergeMessages([b, a], [edited, { ...b, rev: 0, body: "stale" }]).map((m) => m.body)).toEqual(["a2", "b"]);
  });
  it("describes attachment states", () => {
    const base = { id: "x", fileName: "f.pdf", contentType: "application/pdf", sizeBytes: 2048 };
    expect(attachmentState({ ...base, status: "clean" })).toEqual({ label: "2 KB", ready: true });
    expect(attachmentState({ ...base, status: "pending" }).label).toBe("Scanning…");
    expect(attachmentState({ ...base, status: "infected" }).label).toBe("Blocked");
    expect(attachmentState({ ...base, status: "expired" }).label).toBe("Upload failed");
  });
});

describe("chat page", () => {
  it("lists conversations with filters, unread state and presence in the accessible name", async () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Chat" })).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "Conversations" });
    const row = await within(list).findByRole("button", { name: "Hema HR, online, 2 unread" });
    expect(row).toBeInTheDocument();
    for (const f of ["All Messages", "Unread", "Group", "Favorite", "Archived"]) {
      expect(within(list).getByRole("button", { name: f })).toBeInTheDocument();
    }
    expect(within(list).getByRole("button", { name: "All Messages" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(list).getByRole("button", { name: "Group" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/chat/conversations" && c.search.includes("filter=group"))).toBe(true));
    expect(screen.getByRole("button", { name: "Create group chat" })).toBeInTheDocument();
  });

  it("opens a conversation: bubbles, day separators, safe links, read mark; every icon button is named", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Hema HR, online/ }));
    const log = await screen.findByRole("list", { name: "Messages with Hema HR" });
    await within(log).findByText("Thanks");
    expect(within(log).getByText("Yesterday")).toBeInTheDocument();
    expect(within(log).getByText("Today")).toBeInTheDocument();
    expect(within(log).getByText("Thanks").closest(".chat-msg")).toHaveClass("mine");
    expect(within(log).getByRole("link", { name: "https://example.com/docs" })).toHaveAttribute("href", "https://example.com/docs");
    expect(screen.getByText("HR Executive · Online")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/read"))).toBe(true));
    for (const b of screen.getAllByRole("button")) expect(b).toHaveAccessibleName();
    expect(screen.getByRole("button", { name: "Back to conversations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Edit your message sent at/ })).toBeInTheDocument();
  });

  it("Enter sends, Shift+Enter does not; the text is trimmed by the server and shown as mine", async () => {
    renderPage(CONV);
    const box = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"))).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"))).toHaveLength(1));
    const sent = calls.find((c) => c.method === "POST" && c.path.endsWith("/messages"))!.body as { clientId: string; body: string; attachments: unknown[] };
    expect(sent.body).toBe("line one");
    expect(sent.attachments).toEqual([]);
    expect(sent.clientId).toMatch(/^[0-9a-f-]{36}$/);
    const mine = await screen.findByText("line one", { selector: ".chat-body" });
    expect(mine.closest(".chat-msg")).toHaveClass("mine");
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("announces a new message from the other person in a live region", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(CONV);
    await screen.findByText("Thanks");
    routes[`GET /api/v1/chat/conversations/${CONV}/messages`] = (_b, s) => (s.get("after") !== null
      ? { body: { items: [msg({ body: "Are you free at 3?" })], cursor: 11, more: false } }
      : { body: { items: [], nextCursor: null, cursor: 10 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_500); });
    await screen.findByText("Are you free at 3?");
    expect(screen.getByRole("status")).toHaveTextContent("New message from Hema HR: Are you free at 3?");
    const polls = calls.filter((c) => c.search.includes("after=10"));
    expect(polls.length).toBeGreaterThan(0);
  });

  it("creates a group from the side panel", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Create group chat" }));
    const panel = await screen.findByRole("dialog", { name: "Create Group Chat" });
    fireEvent.click(within(panel).getByRole("button", { name: "Create Group" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Enter a group name.");
    fireEvent.change(within(panel).getByLabelText("Group Name"), { target: { value: "Desk" } });
    fireEvent.click(await within(panel).findByRole("checkbox", { name: /Hema HR/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Create Group" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create Group Chat" })).not.toBeInTheDocument());
    const created = calls.find((c) => c.path === "/api/v1/chat/conversations/group")!;
    expect(created.body).toEqual({ name: "Desk", memberIds: [HR] });
    expect(await screen.findByRole("heading", { level: 2, name: "Desk" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Members" })).toBeInTheDocument();
  });

  it("deletes a direct chat for me from the conversation menu", async () => {
    renderPage(CONV);
    await screen.findByText("Thanks");
    fireEvent.click(await screen.findByRole("button", { name: "Conversation options" }));
    expect(screen.queryByRole("button", { name: "Leave group" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete chat?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete chat" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/v1/chat/conversations/${CONV}`)).toBe(true));
    expect(await screen.findByText("Chat deleted.")).toBeInTheDocument();
  });

  it("downloads a clean attachment and shows pending ones as scanning", async () => {
    const download = vi.spyOn(browser, "download").mockImplementation(() => undefined);
    routes[`GET /api/v1/chat/conversations/${CONV}/messages`] = (_b, s) => (s.get("after") !== null
      ? { body: { items: [], cursor: 3, more: false } }
      : { body: { items: [msg({ body: "", attachments: [
        { id: "a-1", fileName: "offer.pdf", contentType: "application/pdf", sizeBytes: 4096, status: "clean" },
        { id: "a-2", fileName: "scan.png", contentType: "image/png", sizeBytes: 10, status: "pending" },
      ] })], nextCursor: null, cursor: 3 } });
    renderPage(CONV);
    fireEvent.click(await screen.findByRole("button", { name: "Download offer.pdf, 4 KB" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith("/files/x"));
    expect(screen.getByText("Scanning…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download scan.png/ })).not.toBeInTheDocument();
  });

  it("starts a direct chat from people search", async () => {
    routes["POST /api/v1/chat/conversations/direct"] = () => ({ status: 201, body: detail({ id: CONV }) });
    routes["GET /api/v1/chat/conversations"] = () => ({ body: { items: [], nextCursor: null } });
    renderPage();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats and people" }), { target: { value: "lal" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start a chat with Lalit Lead" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/chat/conversations/direct")?.body)
      .toEqual({ userId: "00000000-0000-4000-8000-000000000003" }));
  });
});
