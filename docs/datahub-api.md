# DataHub: API contract (Phase 3c)

Migration `0075_datahub.sql`, `apps/api/src/modules/datahub`, `apps/web/src/datahub`, `packages/shared/src/datahub.ts`,
permissions `datahub:read` / `datahub:manage` in `packages/shared/src/authz/catalog.ts`. JSON, RFC 9457 problems with the
code in `detail`, CSRF header on writes. Reference screen: DataHub (search, folders panel, "Create New Folder" with Folder
name, Security level, Role, Description; upload). Owner decision: organisation folders on the existing document storage and
malware scan (migration 0043, `docs/paperwork-api.md`, HANDOFF "Paperwork and restricted documents with step-up").

## Rules

| ID | Rule |
|---|---|
| DH-1 | **Levels.** `internal`: every active staff user reads the folder. `confidential`: staff holding one of the folder's role keys (catalog roles, 1–16) read it. `restricted`: only the named members read it. "Staff" = an active user holding `datahub:read` through a live role, which every role except `org_admin` has; applicant accounts (no staff role) never see DataHub. A subfolder is readable only by those who can read its parent too. Folder managers (DH-2) also read the files of the internal and confidential folders they manage, **not** of restricted ones: they see a restricted folder's settings, members and access log, and must add themselves as a member (audited) to see its files. |
| DH-2 | **Managers.** `datahub:manage` covering the folder: org scope (HR, Accounts) covers every folder; location scope (Location Ops Admin) covers folders whose `locationId` is one of the grant's locations. Creating a top-level folder needs org scope for an organisation-wide folder (`locationId` null) or the chosen location; a location-only manager must give `locationId` (422 `location_required`). A subfolder inherits its parent's location and needs the parent managed. One level of subfolders (422 `too_deep`). |
| DH-3 | **Restricted.** Raising a folder to restricted and adding members need `datahub:manage` (every settings change does). Members must be active staff (422 `invalid_member`). Lowering a folder from restricted drops its member list. `datahub:manage` is in `RESTRICTED_PERMISSIONS` (second approver for the grant): a manager can name themself a member of any restricted folder they manage, so the permission reaches restricted files. HR, Accounts and Location Ops Admin were already restricted roles; no role's approval rule changes. |
| DH-4 | **Folder settings.** Name 1–80 characters, trimmed, no control characters or slashes, unique among live siblings case-insensitively (409 `name_taken`); description ≤ 500 or null; `membersCanUpload` (default off). `PATCH` needs `If-Match` with the `rowVersion` (428 without, 412 `stale`). Deleting a folder is a soft delete of an **empty** folder only (409 `folder_not_empty`), also with `If-Match`. `POST /folders` accepts an optional `Idempotency-Key` (a retry with the same body returns the first answer; a different body is 409 `idempotency_key_reused`). |
| DH-5 | **Upload.** Allowed to managers of a readable folder, and to readers when `membersCanUpload` is on (403 otherwise; 404 when the folder is not readable, so a non-member manager of a restricted folder cannot upload there). Presigned POST into `quarantine/documents/<file object id>` (2 minutes), the 0043 `document-scan` job scans and promotes it: `clean/documents/…`, or `restricted/documents/…` under the restricted KMS key when the folder is restricted at upload time. Types and size: the document allowlist (PDF, DOCX, PNG, JPEG; ≤ 15 MB); the file name (1–200, no control characters or slashes) must end in the type's extension (422 `invalid_upload` / validation). Uploading a name that matches a live file (case-insensitive) adds version n+1. At most ten pending DataHub uploads per user (409 `too_many_pending`); 20 upload requests per minute per user (429). |
| DH-6 | **Delete a file** (all its versions; soft delete): a manager of the folder, or the user who uploaded every version (403 otherwise). A later upload of the same name starts a new file at version 1. |
| DH-7 | **Download** one version: readable folder (404 otherwise), file `clean` (409 `not_available`). A restricted folder, or a file stored as restricted, needs a live step-up grant of the caller's session (403 `step_up_required`; the same grant as restricted documents, `/api/auth/step-up`); the refusal is audited. The link is a presigned GET (60 s; restricted 5 min) with `Content-Disposition: attachment` and an ASCII name built from the file name and version (`Leave-policy-v2.pdf`). 30 links per minute per user. |
| DH-8 | **Access log.** Every link issued (any level) is one `datahub_access` row (folder, file, version id and number, user, level, step-up grant) and one audit row, in the same transaction. Readable by the folder's managers and org-wide `audit:read`; the file name is shown only when the caller can read the file. |
| DH-9 | **Search** over the folders the caller can read: folder names and file names (case-insensitive contains; prefix matches first; `%`/`_` are literal), 1–100 characters, at most 50 of each. No full-text search of file contents. Indexes: `lower(name) text_pattern_ops` on live folders and files. |
| DH-10 | **Database.** RLS on every table (InitPlan arrays from `authz.datahub_readable_folders()` / `datahub_managed_folders()` / `datahub_visible_folders()`; versions and file objects by key). Writes only through the definer functions `authz.datahub_create_folder`, `datahub_update_folder`, `datahub_set_member`, `datahub_delete_folder`, `datahub_create_upload`, `datahub_delete_file`, `datahub_download`, which re-check permission and scope; BEFORE triggers set every server-managed column and refuse other writers (owner included), deletes (except membership rows) and truncation. |
| DH-11 | **Audit** (rule 5): `datahub.folder_created`, `folder_updated` (names of changed settings, levels, counts), `folder_deleted`, `member_added`/`member_removed` (user id), `upload_requested` (ids, level, version, type, size), `file_deleted` (version count), `downloaded`/`viewed` (restricted)/`view_refused`. Ids, levels and counts only: never folder names, file names or descriptions. |

