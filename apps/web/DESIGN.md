---
name: Eureka
description: Staff system of record for an IT bench-staffing firm. A dense working instrument on a carbon frame with one restrained signal red.
colors:
  signal-red: "#c0262d"
  carbon-ink: "#1f2342"
  carbon-ink-hover: "#31375f"
  on-ink: "#ffffff"
  ink-wash-50: "#eef0f6"
  ink-wash-100: "#e1e4ee"
  ink-wash-200: "#c9cdde"
  carbon-sidebar: "#1b1e3a"
  sidebar-line: "#2a2e50"
  sidebar-text: "#c9cbdc"
  sidebar-muted: "#9a9db8"
  sidebar-hover: "#262a4c"
  sidebar-current: "#2c3058"
  ground: "#f4f5f7"
  surface: "#ffffff"
  surface-sunk: "#f8f9fb"
  hover-wash: "#f0f1f5"
  hairline: "#e3e5eb"
  hairline-soft: "#eceef2"
  rule-strong: "#d3d6df"
  field-stroke: "#868e9e"
  ink-text: "#171a2e"
  ink-text-secondary: "#353a52"
  muted-text: "#5f6675"
  faint: "#a0a5b3"
  highlighter: "#fbf3d6"
  highlighter-line: "#ecd889"
  ok-bg: "#e7f5ec"
  ok-fg: "#17663a"
  ok-line: "#b9e2c7"
  warn-bg: "#fdf3e1"
  warn-fg: "#9a4d00"
  warn-line: "#f2d49b"
  bad-bg: "#fdeeee"
  bad-fg: "#b3261e"
  bad-line: "#f5c6c4"
  info-bg: "#e9f0fb"
  info-fg: "#1e4f9c"
  info-line: "#c5d7f2"
  neutral-bg: "#eff1f4"
  neutral-fg: "#474d5e"
  violet-bg: "#f1edfb"
  violet-fg: "#5b3aa8"
typography:
  display:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "36px"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  body-dense:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    fontFeature: "tnum"
  label:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  caption:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  chip:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.35
  column-head:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 650
    letterSpacing: "0.07em"
    fontVariation: "\"wdth\" 82"
  nav-section:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 650
    letterSpacing: "0.1em"
    fontVariation: "\"wdth\" 78"
  wordmark:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 750
    lineHeight: 1
    letterSpacing: "0.08em"
    fontVariation: "\"wdth\" 78"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  page-inline: "28px"
components:
  button-primary:
    backgroundColor: "{colors.carbon-ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.carbon-ink-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.hover-wash}"
  button-compact:
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "30px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.bad-fg}"
    rounded: "{rounded.md}"
    height: "36px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "36px"
  field-label:
    textColor: "{colors.ink-text-secondary}"
    typography: "{typography.label}"
  status-chip:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-fg}"
    typography: "{typography.chip}"
    rounded: "{rounded.sm}"
    padding: "2px 7px"
  status-chip-ok:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok-fg}"
  status-chip-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn-fg}"
  status-chip-bad:
    backgroundColor: "{colors.bad-bg}"
    textColor: "{colors.bad-fg}"
  status-chip-info:
    backgroundColor: "{colors.info-bg}"
    textColor: "{colors.info-fg}"
  status-chip-open-to-all:
    backgroundColor: "{colors.violet-bg}"
    textColor: "{colors.violet-fg}"
  priority-p1:
    backgroundColor: "{colors.carbon-ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  priority-p2:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn-fg}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  priority-p3:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  filter-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-text}"
    typography: "{typography.chip}"
    rounded: "{rounded.sm}"
    padding: "2px 2px 2px 8px"
  table-head:
    backgroundColor: "{colors.surface-sunk}"
    textColor: "{colors.muted-text}"
    typography: "{typography.column-head}"
    padding: "10px 12px"
  table-cell:
    textColor: "{colors.ink-text-secondary}"
    typography: "{typography.body-dense}"
    padding: "7px 10px"
  table-row-selected:
    backgroundColor: "{colors.highlighter}"
  bulk-bar:
    backgroundColor: "{colors.highlighter}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  nav-item:
    textColor: "{colors.sidebar-text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "34px"
  nav-item-hover:
    backgroundColor: "{colors.sidebar-hover}"
    textColor: "{colors.on-ink}"
  nav-item-current:
    backgroundColor: "{colors.sidebar-current}"
    textColor: "{colors.on-ink}"
  tab:
    textColor: "{colors.muted-text}"
    typography: "{typography.label}"
    padding: "0 10px"
    height: "38px"
  tab-selected:
    textColor: "{colors.ink-text}"
  toggle-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-text-secondary}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
  toggle-button-pressed:
    backgroundColor: "{colors.carbon-ink}"
    textColor: "{colors.on-ink}"
  count-box:
    textColor: "{colors.muted-text}"
    rounded: "{rounded.sm}"
    padding: "1px 7px"
  brand-mark:
    backgroundColor: "{colors.signal-red}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.sm}"
    size: "26px"
