# Chat — `/chat`, `/chat/<conversationId>`
Status: Audited · Redesign proposed
Who / permission: `chat:use` (nav.ts:50) — every role measured (ceo, r1a, l1, m1, locD, hr, acct, imm, coach, admin). Group rename/members/delete need `canManage` on the conversation.
Source: `apps/web/src/chat/ChatPage.tsx` (775 lines: ChatPage, ConversationRow, ConversationView, ConversationMenu, MessageItem, AttachmentChip, Composer, PeoplePicker, CreateGroupPanel, MembersPanel), `chatApi.ts`, `ChatNavBadge.tsx`, `linkify.tsx`, `chat/chat.css` (107 lines), `Drawer` from `sales/ui.tsx`
Evidence: existing `chat-desktop.png`, `chat-mobile.png` (empty state); new `chat-conversation-desktop.png`, `chat-conversation-mobile.png`, `chat-list-mobile.png`, `chat-menu-desktop.png`, `chat-hover-actions-desktop.png`, `chat-create-group-desktop.png`. Test conversation ceo ↔ r1a (3 messages, one with a link) created in the local dev DB for the capture.

## Primary objective
Send a quick message to a colleague or group about a candidate/interview, see replies arrive, and find the conversation again — without leaving the work context for long.

## What's on screen
- Page header: h1 "Chat" + sub + self presence "● Online" (always on, ChatPage.tsx:97).
- Card with two panes (desktop): list 260–340px — search (placeholder "Search users…"), "+" create group (iconbtn), 5 filter pills (All Messages, Unread, Group, Favorite, Archived) wrapping to 2 rows, conversation rows (avatar+presence dot, name, last-message preview, time, star/mute/unread flags), "People" results when searching. Conversation pane — header (back on phone, avatar, name, designation · Online, Members (groups), ⋮ menu with 5 actions), day separators, bubbles (mine = tinted right), hover edit/delete icons on own messages, composer (textarea rows=1 + Attach + Send).
- Pane height `calc(100vh - 220px)` desktop, `calc(100dvh - 190px)` phone (chat.css:6,98); phone shows list *or* conversation.
- Create group: right Drawer — Group Name, Add Members search + checkbox list, Cancel / Create Group.
- Polling: list, badge, open conversation every 4s (30s hidden).

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | People-picker rows in Create group / Add members are ~20px tall native checkboxes (13px box) stacked with 2px gap (ChatPage.tsx:659-664, chat.css:89) — below the 24px target minimum (WCAG 2.5.8) and hard to hit on touch; picked-chip remove "×" and pending-attachment remove are 18px `.chipx` (ChatPage.tsx:649, ~606) | A11y | High |
| 2 | Search field says "Search users…" but it filters **conversations** (incl. groups) and lists people (ChatPage.tsx:105-106, label "Search chats and people"); the visible placeholder hides the main use (finding an existing group). Placeholder ≠ label also breaks the visible-label match for voice users | Cognitive | Medium |
| 3 | Phone: page h1 + sub + "Online" + card border consume ~170px above the conversation header; with the 60px top bar, the message list gets ~430px of 844 (`chat-conversation-mobile.png`). Height is a magic `100dvh - 190px` that breaks if the sub wraps to 2 lines (it does at 390) or the offline banner appears | Responsive | Medium |
| 4 | Self presence "● Online" is hard-coded (ChatPage.tsx:97) — there is no away/offline state for the user, so it carries no information but takes a header slot (wraps to its own line on phone) | Cognitive | Low |
| 5 | Filters are 5 pill toggles with `aria-pressed` that wrap to 2 rows in the 340px list column (`chat-desktop.png`); "All Messages" vs others mixes scopes (Archived is a folder, Unread/Favorite are filters) | Visual | Low |
| 6 | Create group drawer uses Title Case ("Create Group Chat", "Group Name", "Add Members", "Create Group", ChatPage.tsx:689-699) while the rest of the app uses sentence case ("New candidate", "Mark all read") | Consistency | Low |
| 7 | Own-message edit/delete icons are hidden until hover/focus on desktop (chat.css:64-65) — discoverable for keyboard via focus-within (good); on phone they are always visible 28×28 next to every own bubble (`chat-conversation-mobile.png`), adding noise to every message and under the 44px touch guideline | Visual | Low |
| 8 | Conversation-level states are plain text "Loading…", "Could not load conversations." with no Retry (ChatPage.tsx:117-118, 385) instead of `Loading`/`QueryError` | Consistency | Medium |
| 9 | ⋮ menu is the third hand-rolled disclosure (ChatPage.tsx:429-463) — closes on outside click and Escape and moves focus in (good), but has no arrow-key navigation and duplicates UserMenu logic | Consistency | Low |
| 10 | chat.css is global (imported by `ChatNavBadge`, which the shell loads) and redefines app-wide classes: `.iconbtn.sm` 28px (chat.css:66 vs styles.css:615 30px) and `.dot` 9px with `--faint` background (chat.css:4 vs styles.css:1114 8px) — chat styling leaks into every screen | Consistency | Medium |
| 11 | Disabled Send is `opacity .5` primary (chat.css:84) — on an empty composer it looks like a faded brand blob; fine functionally | Visual | Low |
| 12 | Desktop pane height `100vh - 220px` leaves ~60px of dead page below the card at 900px and doesn't adapt to taller headers (`chat-conversation-desktop.png`) | Visual | Low |

