import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Archive, BellOff, FileText, LogOut, MoreVertical, Paperclip, Pencil, Plus, Search, SendHorizontal, Star, Trash2,
  UserPlus, Users, X,
} from "lucide-react";
import { CHAT_BODY_MAX, CHAT_FILTERS, CHAT_NAME_MAX, CHAT_POLL, chatFileName, type ChatFilter } from "@eureka/shared";
import type { Me } from "../api";
import { ConfirmDialog } from "../admin/Dialog";
import { documentFileProblem, documentTypeOf } from "../documents/documentsApi";
import { browser, postToStorage } from "../sales/resumesApi";
import { Drawer } from "../sales/ui";
import { Avatar } from "../shell/ui";
import {
  MAX_ATTACHMENTS, attachmentState, chatApi, chatError, chatKeys, mergeMessages,
  type ConversationDetail, type ConversationSummary, type Member, type Message, type Person,
} from "./chatApi";
import { Linkified } from "./linkify";
import "./chat.css";

const FILTER_LABELS: Record<ChatFilter, string> = {
  all: "All Messages", unread: "Unread", group: "Group", favorite: "Favorite", archived: "Archived",
};

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
    refetchInterval: hidden ? CHAT_POLL.badgeHiddenMs : CHAT_POLL.badgeMs,
    refetchIntervalInBackground: true,
  });
}

const countLabel = (n: number, capped = false) => (capped || n > 99 ? "99+" : String(n));

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

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayKey = (iso: string) => new Date(iso).toDateString();
function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}
function shortWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString() ? time(iso) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const newClientId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)));

