# DataHub — `/datahub`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
Who / permission: `datahub:read` (nav.ts:28) — every staff role except org_admin. Folder management with `datahub:manage` (HR/Accounts org-wide, Location Ops by location) or `datahub:create` (own folders). Per-folder `actions` decide upload, manage and subfolder (docs/datahub-api.md DH-1..2a).
Source: `apps/web/src/datahub/DataHubPage.tsx` (733 lines), `datahub/datahubApi.ts`, `documents/DocumentViewer.tsx`, `ui/StepUpDialog.tsx`
Evidence: `datahub-desktop.png`, `datahub-mobile.png`, `datahub-desktop-full.png`, `datahub-mobile-full.png`, `datahub-folder-desktop.png`, `datahub-folder-mobile.png`, `datahub-upload-dialog-desktop.png`, `datahub-upload-dialog-mobile.png`

## Primary objective
Staff find and open a shared file (policy, template, guest-house docs). Managers create folders with the right security level and upload new versions.

## What's on screen
- Header: h1, a tagline, and 2 icon-only buttons (New folder, Upload).
- A search box (replaces the folder view with results).
- Two panes: a Folders tree (1 level of subfolders, level icon, file count) and a Files pane. The Files pane shows a folder header with up to 6 action buttons (Upload to folder, Subfolder, Settings, Members, Access log, Delete folder) and a 7-column file table (Name, Version, Size, Uploaded by, Date, Status, 3-4 icon actions).
- Dialogs: Folder create/settings (name, level, role or people picker, location, description, members-can-upload), Upload (folder, file, progress), Versions, Members, Access log, Delete confirmations, and the in-app viewer.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The Upload dialog silently picks a different folder. `initialFolderId` is ignored when the open folder isn't uploadable, and `targets[0]` is used instead (:236-237). In `datahub-upload-dialog-desktop.png`, "Company policies" is open but the dialog preselects "Templates (Internal)". A user who doesn't read the select files the document in the wrong place. | Cognitive | High |
| 2 | The header's primary actions are icon-only (:504-510, `aria-label` "New folder"/"Upload"). The page's main CTA is an unlabeled upload-arrow square (`datahub-desktop.png`), unlike every other page's text+icon primary button ("New invoice", "Add facility"). | Hierarchy | Medium |
| 3 | No folder is selected on load (`selectedId` null, :422). Two-thirds of the screen is an empty "Select a folder to view documents" card (:593), 320px tall. Selection isn't in the URL, so a folder can't be linked or bookmarked, and a refresh loses it. | Efficiency | Medium |
| 4 | Search replaces the whole two-pane layout (:525-560). Clearing the search loses the user's place, and results show the folder only as text. | Cognitive | Low |
| 5 | Removing a member from a restricted folder is immediate. "Remove" calls `removeMember` with no confirmation (:353), unlike file and folder delete, which use `ConfirmDialog`. It revokes someone's access with one click. | Cognitive | Medium |
| 6 | The folder header can show 6 buttons in a row (Upload to folder, Subfolder, Settings, Members, Access log, Delete folder, :610-615), and "Delete folder" (danger) sits beside routine actions with the same size. | Hierarchy | Low |
| 7 | Copy and casing are inconsistent with the rest of the app: "Create New Folder" / "Create Folder" in Title Case (:183, :225), "Folder name *" with a literal asterisk (:188), "Description (Optional)" (:215). Other forms use sentence case and "(optional)". The tagline "Secure document management and collaboration" (:500) is marketing copy that says nothing about the task. | Design consistency | Low |
| 8 | The file input is the native unstyled control inside a field-styled box ("Choose File No file chosen", `datahub-upload-dialog-desktop.png`). There's no drag-and-drop target, and the chosen file's size and type aren't echoed before upload. | Visual | Low |
| 9 | Mobile: the tree and files stack (`datahub-mobile.png`). Selecting a folder scrolls to the files (:469, good), but there's no way back to the tree except scrolling up, and the 6 folder-header buttons wrap. | Responsive | Medium |
| 10 | Upload progress is shown as a bar (`.dh-progress`, :285). Documents and Bills uploads show only "Uploading…" text, so the same action has three different feedback patterns across the app. | Design consistency | Medium |