---

# Design System: Eureka

## Overview

**Creative North Star: "The Carbon Ledger"**

Eureka is a working instrument for bench sales, and the list is the product. The world is a near-white neutral ground framed by a deep carbon-navy sidebar, with carbon-ink text, hairline rules, small corners and no resting shadows. One restrained signal red marks identity and place (the brand mark, the current-nav rule, the selected-tab underline) and otherwise means only "error". Everything else is ink, neutral tints and quiet status colour.

Density is the point. Users arrive from Google Sheets and judge the tool by how fast a filtered list appears, so screens put filters, active chips and the first table rows in the first viewport, rows run about 34px tall, and numbers sit in tabular figures. Archivo is the single family: normal width for everything you read, a condensed caps cut for column heads, sidebar section labels and the wordmark. Light and dark are both first-class; the carbon frame stays carbon in both, and the primary action inverts (carbon on light, near-white on dark).

The world rejects the previous indigo card-dashboard: gradient logo, soft shadows on every card, pill tabs and airy rows. Desktop and phone are distinct layouts, not one squeezed into the other: on phones, tables become stacked record cards, filters move into a bottom sheet, and the bulk bar docks to the bottom edge.

**Key Characteristics:**
- Carbon sidebar (232px, 64px collapsed) with off-white type, plus a white 56px top bar.
- One signal red, used only for identity, current place and errors.
- Carbon-ink primary actions; P1 priority is a carbon chip, not red.
- Hairline borders and tonal surfaces; elevation only for things that float.
- Archivo variable in two widths; condensed caps used only as labels.
- Status is a quiet tinted chip with plain words.
- Selection is a pale highlighter yellow, distinct from every status tint.

## Colors

A neutral, slightly cool ground carrying carbon-navy ink, one signal red, and a set of quiet tinted status pairs. Always reference the CSS custom properties (`--brand`, `--pri-btn`, `--ok-bg` …) rather than hex: each token is redefined under `:root[data-theme="dark"]`, and the dark values live in the sidecar.

### Primary
- **Signal Red** (`--brand`): the brand mark tile, the 3px current-page rule on the sidebar's left edge, and the 2px underline of the selected tab. In dark theme it lifts to a lighter coral so it holds contrast on navy. It appears nowhere else.
- **Carbon Ink** (`--pri`, `--pri-btn`): primary buttons, pressed toggle buttons, the P1 priority chip, checkbox and radio accents, links, the focus outline and the focus ring on fields. **Carbon Ink Hover** (`--pri-btn-hover`) is its lifted hover. **On Ink** (`--on-pri`) is the text on it.
- **Ink Wash 50 / 100 / 200** (`--pri-50/100/200`): the 3px focus halo on fields (100), the pressed "More filters" button and highlighted Quick jump option (50 with a 200 border), and the hover border on clickable cards (200).

### Secondary
- **Carbon Sidebar** (`--side-bg`) and its family (`--side-line`, `--side-text`, `--side-muted`, `--side-hover`, `--side-current`): the navigation frame and the login brand panel. Sidebar text is off-white, section labels are muted, hover and the current item step up in two navy layers.

### Tertiary
- **Highlighter** (`--sel`, `--sel-line`): selected table rows, selected phone cards and the bulk-action bar. It is the only yellow in the system.
- **Status pairs** (`--ok-*`, `--warn-*`, `--bad-*`, `--info-*`, `--neutral-*`, `--violet-*`): tinted background with a dark foreground of the same hue, plus a `-line` border for banners and live messages. Active / Confirmation / Placed are ok; On hold is warn; Stopped / Terminated / Inactive are bad; Full of interviews is info; Bench is neutral; "Open to all teams" is violet. Warn also carries the P2 chip. Bad is the only other red in the product.

