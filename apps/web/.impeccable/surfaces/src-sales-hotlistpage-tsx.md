---
version: 1
slug: "src-sales-hotlistpage-tsx"
primary_target: "src/sales/HotListPage.tsx"
related_targets: ["src/App.tsx","src/styles.css"]
---

# Eureka staff app (all screens) — surface brief

Scope: staff app shell and every screen under `apps/web/src`, plus portal and public feedback. Mode: Operate. First surface built in full: Shell + Hot List (`/hotlist`), then Candidates. Audience: recruiters and back office at an IT bench-staffing firm, desktop all day, phone to check. Constraints: preserve workflows, API contracts, authz; standard controls; both themes first-class; no less data on screen; no playful tone.

User-pinned direction (2026-11-05): "Category Standard as the structural foundation, enhanced with Air Waybill's visual identity: deep carbon sidebar, restrained red brand accents, excellent typography, clean data-dense layouts; conventional readable status labels and simple chips; no shipping metaphors, ticket shapes, railway codes or decoration; premium modern enterprise SaaS; distinct desktop and mobile variants; screen-specific layouts by task."

## Direction contract
THESIS: A precise, dense working instrument for bench sales: the list is the product. Refuses the indigo card-dashboard with gradient logo, soft shadows, pill tabs and airy rows.
OWN-WORLD: Near-white neutral ground; deep carbon-navy sidebar (#1b1e3a family) with off-white type; carbon-ink text; one restrained form-red accent (brand mark, current-nav rule, primary action, sort/active indicators) and nothing else red except error states. Hairline rules, 4–6px radii, no resting shadows, no gradients. Archivo (normal width for UI/data, condensed caps for column heads and section labels), tabular numerals. Status = quiet tinted chip with plain words.
STORY: A recruiter lands on the Hot List, sees their filters as chips and the first rows immediately, selects rows to bulk-set status or priority, opens a candidate in one click, and returns with filters intact (URL).
FIRST VIEWPORT: Carbon sidebar 224px left; top bar with Quick jump, bell, user. h1 "Hot List" + count; one filter row (Search, Technology, Status, Priority, Team, Recruiter, More filters·n, Saved view); active chips + result count; table at y≈260 with condensed caps headers, 34px rows, row action pinned right; selection bar replaces chip row while rows are selected. Phone: h1, search + Filters(n) button opening a sheet, candidate cards.
FORM: Category-standard enterprise list, assigned world Air Waybill (form 6 of 7) fused per user pin; seed:9eba1a3993cefad8
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Cited deviations (after finish review 1, 2026-11-05)
- Primary action is carbon ink (`--pri-btn`), not red: the user pinned "restrained red brand accents", and red primaries read as destructive next to errors. Red is kept for the mark, the current-nav rule, the active-tab underline and errors.
- The red top rule on the sidebar and login panel was removed (decoration). P1 is a carbon chip, not red.
- Sort stays a select on the summary row, not sortable column headers: the server's sort keys (LIST_SORTS) do not map one-to-one to columns. Header sorting needs an API change, so it is deferred.
- Quick jump stays an icon button in the top bar (Ctrl/Cmd+K). A visible field is deferred to the shell wave (nav regroup and phone drawer).
- Saved views and Export sit in the page head (icon buttons on phones), not in the filter row.
- The count sits beside the h1 as a small boxed figure ("38", or "50+" when more pages exist).
- Phone first card at y≈259, not ≤200: the saved-view row stays above search because recruiters use saved views to get back to their list. It is one 40px row, with Save and Export as icon buttons. Sort keeps its own row because it has no other home on phones.
- Below 1600px the team lead appears as a tooltip on the Team cell, with the same text for screen readers. At 1600px and wider it has its own column.
