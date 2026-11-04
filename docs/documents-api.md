# Documents: API contract

Paperwork and compliance documents on a candidate or one of the candidate's placements (FR-PPR-01 to 03; migration
0043, design A6.1, A6.3, A6.5). Uploads go to `quarantine/documents/<fileId>` through a presigned POST, the
`document-scan` worker checks them and promotes clean files to `clean/documents/` (internal) or
`restricted/documents/` (restricted, own KMS key). Restricted types (I-9, driving license, work authorization) are
listed and opened only under `document.restricted:read`; every opening is in the access log.

This file starts with migration 0461 (editing); the upload, download and access-log endpoints below are as built in 0043.

## Rules

| # | Rule |
|---|------|
| DOC-1 | The server derives owner, classification (from the type), key, status and file name; a client sends the type, content type and exact size only. |
| DOC-2 | Reads: `document:read` over the candidate (and `document.restricted:read` for restricted documents); 404 when not visible. |
| DOC-3 | At most five files of a candidate wait for their scan at once (409 `too_many_pending`); since 0461 a waiting replacement counts. |
| DOC-4 | After upload, holders of `document:upload` over the candidate (restricted documents: also restricted upload) may set a display **title** (1-120 characters, `null` clears it) and change the **type** to another of the **same classification**. A change between internal and restricted is 422 `classification_change`: the stored key and its encryption follow the classification, so that is a new upload. The download file name stays derived from the type (no user text in `Content-Disposition`). |
| DOC-5 | **Replacing the file**: a new `file_object` for the same document, through quarantine and the scan like any upload. The current file keeps opening until the new one is clean; then `authz.document_scan_finish` swaps it in. A refused replacement is shown (`replacement.status`, `reason`) and changes nothing. Asking again drops a waiting replacement. The document id stays, so checklist links (`checklist_item.document_id`) survive. Earlier files are kept in `document.previous_file_ids` (never opened again) and are removed with the candidate (`authz.delete_candidate`). |
| DOC-6 | Audit (rule 5): `document.updated` with field names and, for a type change, the type keys; `document.replace_requested` with the file id, type key, classification, content type and size. Never the title. |

## Endpoints

- `GET /api/v1/candidates/:id/documents`, `GET /api/v1/placements/:id/documents` (`document:read`) return
  `{ items: [Document], canUpload, canUploadRestricted, canViewRestricted }`, newest first.
- `POST /api/v1/candidates/:id/documents`, `POST /api/v1/placements/:id/documents` (`document:upload`) with
  `{ docType, contentType, size }` return 201 `{ id, fileId, classification, status: "pending", upload: { url, fields, expiresAt } }`.
- `PATCH /api/v1/documents/:documentId` (`document:upload`) with any of `{ title|null, docType, expectedVersion }` returns `Document` (DOC-4).
- `POST /api/v1/documents/:documentId/replace` (`document:upload`) with `{ contentType, size, expectedVersion? }` returns 201
  `{ id, fileId, classification, status: "pending", upload }` (DOC-5); post the file to `upload` as for a new document.
- `POST /api/v1/documents/:documentId/download` (`document:read`) returns `{ url, expiresAt }` for the current clean file.
- `GET /api/v1/document-access?documentId=&before=&limit=` returns the access log (`audit:read`: all; restricted readers: one document).

`Document` = `{ id, candidateId, placementId, docType, docTypeLabel, classification, status, reason, contentType, sizeBytes, sha256,
uploadedBy: {id,name}, createdAt, scannedAt, title, version, replacement: { status, reason, contentType, sizeBytes, createdAt } | null }`

## Error codes

`invalid_upload`, `invalid_change`, `classification_change` (422); `too_many_pending`, `version_mismatch`, `not_available` (409);
`step_up_required`, not permitted (403); not found (404); too many uploads or downloads (429).

## Web

`DocumentsSection` (candidate profile, paperwork page) shows the title (else the type) with the type underneath, and an
**Edit** row for those who may upload that classification: title, type (same access level only), and an optional new file.
While a replacement is scanned the row says so and the current file still opens; a refused replacement is explained.