### Neutral
- **Ground** (`--bg`): the page behind the content.
- **Surface** (`--surface`) and **Surface Sunk** (`--surface2`): cards, tables, top bar, fields; sunk for table heads, row hover and the expanded "More filters" panel. **Hover Wash** (`--hover`) for button and menu hover.
- **Hairline** (`--line`), **Hairline Soft** (`--line2`), **Rule Strong** (`--line-strong`): card borders and the head rule; row dividers; button borders, chip outlines and the count box.
- **Field Stroke** (`--field-line`): input and select borders, darker than hairlines so fields read as controls (3.3:1 on white).
- **Ink Text** (`--text`), **Ink Text Secondary** (`--text2`), **Muted** (`--muted`): headings and primary values; table cells and labels; secondary text, column heads, captions.
- **Faint** (`--faint`): disabled pager buttons, the empty-state glyph and decorative glyphs only. It is 2.5:1 on white and is not a text colour.

### Named Rules
**The One Red Rule.** Signal red marks the brand, the current place (nav rule, selected tab) and nothing else. Any other red on screen is an error state (`--bad-fg`). If a new element wants red, it wants carbon ink.

**The Carbon Primary Rule.** The primary action is carbon ink, never red. A red button next to an error message reads as destructive.

**The Highlighter Rule.** Selection is pale highlighter yellow (`--sel`). Selection never uses a status tint, the ink wash or red.

## Typography

**Display Font:** Archivo Variable (with ui-sans-serif, system-ui, Segoe UI, Roboto fallbacks), loaded with its width axis (`@fontsource-variable/archivo/wdth.css`).
**Body Font:** Archivo Variable, the same family.
**Label Font:** Archivo Variable at condensed width (`font-stretch: 78–82%`), uppercase and tracked.

**Character:** a single grotesque used in two widths. Normal width carries every word you read, and the condensed caps cut gives column heads and section labels a printed-form crispness without a second typeface.

### Hierarchy
- **Display** (700, 36px, 1.12, -0.02em, balanced wrap): the login brand-panel statement only.
- **Headline** (700, 24px, 1.2, -0.015em; 21px on phones): the page h1, followed by the boxed count. The login form h1 uses 28px.
- **Title** (700, 17px, -0.01em): drawer heads and the phone filter sheet; dialog heads use 18px.
- **Body** (400, 14px): the root size. Navigation, fields and running text.
- **Body Dense** (400, 13.5px, tabular figures): table cells and buttons (600).
- **Label** (600, 13px): field labels, tabs and toggle buttons.
- **Caption** (400, 12–12.5px): hints, secondary lines under a cell value, footers.
- **Chip** (600, 12px, 1.35): status chips and filter chips. Priority chips use 700 at 11.5px.
- **Column Head** (650, 11.5px, 0.07em, uppercase, 82% width): table header cells.
- **Nav Section** (650, 11px, 0.1em, uppercase, 78% width): sidebar group labels (Workspace, Hiring, Operations …).
- **Wordmark** (750, 17px, 0.08em, uppercase, 78% width): "EUREKA" beside the mark, with its 10.5px tracked descriptor beneath.

### Named Rules
**The Two Widths Rule.** Condensed caps are for labels that name a column or a group: column heads, sidebar section labels, the wordmark. Never set a sentence, a value or a heading in them, and never put them above a heading as a lead-in.

**The Tabular Rule.** Tables, counts, the pager and every numeric cell use tabular figures, and numeric columns align right.

## Layout

The app is a two-column grid: a sticky full-height carbon sidebar (232px, collapsible to a 64px icon rail) and a main column with a sticky 56px white top bar holding Quick jump, the bell and the user menu. Content pads 24px top, 28px sides and 40px bottom, with 16px between page blocks.