export function ChatPage({ me, initialConversationId = null }: { me: Me; initialConversationId?: string | null }) {
  const [selected, setSelected] = useState<string | null>(initialConversationId);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const hidden = useHidden();
  const qc = useQueryClient();
  const term = search.trim();

  useEffect(() => { if (initialConversationId) setSelected(initialConversationId); }, [initialConversationId]);

  const list = useQuery({
    queryKey: chatKeys.list(filter, term),
    queryFn: () => chatApi.list(filter, term),
    refetchInterval: hidden ? CHAT_POLL.listHiddenMs : CHAT_POLL.listMs,
    refetchIntervalInBackground: true,
  });
  const people = useQuery({
    queryKey: chatKeys.people(term),
    queryFn: () => chatApi.people(term),
    enabled: term.length > 0,
  });

  const refreshLists = useCallback(() => {
    void qc.invalidateQueries({ queryKey: chatKeys.lists });
    void qc.invalidateQueries({ queryKey: chatKeys.unread });
  }, [qc]);

  const startDirect = async (p: Person) => {
    try {
      const c = await chatApi.openDirect(p.id);
      setSearch("");
      setSelected(c.id);
      refreshLists();
    } catch (e) { setNotice(chatError(e)); }
  };

  const items = list.data?.items ?? [];
  const matchingPeople = (people.data?.items ?? []).filter((p) => !items.some((c) => c.counterpart?.id === p.id));

  return (
    <div className="chatpage">
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Chat</h1>
          <p className="sub">Message your colleagues directly or in groups.</p>
        </div>
        <span className="push presence-me"><span className="dot on" aria-hidden="true" />Online</span>
      </div>
      {notice && <p className="error" role="alert">{notice}</p>}
      <div className={`chat card${selected ? " has-conv" : ""}`}>
        <section className="chat-list" aria-label="Conversations">
          <div className="chat-searchrow">
            <label className="chat-search">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search chats and people</span>
              <input type="search" value={search} placeholder="Search users…" onChange={(e) => setSearch(e.target.value)} />
            </label>
            <button type="button" className="iconbtn chat-new" aria-label="Create group chat" onClick={() => setCreating(true)}>
              <Plus size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="chat-filters" role="group" aria-label="Show">
            {CHAT_FILTERS.map((f) => (
              <button key={f} type="button" className="tab sm" aria-pressed={filter === f} onClick={() => setFilter(f)}>{FILTER_LABELS[f]}</button>
            ))}
          </div>
          {list.isLoading ? <p className="muted chat-pad">Loading…</p>
            : list.error ? <p className="error chat-pad" role="alert">Could not load conversations.</p>
            : (
              <>
                {items.length === 0 && term === "" && (
                  <p className="muted chat-pad">{filter === "all" ? "No conversations yet. Search for a colleague to start one." : "Nothing here."}</p>
                )}
                {items.length > 0 && (
                  <ul className="chat-convs">
                    {items.map((c) => (
                      <ConversationRow key={c.id} c={c} active={c.id === selected} onOpen={() => setSelected(c.id)} />
                    ))}
                  </ul>
                )}
                {term !== "" && (
                  <div className="chat-people">
                    <h2 className="chat-subhead">People</h2>
                    {people.isLoading ? <p className="muted chat-pad">Searching…</p>
                      : matchingPeople.length === 0 ? <p className="muted chat-pad">{items.length ? "No one else matches." : "No one matches."}</p>
                      : (
                        <ul className="chat-convs">
                          {matchingPeople.map((p) => (
                            <li key={p.id}>
                              <button type="button" className="chat-conv" onClick={() => void startDirect(p)} aria-label={`Start a chat with ${p.name}`}>
                                <PresenceAvatar name={p.name} online={p.online} />
                                <span className="chat-conv-text"><b>{p.name}</b><small>{p.designation ?? " "}</small></span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                  </div>
                )}
              </>
            )}
        </section>
        <section className="chat-view" aria-label="Conversation">
          {selected
            ? <ConversationView key={selected} id={selected} meId={me.id} onBack={() => setSelected(null)}
                onGone={(msg) => { setSelected(null); setNotice(msg); refreshLists(); }} onChanged={refreshLists} />
            : <p className="empty">Choose a conversation, or search for a colleague to start one.</p>}
        </section>
      </div>
      {creating && (
        <CreateGroupPanel onClose={() => setCreating(false)}
          onCreated={(c) => { setCreating(false); setSelected(c.id); refreshLists(); }} />
      )}
    </div>
  );
}

function PresenceAvatar({ name, online }: { name: string | null; online?: boolean }) {
  return (
    <span className="chat-avatar">
      <Avatar name={name} />
      {online !== undefined && <span className={`dot ${online ? "on" : "off"}`} aria-hidden="true" />}
    </span>
  );
}

function ConversationRow({ c, active, onOpen }: { c: ConversationSummary; active: boolean; onOpen: () => void }) {
  const title = c.title ?? "Unknown user";
  const status = [
    c.counterpart ? (c.counterpart.online ? "online" : "offline") : `${c.memberCount} members`,
    c.unread > 0 ? `${countLabel(c.unread, c.unreadCapped)} unread` : null,
    c.favorite ? "favorite" : null,
    c.muted ? "muted" : null,
  ].filter(Boolean).join(", ");
  return (
    <li>
      <button type="button" className={`chat-conv${c.unread > 0 ? " unread" : ""}`} aria-current={active ? "true" : undefined} onClick={onOpen}
        aria-label={`${title}, ${status}`}>
        {c.kind === "group"
          ? <span className="chat-avatar"><span className="avatar md tint-violet chat-groupicon"><Users size={16} aria-hidden="true" /></span></span>
          : <PresenceAvatar name={title} online={c.counterpart?.online} />}
        <span className="chat-conv-text">
          <b>{title}</b>
          <small>{c.lastMessage ? `${c.lastMessage.mine ? "You: " : c.kind === "group" && c.lastMessage.sender.name ? `${c.lastMessage.sender.name}: ` : ""}${c.lastMessage.preview ?? ""}` : "No messages yet"}</small>
        </span>
        <span className="chat-conv-meta" aria-hidden="true">
          {c.lastMessage && <small>{shortWhen(c.lastMessage.createdAt)}</small>}
          <span className="chat-conv-flags">
            {c.favorite && <Star size={12} />}
            {c.muted && <BellOff size={12} />}
            {c.unread > 0 && <span className="chat-unread">{countLabel(c.unread, c.unreadCapped)}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The open conversation: newest page first, then polls `after=<cursor>`
 * every 4 s (30 s in a hidden tab). New messages from others are announced
 * in a polite live region and marked read while the tab is visible; the view
 * is also refreshed at least once a minute while open, so a direct message
 * does not notify someone who is looking at it.
 */
function ConversationView({ id, meId, onBack, onGone, onChanged }: {
  id: string; meId: string; onBack: () => void; onGone: (message: string) => void; onChanged: () => void;
}) {
  const qc = useQueryClient();
  const hidden = useHidden();
  const detail = useQuery({ queryKey: chatKeys.detail(id), queryFn: () => chatApi.get(id), refetchInterval: hidden ? false : 30_000 });
  const [messages, setMessages] = useState<Message[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [announce, setAnnounce] = useState("");
  const [membersOpen, setMembersOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "delete" | "leave">(null);
  const [deleting, setDeleting] = useState<Message | null>(null);
  const cursor = useRef<number | null>(null);
  const lastMark = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  // Callbacks from the parent change on every render; the polling effects must not restart for that.
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  const gone = useCallback((e: unknown) => {
    if ((e as { status?: number }).status === 404) { onGoneRef.current("That conversation is no longer available to you."); return true; }
    return false;
  }, []);

  const markRead = useCallback(async (msgs: readonly Message[]) => {
    const last = msgs[msgs.length - 1];
    lastMark.current = Date.now();
    try {
      await chatApi.markRead(id, last?.id);
      void qc.invalidateQueries({ queryKey: chatKeys.unread });
      void qc.invalidateQueries({ queryKey: chatKeys.lists });
    } catch { /* the next poll retries */ }
  }, [id, qc]);

  // First page, then the read mark.
  useEffect(() => {
    let live = true;
    chatApi.latest(id).then((p) => {
      if (!live) return;
      setMessages(p.items);
      setOlder(p.nextCursor);
      cursor.current = p.cursor;
      setLoaded(true);
      if (!hiddenRef.current) void markRead(p.items);
    }).catch((e) => { if (live && !gone(e)) setError(chatError(e, "Could not load messages.")); });
    return () => { live = false; };
  }, [id, gone, markRead]);

  // Polling for changes since the cursor.
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!live || cursor.current === null) return;
      let again = false;
      try {
        const r = await chatApi.changes(id, cursor.current);
        if (!live) return;
        cursor.current = r.cursor;
        again = r.more;
        if (r.items.length) {
          const known = new Set(messagesRef.current.map((m) => m.id));
          const fresh = r.items.filter((m) => !m.mine && !known.has(m.id) && !m.deleted);
          if (fresh.length === 1) {
            const m = fresh[0]!;
            setAnnounce(`New message from ${m.sender.name ?? "someone"}: ${m.body.slice(0, 140) || "attachment"}`);
          } else if (fresh.length > 1) setAnnounce(`${fresh.length} new messages`);
          messagesRef.current = mergeMessages(messagesRef.current, r.items);
          setMessages(messagesRef.current);
        }
        const incoming = r.items.some((m) => !m.mine);
        if (!hiddenRef.current && (incoming || Date.now() - lastMark.current > 60_000)) void markRead(messagesRef.current);
        setError("");
      } catch (e) {
        if (!live) return;
        if (gone(e)) return;
        setError("Connection problem. Retrying…");
      }
      timer = setTimeout(poll, again ? 0 : hiddenRef.current ? CHAT_POLL.conversationHiddenMs : CHAT_POLL.conversationMs);
    };
    timer = setTimeout(poll, hiddenRef.current ? CHAT_POLL.conversationHiddenMs : CHAT_POLL.conversationMs);
    return () => { live = false; clearTimeout(timer); };
  }, [id, loaded, gone, markRead]);

  // Coming back to the tab: catch up and mark read at once.
  const wasHidden = useRef(hidden);
  useEffect(() => {
    const was = wasHidden.current;
    wasHidden.current = hidden;
    if (was && !hidden && loaded && cursor.current !== null) void chatApi.changes(id, cursor.current).then((r) => {
      cursor.current = Math.max(cursor.current ?? 0, r.cursor);
      messagesRef.current = mergeMessages(messagesRef.current, r.items);
      setMessages(messagesRef.current);
      void markRead(messagesRef.current);
    }).catch(() => undefined);
  }, [hidden, loaded, id, markRead]);

  // Keep the newest message in view unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const loadOlder = async () => {
    if (!older) return;
    try {
      const p = await chatApi.older(id, older);
      stick.current = false;
      setMessages((cur) => mergeMessages(cur, p.items));
      setOlder(p.nextCursor);
    } catch (e) { if (!gone(e)) setError(chatError(e)); }
  };

  const d = detail.data;
  const title = d?.title ?? "Conversation";
  const counterpart = d?.kind === "direct" ? d.members.find((m) => !m.me) : undefined;
  const setPref = async (p: Partial<Pick<ConversationDetail, "archived" | "favorite" | "muted">>) => {
    try {
      await chatApi.preferences(id, p);
      await qc.invalidateQueries({ queryKey: chatKeys.detail(id) });
      onChanged();
    } catch (e) { if (!gone(e)) setError(chatError(e)); }
  };

  return (
    <div className="chat-conversation">
      <header className="chat-head">
        <button type="button" className="iconbtn chat-back" aria-label="Back to conversations" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" /></button>
        {d?.kind === "group"
          ? <span className="chat-avatar"><span className="avatar md tint-violet chat-groupicon"><Users size={16} aria-hidden="true" /></span></span>
          : <PresenceAvatar name={title} online={counterpart?.online} />}
        <div className="chat-head-text">
          <h2>{title}</h2>
          <small>
            {d?.kind === "group" ? `${d.members.length} members`
              : counterpart ? [counterpart.designation, counterpart.online ? "Online" : "Offline"].filter(Boolean).join(" · ") : " "}
          </small>
        </div>
        {d && (
          <div className="chat-head-actions">
            {d.kind === "group" && (
              <button type="button" className="iconbtn" aria-label="Members" onClick={() => setMembersOpen(true)}><Users size={18} aria-hidden="true" /></button>
            )}
            <ConversationMenu d={d} onPref={setPref} onLeave={() => setConfirm("leave")} onDelete={() => setConfirm("delete")} />
          </div>
        )}
      </header>
      {error && <p className="error chat-pad" role="alert">{error}</p>}
      <span className="sr-only" role="status" aria-live="polite">{announce}</span>
      <ol ref={listRef} className="chat-messages" aria-label={`Messages with ${title}`}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {older && (
          <li className="chat-older"><button type="button" className="btn sm" onClick={() => void loadOlder()}>Load earlier messages</button></li>
        )}
        {!loaded && !error && <li className="muted chat-pad">Loading…</li>}
        {loaded && messages.length === 0 && <li className="muted chat-pad">No messages yet. Say hello.</li>}
        {messages.map((m, i) => (
          <MessageItem key={m.id} m={m} group={d?.kind === "group"} separator={i === 0 || dayKey(messages[i - 1]!.createdAt) !== dayKey(m.createdAt)}
            onEdited={(next) => setMessages((cur) => mergeMessages(cur, [next]))} onDelete={() => setDeleting(m)} onError={setError} />
        ))}
      </ol>
      <Composer conversationId={id} disabled={!loaded}
        onSent={(m) => { stick.current = true; setMessages((cur) => mergeMessages(cur, [m])); onChanged(); }}
        onGone={(e) => gone(e)} />
      {membersOpen && d && (
        <MembersPanel d={d} meId={meId} onClose={() => setMembersOpen(false)}
          onChanged={() => { void qc.invalidateQueries({ queryKey: chatKeys.detail(id) }); onChanged(); }} onGone={gone} />
      )}
      {confirm && d && (
        <ConfirmDialog
          title={confirm === "leave" ? "Leave group?" : d.kind === "direct" ? "Delete chat?" : "Delete group for everyone?"}
          confirmLabel={confirm === "leave" ? "Leave group" : "Delete chat"} danger
          action={() => (confirm === "leave" ? chatApi.leave(id) : chatApi.remove(id))}
          onClose={() => setConfirm(null)}
          onDone={() => { setConfirm(null); onGone(confirm === "leave" ? "You left the group." : "Chat deleted."); }}
          formatError={(e) => chatError(e)}>
          <p>{confirm === "leave" ? "You will no longer see this group or its messages."
            : d.kind === "direct" ? "The chat and its messages so far are removed from your list. The other person keeps their copy."
            : "The group and its messages are removed for every member."}</p>
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog title="Delete message?" confirmLabel="Delete message" danger
          action={() => chatApi.deleteMessage(deleting.id)} onClose={() => setDeleting(null)}
          onDone={() => {
            setMessages((cur) => mergeMessages(cur, [{ ...deleting, body: "", deleted: true, attachments: [], rev: deleting.rev + 0.5 }]));
            setDeleting(null);
            onChanged();
          }}
          formatError={(e) => chatError(e)}>
          <p>Everyone in the conversation will see “Message deleted”.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** The ⋮ menu: favorite, archive, mute, leave, delete. A disclosure; Escape closes it. */
function ConversationMenu({ d, onPref, onLeave, onDelete }: {
  d: ConversationDetail; onPref: (p: Partial<Pick<ConversationDetail, "archived" | "favorite" | "muted">>) => void;
  onLeave: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>(".chat-menu button")?.focus();
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const act = (fn: () => void) => { setOpen(false); btn.current?.focus(); fn(); };
  const canDelete = d.kind === "direct" || d.canManage;
  return (
    <div className="chat-menuwrap" ref={wrap}>
      <button ref={btn} type="button" className="iconbtn" aria-label="Conversation options" aria-expanded={open} aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}><MoreVertical size={18} aria-hidden="true" /></button>
      {open && (
        <div id={menuId} className="chat-menu">
          <button type="button" onClick={() => act(() => onPref({ favorite: !d.favorite }))}><Star size={15} aria-hidden="true" />{d.favorite ? "Remove from favorites" : "Add to favorites"}</button>
          <button type="button" onClick={() => act(() => onPref({ archived: !d.archived }))}><Archive size={15} aria-hidden="true" />{d.archived ? "Unarchive" : "Archive"}</button>
          <button type="button" onClick={() => act(() => onPref({ muted: !d.muted }))}><BellOff size={15} aria-hidden="true" />{d.muted ? "Unmute" : "Mute"}</button>
          {d.kind === "group" && <button type="button" onClick={() => act(onLeave)}><LogOut size={15} aria-hidden="true" />Leave group</button>}
          {canDelete && <button type="button" className="danger" onClick={() => act(onDelete)}><Trash2 size={15} aria-hidden="true" />Delete chat</button>}
        </div>
      )}
    </div>
  );
}

function MessageItem({ m, group, separator, onEdited, onDelete, onError }: {
  m: Message; group: boolean; separator: boolean; onEdited: (m: Message) => void; onDelete: () => void; onError: (s: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [busy, setBusy] = useState(false);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try { onEdited(await chatApi.edit(m.id, draft)); setEditing(false); } catch (err) { onError(chatError(err)); } finally { setBusy(false); }
  };
  const who = m.mine ? "You" : m.sender.name ?? "Unknown user";
  return (
    <>
      {separator && <li className="chat-day"><span>{dayLabel(m.createdAt)}</span></li>}
      <li className={`chat-msg ${m.mine ? "mine" : "theirs"}`}>
        <div className="chat-bubble">
          {(group || !m.mine) && <span className={group && !m.mine ? "chat-sender" : "sr-only"}>{who}</span>}
          {m.mine && !group && <span className="sr-only">You</span>}
          {m.deleted ? <p className="chat-deleted">Message deleted</p>
            : editing ? (
              <form className="chat-edit" onSubmit={(e) => void save(e)}>
                <label className="sr-only" htmlFor={`edit-${m.id}`}>Edit message</label>
                <textarea id={`edit-${m.id}`} value={draft} maxLength={CHAT_BODY_MAX} rows={2} autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditing(false); setDraft(m.body); }
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
                  }} />
                <div className="chat-edit-actions">
                  <button type="button" className="btn sm" onClick={() => { setEditing(false); setDraft(m.body); }}>Cancel</button>
                  <button type="submit" className="btn sm primary" disabled={busy}>Save</button>
                </div>
              </form>
            ) : m.body !== "" && <p className="chat-body"><Linkified text={m.body} /></p>}
          {!m.deleted && m.attachments.length > 0 && (
            <ul className="chat-files" aria-label="Attachments">
              {m.attachments.map((a) => <AttachmentChip key={a.id} a={a} onError={onError} />)}
            </ul>
          )}
          <span className="chat-meta">
            <time dateTime={m.createdAt}>{time(m.createdAt)}</time>{m.editedAt && !m.deleted ? " · edited" : ""}
          </span>
        </div>
        {m.mine && !m.deleted && !editing && (
          <div className="chat-msg-actions">
            <button type="button" className="iconbtn sm" aria-label={`Edit your message sent at ${time(m.createdAt)}`}
              onClick={() => { setDraft(m.body); setEditing(true); }}><Pencil size={14} aria-hidden="true" /></button>
            <button type="button" className="iconbtn sm" aria-label={`Delete your message sent at ${time(m.createdAt)}`} onClick={onDelete}>
              <Trash2 size={14} aria-hidden="true" /></button>
          </div>
        )}
      </li>
    </>
  );
}

function AttachmentChip({ a, onError }: { a: Message["attachments"][number]; onError: (s: string) => void }) {
  const s = attachmentState(a);
  const open = async () => {
    try { browser.download((await chatApi.downloadLink(a.id)).url); } catch (e) { onError(chatError(e)); }
  };
  return (
    <li className={`chat-file${s.ready ? "" : " wait"}`}>
      {s.ready ? (
        <button type="button" className="chat-file-btn" onClick={() => void open()} aria-label={`Download ${a.fileName}, ${s.label}`}>
          <FileText size={15} aria-hidden="true" /><span className="chat-file-name">{a.fileName}</span><small>{s.label}</small>
        </button>
      ) : (
        <span className="chat-file-btn"><FileText size={15} aria-hidden="true" /><span className="chat-file-name">{a.fileName}</span><small>{s.label}</small></span>
      )}
    </li>
  );
}

/**
 * Message box: Enter sends, Shift+Enter adds a line. Files go to the
 * presigned targets after the message is accepted; a failed send keeps the
 * text and reuses its client id, so a retry never posts twice.
 */
function Composer({ conversationId, disabled, onSent, onGone }: {
  conversationId: string; disabled: boolean; onSent: (m: Message) => void; onGone: (e: unknown) => boolean;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clientId = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const addFiles = (list: FileList | null) => {
    const picked = [...(list ?? [])];
    const problem = picked.map((f) => documentFileProblem(f)).find(Boolean);
    if (problem) { setError(problem); return; }
    if (files.length + picked.length > MAX_ATTACHMENTS) { setError(`Attach at most ${MAX_ATTACHMENTS} files to one message.`); return; }
    setError("");
    clientId.current = null;
    setFiles((cur) => [...cur, ...picked]);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || (text.trim() === "" && files.length === 0)) return;
    setBusy(true);
    setError("");
    clientId.current ??= newClientId();
    try {
      const r = await chatApi.send(conversationId, clientId.current, text,
        files.map((f) => ({ fileName: chatFileName(f.name) ?? "file", contentType: documentTypeOf(f)!, size: f.size })));
      const failed: string[] = [];
      for (const u of r.uploads) {
        const i = r.message.attachments.findIndex((a) => a.id === u.attachmentId);
        const file = files[i];
        if (!file) continue;
        try { await postToStorage(u.upload, file); } catch { failed.push(file.name); }
      }
      clientId.current = null;
      setText("");
      setFiles([]);
      onSent(r.message);
      if (failed.length) setError(`Could not upload ${failed.join(", ")}. Send the file again.`);
    } catch (err) {
      if (!onGone(err)) setError(chatError(err, "Message not sent. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };
  const left = CHAT_BODY_MAX - text.length;
  return (
    <form className="chat-composer" onSubmit={(e) => void submit(e)}>
      {error && <p className="error" role="alert">{error}</p>}
      {files.length > 0 && (
        <ul className="chat-files pending" aria-label="Files to send">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="chat-file">
              <span className="chat-file-btn"><FileText size={15} aria-hidden="true" /><span className="chat-file-name">{f.name}</span></span>
              <button type="button" className="chipx" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                <X size={13} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="chat-composer-row">
        <label htmlFor={inputId} className="sr-only">Message</label>
        <textarea id={inputId} value={text} rows={1} maxLength={CHAT_BODY_MAX} placeholder="Write a message…" disabled={disabled}
          aria-describedby={left < 200 ? `${inputId}-left` : undefined}
          onChange={(e) => { setText(e.target.value); clientId.current = null; }} onKeyDown={onKeyDown} />
        <input ref={fileInput} type="file" multiple hidden accept=".pdf,.docx,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" className="iconbtn" aria-label="Attach files" disabled={disabled || busy} onClick={() => fileInput.current?.click()}>
          <Paperclip size={18} aria-hidden="true" /></button>
        <button type="submit" className="iconbtn chat-send" aria-label="Send message" disabled={disabled || busy || (text.trim() === "" && files.length === 0)}
          aria-busy={busy || undefined}><SendHorizontal size={18} aria-hidden="true" /></button>
      </div>
      {left < 200 && <small id={`${inputId}-left`} className="hint">{left} characters left</small>}
    </form>
  );
}

/** Search and pick colleagues (name and designation only). */
function PeoplePicker({ label, exclude, picked, onToggle }: {
  label: string; exclude: ReadonlySet<string>; picked: readonly Person[]; onToggle: (p: Person) => void;
}) {
  const [q, setQ] = useState("");
  const id = useId();
  const term = q.trim();
  const people = useQuery({ queryKey: chatKeys.people(term), queryFn: () => chatApi.people(term) });
  const pickedIds = new Set(picked.map((p) => p.id));
  const options = (people.data?.items ?? []).filter((p) => !exclude.has(p.id));
  return (
    <div className="chat-picker">
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input id={id} type="search" value={q} placeholder="Search users to add…" onChange={(e) => setQ(e.target.value)} />
      </div>
      {picked.length > 0 && (
        <ul className="chips" aria-label="Selected">
          {picked.map((p) => (
            <li key={p.id} className="chip">{p.name}
              <button type="button" className="chipx" aria-label={`Remove ${p.name}`} onClick={() => onToggle(p)}><X size={12} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      {people.isLoading ? <p className="muted">Searching…</p>
        : options.length === 0 ? <p className="muted">No one matches.</p>
        : (
          <ul className="chat-pickerlist">
            {options.map((p) => (
              <li key={p.id}>
                <label className="check">
                  <input type="checkbox" checked={pickedIds.has(p.id)} onChange={() => onToggle(p)} />
                  <span><b>{p.name}</b>{p.designation && <small> · {p.designation}</small>}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

function CreateGroupPanel({ onClose, onCreated }: { onClose: () => void; onCreated: (c: ConversationDetail) => void }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameId = useId();
  const toggle = (p: Person) => setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : [...cur, p]));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === "") { setError("Enter a group name."); return; }
    if (picked.length === 0) { setError("Add at least one member."); return; }
    setBusy(true);
    setError("");
    try { onCreated(await chatApi.createGroup(name.trim(), picked.map((p) => p.id))); } catch (err) { setError(chatError(err)); } finally { setBusy(false); }
  };
  const none = useMemo(() => new Set<string>(), []);
  return (
    <Drawer title="Create Group Chat" onClose={onClose} closeLabel="Close">
      <form className="chat-panel" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor={nameId}>Group Name</label>
          <input id={nameId} data-autofocus value={name} maxLength={CHAT_NAME_MAX} onChange={(e) => setName(e.target.value)} />
        </div>
        <PeoplePicker label="Add Members" exclude={none} picked={picked} onToggle={toggle} />
        {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy} aria-busy={busy || undefined}>{busy ? "Working…" : "Create Group"}</button>
        </div>
      </form>
    </Drawer>
  );
}

function MembersPanel({ d, meId, onClose, onChanged, onGone }: {
  d: ConversationDetail; meId: string; onClose: () => void; onChanged: () => void; onGone: (e: unknown) => boolean;
}) {
  const [name, setName] = useState(d.name ?? "");
  const [adding, setAdding] = useState<Person[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try { await fn(); onChanged(); } catch (e) { if (!onGone(e)) setError(chatError(e)); } finally { setBusy(false); }
  };
  const current = useMemo(() => new Set(d.members.map((m) => m.id)), [d.members]);
  const toggle = (p: Person) => setAdding((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : [...cur, p]));
  return (
    <Drawer title={`Members of ${d.title ?? "the group"}`} onClose={onClose} closeLabel="Close members">
      <div className="chat-panel">
        {error && <p className="error" role="alert">{error}</p>}
        {d.canManage && (
          <form className="chat-rename" onSubmit={(e) => { e.preventDefault(); void run(() => chatApi.rename(d.id, name.trim(), d.rowVersion)); }}>
            <div className="field">
              <label htmlFor={nameId}>Group Name</label>
              <input id={nameId} value={name} maxLength={CHAT_NAME_MAX} onChange={(e) => setName(e.target.value)} />
            </div>
            <button type="submit" className="btn" disabled={busy || name.trim() === "" || name.trim() === d.name}>Rename</button>
          </form>
        )}
        <ul className="chat-members" aria-label="Members">
          {d.members.map((m) => <MemberRow key={m.id} m={m} canManage={d.canManage} self={m.id === meId} busy={busy}
            onRemove={() => void run(() => chatApi.removeMember(d.id, m.id))}
            onRole={(role) => void run(() => chatApi.setRole(d.id, m.id, role))} />)}
        </ul>
        {d.canManage && (
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await chatApi.addMembers(d.id, adding.map((p) => p.id)); setAdding([]); }); }}>
            <PeoplePicker label="Add Members" exclude={current} picked={adding} onToggle={toggle} />
            <button type="submit" className="btn primary" disabled={busy || adding.length === 0}><UserPlus size={15} aria-hidden="true" />Add to group</button>
          </form>
        )}
      </div>
    </Drawer>
  );
}

function MemberRow({ m, canManage, self, busy, onRemove, onRole }: {
  m: Member; canManage: boolean; self: boolean; busy: boolean; onRemove: () => void; onRole: (r: "owner" | "member") => void;
}) {
  return (
    <li className="chat-member">
      <PresenceAvatar name={m.name} online={m.online} />
      <span className="chat-conv-text">
        <b>{m.name}{self ? " (you)" : ""}</b>
        <small>{[m.designation, m.role === "owner" ? "Owner" : null, m.online ? "Online" : "Offline"].filter(Boolean).join(" · ")}</small>
      </span>
      {canManage && !self && (
        <span className="chat-member-actions">
          <button type="button" className="btn sm" disabled={busy} onClick={() => onRole(m.role === "owner" ? "member" : "owner")}>
            {m.role === "owner" ? "Make member" : "Make owner"}</button>
          <button type="button" className="btn sm danger" disabled={busy} aria-label={`Remove ${m.name} from the group`} onClick={onRemove}>Remove</button>
        </span>
      )}
    </li>
  );
}
