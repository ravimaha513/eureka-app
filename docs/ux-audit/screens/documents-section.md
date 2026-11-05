# Documents section (shared component) — used on `/paperwork/<id>`, `/placements/<id>`, `/candidates/<id>`
Status: Audited · Redesign proposed
Who / permission: shown to `document:read` holders, and hidden entirely on 403/404 (:198 `return null`). Upload when `list.canUpload`; restricted types (I-9, driving licence, work authorization) only for HR/Accounts/Immigration; each opening of a restricted document is logged.
Source: `apps/web/src/documents/DocumentsSection.tsx` (344 lines), `DocumentViewer.tsx`, `documentsApi.ts`. Call sites: `paperwork/PaperworkWorkspace.tsx:106`, `pipeline/PlacementsPage.tsx:420`, `sales/CandidateProfile.tsx:275`.
Evidence: `paperwork-detail-hr-documents-desktop.png`, `paperwork-detail-hr-documents-mobile.png`, `paperwork-detail-desktop.png` (read-only ceo: no upload form), `paperwork-detail-itemdialog-desktop.png` (Linked document picker), `candidate-profile-tab-documents-desktop.png` (other auditor's capture, same component)

## Primary objective
Upload a compliance document of the right type, see when it has passed the malware scan, then view, download, retitle or replace it.

## What's on screen
- A card with h2 (title from the caller), a live message, and an error banner.
- Table: 5 columns (Document [+Restricted badge, title/type, replacement state], Status badge, Uploaded date·by, Size, Actions: View, Download, Access log (restricted), Edit). Inline editor row (title, type, replace file).
- An "Upload a document" block: Document type select, native file input with hint, and a full-width primary "Upload document" button.
- Polls every 3s while any document is pending, and announces "ready" or "not accepted".

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The upload form's two fields use different label patterns. "Document type" wraps its select in a bare `<label>` (:313), which renders the label and a narrow select on one line, while "Document file" uses a stacked `<label htmlFor>` (:323-324). In `paperwork-detail-hr-documents-desktop.png` the type select sits inline at about 270px and the file input spans 750px. | Visual | Medium |
| 2 | Linking a new file to a checklist item is a cross-tab round trip. The item dialog's "Linked document" select says "Upload new files on the Documents tab" (PaperworkWorkspace.tsx:263). Today the flow is: close the dialog → Documents tab → choose type → choose file → Upload → wait for the scan → Checklist tab → Update → pick the document → Save. | Efficiency | High |
| 3 | Upload feedback is the text "Uploading…" in `.livemsg` (:211), styled as a green success banner (styles.css:190). There's no percentage, although DataHub's upload shows a progress bar (DataHubPage.tsx:285) through the same kind of storage POST. A 15 MB file on a slow link gives no sign of progress. | Visual | Medium |
| 4 | The native file input sits inside a field-styled box ("Choose File No file chosen"), and there's no drop target. The chosen file's name and size aren't echoed in app style before upload. | Visual | Low |
| 5 | The full-width primary "Upload document" button (750px, `paperwork-detail-hr-documents-desktop.png`) is the heaviest element on the card, even when the user's task is to view an existing file. | Hierarchy | Low |
| 6 | The row actions can be 4 `btn sm` (View, Download, Access log, Edit, :277-300) in one cell. On a 336px mobile card that pushes the table into horizontal scroll. Every other table in the section scrolls the same way (paperwork checklist 609/336). | Responsive | Medium |
| 7 | A load error other than 403/404 renders as `<p className="error">` with no `role="alert"` (:250), so it isn't announced. Upload and download errors do use `role="alert"`. | A11y | Low |
| 8 | Read-only users (e.g. ceo) see only "No documents yet." with no hint about who uploads (`paperwork-detail-desktop.png`). The empty state is a dead end. | Cognitive | Low |

## Recommended redesign
### Desktop
- Upload block as a compact single row: `[Document type ▾] [FileDrop: "Drop a file or browse — PDF, DOCX, PNG, JPEG ≤ 15 MB"] [Upload]`, with a secondary-weight button. Collapsed behind "+ Upload document" when the list has items.
- Progress: the row appears in the table immediately with an `UploadProgress` bar (%), then turns into a "Scanning…" `FileStatusBadge`, then "Ready" or "Rejected". This replaces the green "Uploading…".
- Export a small `DocumentUploader` from this file. The paperwork item dialog embeds it under "Linked document" as "or upload a new one", and the new document is auto-selected once uploaded (still scan-gated by the existing `pending` → `clean` rule; the picker already accepts `pending`, PaperworkWorkspace.tsx:261).
- Row actions: View (primary text button) plus an overflow menu (Download, Access log, Edit).
- Empty state for read-only users: "No documents yet. HR, Accounts and Immigration upload paperwork here."
### Mobile
- Document rows as cards: name + status badge, "Nov 5 · 240 KB · hr", then a 44px View button and a ⋯ menu.
- FileDrop becomes a full-width "Choose file" button (camera/files picker on phones).
### Reusable components
- Existing: `StepUpDialog`, `DocumentViewer`, `Dialog`, `.badge.resume-*`.
- New shared (cross-cutting, also in DataHub and Bills): `FileDrop`, `UploadProgress`, `FileStatusBadge`, `MenuButton`, and `.livemsg.info` vs `.livemsg.ok`.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Upload and link a document to a checklist item | ≈10 steps across 2 tabs (see #2) | Update → upload in dialog → Save (≈4) |
| Know an upload is progressing | Static "Uploading…" (green) | % bar, then a Scanning badge in the row |
| Download a file on mobile | Swipe the table → Download | ⋯ → Download |

## Expected benefit
Removes the most expensive cross-tab handoff in paperwork. One upload pattern across 3 screens plus DataHub and Bills. Correct status semantics, so in-progress no longer looks like success.

## Implementation complexity: M
DocumentsSection.tsx (layout, uploader extraction, progress via a `postToStorage` progress callback, which needs `sales/resumesApi.ts` `postToStorage` to accept `onProgress` like `datahubApi.storage.post`), PaperworkWorkspace.tsx ItemDialog, styles.css. No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Scan gating clear and announced; link-after-upload round trip (#2) |
| Visual hierarchy | 6 | Mismatched upload fields, oversized CTA (#1, #5) |
| Efficiency | 5 | Cross-tab handoff (#2) |
| Responsiveness | 5 | 4 action buttons force sideways scroll (#6) |
| Accessibility | 7 | Labelled inputs, described-by hint and error, live scan results, step-up; one unannounced error (#7) |
| Design consistency | 5 | Third upload/progress pattern; label pattern differs within one form (#1, #3) |

## Validation
Visual inspection: desktop 1440 and mobile 390 on the paperwork Documents tab as hr (upload form) and ceo (read-only). The seed has no documents, so the populated table, the inline editor and the viewer were reviewed from source (`DocumentsSection.tsx:253-305`). Redesign validation: pending (not implemented).