List screens follow one order: page head (h1 + count box + one-line description, with saved views and export on the right); one filter row of labelled fields (8px gaps, "More filters · n" opening an inline sunk panel); a summary row of removable filter chips, result count and sort; then the table card. While rows are selected, the highlighter bulk bar takes the summary row's place. Rows pad 7px vertically, cells 10px horizontally, and the row action is pinned right with a hairline inset. Lower-priority columns hide below 1600px (`p3`) and 1400px (`p2`). Below 1600px the team lead moves from its own column into a tooltip on the Team cell, with the same text for screen readers, marked by a dotted underline.

Spacing follows a 4px base: 4 / 8 / 12 / 16 / 24, with 28px page sides. Control heights are 36px (default) and 30px (compact). Older screens still carry off-scale values; these are drift, not the system.

**Phones (≤768px)** are their own layout. The sidebar becomes a 280px off-canvas drawer over a scrim, opened from a menu button beside a compact brand. Top bar 60px, content pads 18/14px. On list screens the h1 and count sit above a saved-view row with icon-only Save and Export, then search plus a "Filters (n)" button that opens a bottom sheet (8px top corners, sticky head, 44px fields). Tables become record cards (12px padding, 8px gaps, `--r-lg`): name and priority first, then status, then the facts a recruiter scans, with the action at bottom right. The bulk bar docks to the bottom edge. Touch targets are 40–44px, and text inputs use 16px so iOS does not zoom.

Other breakpoints: profile grids collapse at 900px, and the login brand panel drops at 960px.

## Elevation & Depth

Flat at rest. `--shadow-sm` is deliberately `none`, so cards, tables, fields and buttons are separated by hairlines and by the step from ground to surface. Depth is tonal: the sunk surface for heads and hover, the highlighter for selection, two navy layers in the sidebar. Shadow appears only on elements that float above the page.

### Shadow Vocabulary
- **Float** (`--shadow-lg`: a soft 16/40 carbon drop with a 2/6 contact shadow; deeper and black in dark): the user menu, status popovers, chart tooltips, the sticky selection bar, the phone filter sheet and the docked phone bulk bar.
- **Scrim** (`--scrim`): behind dialogs, drawers, the phone nav and the filter sheet.

### Named Rules
**The Flat-At-Rest Rule.** Nothing that sits in the page flow has a shadow. If it does not float over content, it gets a hairline, not a shadow.

## Shapes

Small, consistent corners: 4px (`--r-sm`) for chips, the count box, the brand-mark tile and chip close buttons; 6px (`--r-md`) for buttons, fields, nav items, toggle buttons, the bulk bar and banners; 8px (`--r-lg`) for cards, dialogs, popovers, phone record cards and the top corners of bottom sheets. Borders are 1px hairlines. The current-nav rule (3px) and the selected-tab underline (2px) are the only heavier strokes. Circles are reserved for avatars, the bell button and its count badge.

**The Small Corners Rule.** No corner exceeds 8px, and controls, chips and tabs are never pill-shaped.

## Components

### Buttons
Squared-off and quiet: carbon ink for the one primary action, outlined surface for everything else.
- **Shape:** gently squared (6px), 36px tall (30px compact; 40–44px on phones), 600 weight at 13.5px, 6px gap for a leading 16px line icon.
- **Primary:** carbon ink fill with on-ink text; hover lifts to the lighter carbon. In dark theme it inverts to a near-white fill with navy text.
- **Secondary:** surface fill, strong-rule border, ink text; hover takes the hover wash.
- **Ghost:** transparent border and fill. **Danger:** bad-red text on surface with a bad-line border; a destructive submit fills with bad red.
- **Disabled:** 50% opacity. **Focus:** 2px carbon-ink outline, offset 2px.
- **Icon buttons:** 34px square (38px on phones), no border, muted glyph, hover wash.

### Chips
- **Status chip:** a 4px-cornered tinted label in plain words (Active, On hold, Open to all teams), 12px/600. No dots, no icons, no outlines.
- **Priority chip:** P1 carbon fill with on-ink text, P2 warn tint, P3 neutral tint; 11.5px/700, tabular figures.
- **Filter chip:** an active filter shown as a surface chip with a strong-rule outline, 500 weight, and a 24px close button whose hover turns bad-red.
- **Count box:** the result count beside the h1 ("38", "50+"), muted 15px/600 in a 4px outlined box.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** surface on the ground.
- **Shadow Strategy:** none (see Flat-At-Rest).
- **Border:** 1px hairline; clickable cards take the ink-wash-200 border on hover.
- **Internal Padding:** 14–16px for content cards; tables run edge to edge inside the card.