## Recommended redesign
### Desktop
- Drop the page sub and self "Online"; put h1 and the "+ New group" button on one row; make the chat card fill the remaining height with flex (`.content` → `display:flex` column, card `flex:1; min-height:0`) instead of `calc()` magic numbers.
- Search placeholder "Search chats or people"; keep the sr-only label identical.
- Filters: a 3-option segmented control (`.tabs.seg`: All · Unread · Favorites) + "Group" and "Archived" as a small select or overflow menu → one row.
- Picker: 40px rows with full-row label (avatar + name + designation), 18px checkbox; remove chips get 24px hit area.
- Sentence case in group drawer.
### Mobile
- No page header when a conversation is open: conversation header (back, name, ⋮) sits directly under the top bar; composer pinned to bottom with `env(safe-area-inset-bottom)`. Message list gains ~170px.
- Own-message actions via long-press/tap on the bubble revealing a small action row, or a single 32px ⋯ button per own message instead of two icons.
### Reusable components (existing to reuse / new shared ones needed)
- Reuse: `Loading`, `QueryError`, `.tabs.seg`, `Drawer`, `Avatar`, `.chat-day` (promote to shared `.daysep`).
- New: shared `Popover`/`Menu` (with arrow keys) for ⋮; `PersonPicker` row component (also useful for Access/teams pickers).
- Move `.dot`/`.iconbtn.sm` overrides out of chat.css (namespace as `.chat-dot`), so chat.css can be lazy-loaded with the chat chunk.

## Before/after interaction comparison
| Task | Before (steps/clicks) | After |
|---|---|---|
| Find the "Dallas recruiters" group | guess that "Search users…" also finds groups, type | placeholder says it; type |
| Add 3 members on a phone | 3 taps on ~20px rows (mis-taps likely) | 3 taps on 40px rows |
| Read a long thread on phone | ~430px visible | ~600px visible |
| Switch to Unread | 1 click (pill on 2nd row) | 1 click (single row) |

## Expected benefit
More message area on phones (~40%), fewer mis-taps when building groups, chat CSS no longer altering other screens, consistent loading/error recovery.

## Implementation complexity: M
ChatPage.tsx (header, picker rows, states, copy), chat.css (layout, rename `.dot`), small styles.css change to let `.content` children flex. No API changes.

## Scorecard (1–10, evidence-based)
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 7 | Familiar two-pane pattern, Enter to send, links linkified, idempotent retry; search label confusion (#2) |
| Visual hierarchy | 7 | Clear bubbles and day pills; redundant header, wrapped filters (#4, #5) |
| Efficiency | 7 | Polling, unread counts, deep link `/chat/<id>`; minor extra clicks |
| Responsiveness | 6 | List/conversation swap works, no overflow (390/390 measured); header eats space, 28px actions (#3, #7) |
| Accessibility | 6 | Good labels (rows announce online/unread/favorite), live region for new messages; picker target size (#1) |
| Design consistency | 5 | Global CSS overrides, own states, Title Case drawer, third disclosure (#6, #8, #9, #10) |

## Validation
Visual inspection: desktop 1440 (list, open conversation, ⋮ menu, hover actions, create-group drawer), mobile 390 (list, conversation); target sizes and overflow measured with Playwright. Members panel, attachments and edit mode reviewed from code. Redesign validation: pending (not implemented).