## Endpoints (all need `datahub:read`; manage checks are in the service and the database)

- `GET /api/v1/datahub/folders` → `{ items: [Folder], canCreate, createScope: { org, locationIds } }` (visible folders: readable or managed).
- `POST /api/v1/datahub/folders` with `{ name, level, description?, roleKeys? (confidential), memberIds? (restricted), membersCanUpload?, parentId?, locationId? }` → 201 `{ id, rowVersion }`. Optional `Idempotency-Key`.
- `GET /api/v1/datahub/folders/:id` → `Folder`.
- `PATCH /api/v1/datahub/folders/:id` (`If-Match`) with any of `{ name, description, level, roleKeys, membersCanUpload, memberIds }` → `{ id, rowVersion }`. `memberIds` adds people when the folder is (or becomes) restricted.
- `DELETE /api/v1/datahub/folders/:id` (`If-Match`) → 204.
- `GET /api/v1/datahub/folders/:id/members` (manager) → `{ items: [{ id, name, addedAt }] }`; `PUT|DELETE /api/v1/datahub/folders/:id/members/:userId` (manager, restricted folders; 422 `not_restricted`) → 204.
- `GET /api/v1/datahub/people?q=&limit=` (`datahub:manage`) → `{ items: [{ id, name }] }` (active staff only).
- `GET /api/v1/datahub/folders/:id/files?cursor=&limit=` → `{ items: [File], nextCursor }` by name; 403 `not_member` for a manager who cannot read a restricted folder.
- `POST /api/v1/datahub/folders/:id/files` with `{ name, contentType, size }` → 201 `{ fileId, versionId, version, status: "pending", upload: { url, fields, expiresAt } }`.
- `GET /api/v1/datahub/files/:id/versions` → `{ items: [Version] }` newest first; `DELETE /api/v1/datahub/files/:id` → 204.
- `POST /api/v1/datahub/versions/:id/download` → `{ url, expiresAt }`.
- `GET /api/v1/datahub/folders/:id/access-log?cursor=&limit=` (manager) → `{ items: [{ id, at, user, fileId, fileName|null, version, level, steppedUp }], nextCursor }`.
- `GET /api/v1/datahub/search?q=&limit=` → `{ folders: [{ id, parentId, name, level }], files: [{ id, folderId, folderName, level, name, latestVersion }] }`.

`Folder` = `{ id, parentId, name, description, level, roleKeys, membersCanUpload, locationId, fileCount, memberCount|null (managers, restricted), isMember, rowVersion, createdAt, updatedAt, actions: { read, upload, manage, createSubfolder } }`

`File` = `{ id, folderId, name, versionCount, latestVersion: Version, actions: { download, delete } }`;
`Version` = `{ id, version, status (pending|clean|infected|failed|rejected|expired), reason, contentType, sizeBytes, uploadedBy: { id, name }, createdAt, scannedAt }`

## Error codes

`location_required`, `invalid_location`, `too_deep`, `invalid_level`, `invalid_roles`, `invalid_member`, `invalid_folder`,
`invalid_upload`, `not_restricted`, `invalid_cursor` (422); `name_taken`, `folder_not_empty`, `too_many_pending`,
`not_available`, `idempotency_key_reused` (409); `stale` (412); `if_match_required` (428); `step_up_required`, `not_member`,
`Not permitted` (403); not found (404).

## Web

DataHub screen (nav "DataHub", section Operations, `datahub:read`): header with "New folder" (managers) and "Upload" icon
buttons, search box, folders panel (globe Internal, lock Confidential, shield Restricted; subfolders indented) and file list
(name, version, size, uploaded by, date, scan status, download / version history / delete), empty states "No folders yet" and
"Select a folder to view documents", "Create New Folder" dialog (Folder name, Security level, Role multi-select for
Confidential, people picker for Restricted, Description; Location only for location-only managers), folder settings (adds
"Members can upload"), members, access log, upload dialog with progress (XMLHttpRequest), and the existing "Confirm it's you"
dialog before a restricted download. Panels stack at ≤ 768 px.

## Dev seed

`apps/api/src/db/dev-datahub.ts` (local development only) creates fictional folders as the dev HR, Accounts and Dallas Location
Ops Admin users (one per level, a subfolder, a Dallas folder). No files.

## Deviations and open questions

- `org_admin` gets no `datahub:read` (catalog rule "org_admin holds no data permissions"); org admins read the access logs
  through `audit:read` only. Ask whether org admins should see DataHub.
- File types are the document allowlist (PDF, DOCX, PNG, JPEG ≤ 15 MB): no spreadsheets, presentations or archives. Adding
  types needs `eureka.file_object`'s CHECK, the content inspection in the worker and the allowlist widened together.
- A file's storage class is fixed at upload: raising a folder to restricted later leaves its older files under `clean/`
  (access still follows the folder's current level and every download then needs step-up); lowering a folder keeps
  restricted files under `restricted/` and still asks for step-up for them.
- Restricted-folder managers who are not members see the folder, its members and its access log (file names hidden), but no
  files. Should HR/Accounts always read restricted folders instead?
- `membersCanUpload` applies to restricted folders' members too (the brief only named internal/confidential readers).
- Retention: soft-deleted files and folders, old versions and the access log are kept indefinitely (OD-03).
- No notifications on uploads; no moving files between folders; no renaming files (a new name is a new file).