### Inputs / Fields
- **Style:** surface fill, 1px field-stroke border, 6px corners, 36px tall, 10px inline padding; label above in 13px/600 secondary ink, 4px gap. Placeholders use faint.
- **Focus:** the border turns carbon ink with a 3px ink-wash-100 halo; keyboard focus adds the 2px outline.
- **Read-only:** hover-wash fill, muted text. **Error:** bad-red text under the field; banners use the bad tint and line.

### Tables
- **Head:** sunk surface, condensed caps column heads in muted, a hairline below.
- **Rows:** about 34px (7px vertical padding), soft hairline dividers, sunk-surface hover, highlighter when selected. The name cell is a bold link button that opens the record, and the whole row opens it too.
- **Row action:** a compact secondary button (26px) pinned right with an inset hairline, sticky on horizontal scroll.
- **Phone:** each row becomes a record card (see Layout).

### Navigation
- **Sidebar:** carbon. 34px items with an 18px line icon, 14px/500 off-white text, 6px corners; hover steps to sidebar-hover with white text. The current page takes sidebar-current, white 600 text and the 3px signal-red rule flush to the left edge. Groups carry condensed caps section labels. A two-button theme switch sits at the foot.
- **Top bar:** white, hairline bottom, Quick jump icon button (Ctrl/Cmd+K), 40px circular bell with a bad-red count badge, user chip with avatar, name and role.
- **Tabs (role=tab):** an underline on a hairline baseline, 38px, muted text. The selected tab takes ink text and a 2px signal-red underline.
- **Toggle buttons (aria-pressed):** 30px outlined buttons; pressed fills with carbon ink. These are filter toggles and must not look like tabs.

### Bulk Bar (signature)
The highlighter strip that replaces the filter summary while rows are selected: "n candidates selected", then paired select + Apply controls (status, priority, visibility), then Clear selection. 6px corners, highlighter-line border. On phones it docks full-width to the bottom edge with 8px top corners, the float shadow and safe-area padding.

### Brand Mark
A 26px signal-red tile (4px corners) holding three white bars of 12, 9 and 12 units, an abstract "E" made of ledger lines, beside the condensed caps wordmark "EUREKA" with its small tracked descriptor. On phones the top bar shows a 28px mark with the name in sentence case.

### Avatars
Initials in a tinted circle (36px or 30px). The tint (indigo, teal, amber, rose, violet, sky) is chosen by a stable hash of the name. These tints are for avatars only and never carry meaning.

## Do's and Don'ts

### Do:
- **Do** reference tokens (`var(--brand)`, `var(--pri-btn)`, `var(--ok-bg)`) so both themes follow; never hard-code hex in components.
- **Do** keep signal red to the mark, the current-nav rule and the selected-tab underline; use `--bad-*` for errors.
- **Do** make the one primary action carbon ink (`--pri-btn`), and everything else secondary or ghost.
- **Do** show status as a tinted chip in plain words, and selection as the highlighter (`--sel`).
- **Do** set column heads and sidebar group labels in condensed caps (78–82% width, uppercase, tracked), and everything else in normal width.
- **Do** use tabular figures for every count and number, and right-align numeric columns.
- **Do** keep corners at 4 / 6 / 8px and separate surfaces with hairlines.
- **Do** design phones as their own layout: record cards, a filter bottom sheet, a docked bulk bar, 40–44px targets and 16px inputs.

### Don't:
- **Don't** use red for primary buttons, P1, badges or emphasis. It is identity, place or error.
- **Don't** put shadows on in-flow cards, tables, fields or buttons; `--shadow-lg` is for floating layers only.
- **Don't** use decorative gradients. The only gradient in the build is the hatched coverage-gap pattern, which shows data.
- **Don't** make tabs, chips or filter controls pill-shaped; circles are for avatars and the bell.
- **Don't** add lead-in labels above headings, or set sentences in condensed caps.
- **Don't** use shipping metaphors, ticket shapes, route codes or ornament.
- **Don't** use `--faint` for text that carries information; it is below 3:1.
- **Don't** fabricate metrics, logos or testimonials on the login panel or anywhere else.