## Recommended redesign
### Desktop
- Upload dialog: preselect the open folder. If it isn't uploadable, preselect nothing ("Choose a folder…") and say "You can't upload to Company policies." Disable the header Upload when the open folder isn't a target, and show "Upload to folder" in the folder header only when it is (already the case).
- Header: text+icon buttons "New folder" (secondary) and "Upload" (primary). Replace the tagline with a sentence about the levels ("Shared files by folder. Globe = everyone, lock = chosen roles, shield = named people.").
- Route the selection as `/datahub/<folderId>`. On load, select the first readable folder, or the last one from localStorage.
- Search: show results in the Files pane, keep the tree visible, and make folder names in results clickable to select that folder.
- Folder header: Upload (primary) · Subfolder · a "Manage" menu (Settings, Members, Access log, Delete folder in danger at the bottom).
- Members dialog: confirm the removal inline ("Remove Asha? She loses access now." with Remove/Cancel in the row).
### Mobile
- Master-detail: the tree is the screen; tapping a folder shows the files with a "← Folders" back button. File rows become cards with 44px View/Download.
### Reusable components
- Existing: `ConfirmDialog`, `Dialog`, `Field`, `StepUpDialog`, `DocumentViewer`, `LevelIcon`.
- New shared: `FileDrop` (styled file input with drop zone, chosen-file echo and an accepted-types hint; reused by DocumentsSection, BillsTab invoice upload and resume upload), `UploadProgress` (the DataHub bar, made shared), `FileStatusBadge` (shared with Documents and Bills), `MenuButton` (overflow menu for secondary and destructive actions).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Upload into the open folder (when allowed) | Header icon → check the preselected folder → choose file → Upload (3-4) | "Upload to folder" → choose/drop file → Upload (3), no wrong-folder default |
| Open a known file | Land on empty pane → pick folder → find row → View (3) | Land on last folder → View (1-2) |
| Share a folder link | Not possible | Copy URL |
| Remove a restricted member | 1 click, no undo | 2 clicks with consequence stated |

## Expected benefit
Closes a misfiling path (High). Faster repeat visits, clearer primary actions, and one upload/progress pattern across Documents, Bills and DataHub.

## Implementation complexity: M
DataHubPage.tsx (dialog default, header buttons, routed selection, search placement, member confirm, menu), App.tsx (pass recordId), styles.css. No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Clear two-pane model; wrong-folder default (#1) |
| Visual hierarchy | 6 | Icon-only primary CTA (#2); 6 equal buttons (#6) |
| Efficiency | 6 | Empty default pane, no deep link (#3) |
| Responsiveness | 6 | Stacks without overflow; no master-detail (#9) |
| Accessibility | 8 | Labelled icon buttons, sr-only level names, scan results announced, focus to files heading |
| Design consistency | 5 | Title Case and "*"; a third upload-feedback pattern (#7, #10) |

## Validation
Visual inspection: desktop 1440 and mobile 390 as ceo, initial state, a selected folder ("Company policies") and the Upload dialog. Overflow: none at 390 (390/390). No files in the seed, so the file table, the Versions/Members/Access log dialogs and the viewer were reviewed from source only. Redesign validation: pending (not implemented).

### Implemented (wave 2)
| Audit item | Change | Evidence (`screenshots/after/`) |
|---|---|---|
| #1 Upload silently switches folder (High) | The open folder is preselected only when it takes uploads; otherwise nothing is preselected, the dialog says "You can't upload to X", and a target is required and echoed ("Uploads to …") | datahub-upload-desktop.png, unit test |
| #2 Icon-only header actions (Medium) | "New folder" and "Upload" (primary) with icons; tagline replaced with the level rule | datahub-desktop.png |
| #3 Empty pane, no deep link (Medium) | Open folder in the URL (`?folder=`); desktop opens the first readable folder | datahub-desktop.png |
| #5 Member removal unconfirmed (Medium) | Remove asks in the row: "Remove X? They lose access to this folder now." Keep / Remove access | unit test |
| #6 Six equal folder buttons (Low) | Upload to folder (primary), Subfolder, Manage menu (Settings, Members, Access log, Delete folder… in danger, last) | datahub-desktop.png |
| #7 Title case and "*" (Low) | "New folder", "Create folder", "Folder name", "Description (optional)" | unit test |
| #9 Phone master-detail (Medium) | Folder list is the phone screen until a folder opens; Folders back button; file cards with 44px actions | datahub-mobile.png |

Not changed / deferred: #4 Search still replaces the panes (Low). #8 Native file input kept (no shared FileDrop yet). #10 Upload feedback unification: Bills now uses an info banner; a shared UploadProgress is requested.

Validation (wave 2): typecheck clean; unit tests for paperwork, employees, payments, sites and datahub pass (87). The shared API on :3000 and its Postgres were down during this wave (the session could not restart them), so the visual check ran against the built screens with the network layer mocked by fictional fixtures (Playwright `page.route`), at 1440×900 and 390×844, light and dark. Page width at 390 is 390 on every screen and state; no table wrap scrolls sideways at either width; every row action column (`td.c-act`) is inside the viewport at 1440. Re-check against live seeded data when the API is back.
