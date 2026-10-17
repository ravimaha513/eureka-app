import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CHAT_POLL } from "@eureka/shared";
import { chatApi, chatKeys, errorStatus, pollDelay } from "./chatApi";
import "./chat.css";

// Kept apart from ChatPage so the sidebar badge does not pull the chat screen into the main bundle.

/** True while the tab is hidden (polling backs off; design A7). */
export function useHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

/** Unread chat messages for the navigation badge (polled; slower in a hidden tab). */
export function useChatUnread(enabled: boolean) {
  const hidden = useHidden();
  return useQuery({
    queryKey: chatKeys.unread,
    queryFn: chatApi.unread,
    enabled,
    refetchInterval: (query) => pollDelay(hidden ? CHAT_POLL.badgeHiddenMs : CHAT_POLL.badgeMs, query.state.fetchFailureCount, errorStatus(query.state.error)) || false,
    refetchIntervalInBackground: true,
  });
}

export const countLabel = (n: number, capped = false) => (capped || n > 99 ? "99+" : String(n));

/**
 * The count next to "Chat" in the sidebar. `badge` is the visible number
 * (hidden from assistive technology, inside the nav button); `text` is the
 * sentence that describes the button (outside it, so its name stays "Chat").
 */
export function ChatNavBadge({ id, part }: { id: string; part: "badge" | "text" }) {
  const q = useChatUnread(true);
  const n = q.data?.unread ?? 0;
  if (part === "badge") return n > 0 ? <span className="navbadge" aria-hidden="true">{countLabel(n, q.data?.capped)}</span> : null;
  return <span id={id} className="sr-only">{n > 0 ? `${countLabel(n, q.data?.capped)} unread chat messages` : "No unread chat messages"}</span>;
}
