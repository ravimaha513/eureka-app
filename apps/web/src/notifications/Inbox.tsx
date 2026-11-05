import { useEffect, useId, useRef, useState } from "react";
import {
  BadgeCheck, Bell, CalendarClock, Check, CircleDot, FolderOpen, MessageCircle, Newspaper, TrendingUp, UserRound, X, type LucideIcon,
} from "lucide-react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { fmtDateTime } from "../lib/format";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";
import "./notifications.css";

/** One inbox entry (GET /api/v1/notifications; migration 0046). */
export interface InboxItem {
  id: string;
  type: string;
  title: string;
  body: string;
  entity: { type: "placement" | "candidate" | "conversation" | "application" | "interview" | "digest" | "performance_target"; id: string };
  createdAt: string;
  readAt: string | null;
}
interface InboxPage { items: InboxItem[]; nextCursor: string | null }

export const inboxKeys = { all: ["notifications"] as const, unread: ["notifications", "unread"] as const, list: ["notifications", "list"] as const };

/** How often the bell asks for the unread count (no websockets; design A7). */
export const UNREAD_POLL_MS = 60_000;

const countLabel = (n: number, capped: boolean) => (capped || n > 99 ? "99+" : String(n));

/** What an entry is about, at a glance (decorative; the title says it in words). */
const ENTITY_ICONS: Partial<Record<InboxItem["entity"]["type"], LucideIcon>> = {
  placement: BadgeCheck, candidate: UserRound, conversation: MessageCircle, application: FolderOpen,
  interview: CalendarClock, digest: Newspaper, performance_target: TrendingUp,
};

/** Today: the time; yesterday: "Yesterday"; this year: "Nov 5"; older: "Nov 5, 2025". The full stamp is the title. */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

/**
 * The bell in the top bar and its inbox panel. The unread count is polled
 * every minute (and on window focus); when it grows, a polite live region
 * announces it. The panel is a disclosure: Escape or the bell closes it and
 * focus returns to the bell.
 */
export function NotificationBell({ onOpen, canOpen, pollMs = UNREAD_POLL_MS }: {
  onOpen: (entity: InboxItem["entity"]) => void;
  canOpen: (entity: InboxItem["entity"]) => boolean;
  pollMs?: number;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const bell = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panelId = useId();
  const unread = useQuery({
    queryKey: inboxKeys.unread,
    queryFn: () => api<{ unread: number; capped: boolean }>("/api/v1/notifications/unread-count"),
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });
  const n = typeof unread.data?.unread === "number" ? unread.data.unread : 0;
  const capped = unread.data?.capped === true;

  // Announce only growth after the first answer (not the count on page load).
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (typeof unread.data?.unread !== "number") return;
    const prev = last.current;
    last.current = n;
    if (prev !== null && n > prev) {
      const added = n - prev;
      setAnnounce(`${added} new notification${added === 1 ? "" : "s"}. ${countLabel(n, capped)} unread.`);
    }
  }, [n, capped, unread.data]);

  const close = (focusBell = true) => {
    setOpen(false);
    if (focusBell) bell.current?.focus();
  };
  useEffect(() => { if (open) heading.current?.focus(); }, [open]);
  // A popover: a click outside it (the account menu, the page) or Escape anywhere closes it.
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setOpen(false);
      bell.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const label = n === 0 ? "Notifications, none unread" : `Notifications, ${countLabel(n, capped)} unread`;
  return (
    <div className="inbox-wrap" ref={wrap}>
      <button ref={bell} type="button" className="bell" aria-label={label} aria-expanded={open} aria-controls={panelId}
        onClick={() => { if (open) close(); else { setOpen(true); void qc.invalidateQueries({ queryKey: inboxKeys.all }); } }}>
        <Bell size={18} strokeWidth={1.8} aria-hidden="true" />
        {n > 0 && <span className="bell-count" aria-hidden="true">{countLabel(n, capped)}</span>}
      </button>
      <span className="sr-only" aria-live="polite">{announce}</span>
      {open && (
        <InboxPanel id={panelId} headingRef={heading} unread={n}
          onClose={() => close()}
          onOpen={(e) => { close(false); onOpen(e); }} canOpen={canOpen} />
      )}
    </div>
  );
}

function InboxPanel({ id, headingRef, unread, onClose, onOpen, canOpen }: {
  id: string;
  headingRef: React.RefObject<HTMLHeadingElement>;
  unread: number;
  onClose: () => void;
  onOpen: (entity: InboxItem["entity"]) => void;
  canOpen: (entity: InboxItem["entity"]) => boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const q = useInfiniteQuery({
    queryKey: inboxKeys.list,
    queryFn: ({ pageParam }) => api<InboxPage>(`/api/v1/notifications?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: inboxKeys.all });
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try { await fn(); await refresh(); } catch { setError("Could not update notifications. Try again."); } finally { setBusy(false); }
  };
  const mark = (item: InboxItem, read: boolean) => act(() => api(`/api/v1/notifications/${item.id}/${read ? "read" : "unread"}`, { method: "POST" }));
  // Only what the user has seen: the newest loaded entry bounds "mark all read".
  const markAll = () => act(() => api("/api/v1/notifications/read-all", {
    method: "POST", body: JSON.stringify(items[0] ? { before: items[0].createdAt } : {}),
  }));

  return (
    <section id={id} className="inbox" aria-labelledby={`${id}-h`}>
      <div className="inbox-head">
        <h2 id={`${id}-h`} ref={headingRef} tabIndex={-1}>Notifications</h2>
        <button type="button" className="btn sm" disabled={busy || unread === 0} onClick={() => void markAll()}>Mark all read</button>
        <button type="button" className="iconbtn inbox-close" aria-label="Close notifications" onClick={onClose}><X size={18} aria-hidden="true" /></button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {q.isLoading ? <Loading label="Loading notifications…" />
        : q.error ? <QueryError query={q} message="Could not load notifications." />
        : items.length === 0 ? <p className="muted inbox-empty">No notifications yet.</p>
        : (
          <ul className="inbox-list" aria-label="Notifications, newest first">
            {items.map((item) => {
              const Icon = ENTITY_ICONS[item.entity.type] ?? Bell;
              const label = item.readAt ? "Mark unread" : "Mark read";
              return (
                <li key={item.id} className={item.readAt ? "read" : "unread"}>
                  <span className="inbox-icon" aria-hidden="true"><Icon size={16} strokeWidth={1.8} /></span>
                  <div className="inbox-main">
                    <div className="inbox-title">
                      {!item.readAt && <span className="sr-only">Unread: </span>}
                      {canOpen(item.entity) ? (
                        <button type="button" className="inbox-open" onClick={() => {
                          if (!item.readAt) void mark(item, true);
                          onOpen(item.entity);
                        }}>{item.title}</button>
                      ) : <strong>{item.title}</strong>}
                    </div>
                    <p className="inbox-body">{item.body}</p>
                  </div>
                  <div className="inbox-side">
                    <time dateTime={item.createdAt} title={fmtDateTime(item.createdAt)}>{shortTime(item.createdAt)}</time>
                    <button type="button" className="iconbtn sm inbox-mark" disabled={busy} title={label}
                      aria-label={`${label}: ${item.title}`} onClick={() => void mark(item, !item.readAt)}>
                      {item.readAt ? <CircleDot size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      {q.hasNextPage && (
        <button type="button" className="btn sm inbox-more" disabled={q.isFetchingNextPage} aria-busy={q.isFetchingNextPage || undefined}
          onClick={() => void q.fetchNextPage()}>Show older notifications</button>
      )}
    </section>
  );
}
