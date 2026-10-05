import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import {
  can, datahubDownloadName, resolveScope,
  type DatahubLevel, type DocumentClassification, type DocumentContentType,
} from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { documentQuarantineKey, documentStoredKey } from "../../platform/storage/content.js";
import { DOCUMENT_STORAGE, type DocumentStorage } from "../../platform/storage/document-storage.js";
import {
  IdempotencyKey, decodeCursor, encodeCursor, likeEscape,
  type FolderCreate, type FolderUpdate, type UploadRequest,
} from "./datahub.schemas.js";

/** Presigned POST lifetime (as documents; the database upload window is 5 minutes). */
export const DATAHUB_UPLOAD_TTL_SECONDS = 120;
/** Presigned GET lifetime: 60 s, restricted 5 minutes (as documents, design A6.3). */
export const DATAHUB_DOWNLOAD_TTL_SECONDS = { internal: 60, restricted: 300 } as const;
export const DATAHUB_UPLOADS_PER_MINUTE = 20;
export const DATAHUB_DOWNLOADS_PER_MINUTE = 30;
const CREATE_FOLDER_ENDPOINT = "POST /api/v1/datahub/folders";

const DB_ERRORS: Record<string, () => HttpException> = {
  not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  name_taken: () => new ConflictException("name_taken"),
  folder_not_empty: () => new ConflictException("folder_not_empty"),
  too_many_pending: () => new ConflictException("too_many_pending"),
  stale: () => new HttpException("stale", HttpStatus.PRECONDITION_FAILED),
  too_deep: () => new UnprocessableEntityException("too_deep"),
  location_required: () => new UnprocessableEntityException("location_required"),
  invalid_location: () => new UnprocessableEntityException("invalid_location"),
  invalid_level: () => new UnprocessableEntityException("invalid_level"),
  invalid_roles: () => new UnprocessableEntityException("invalid_roles"),
  invalid_member: () => new UnprocessableEntityException("invalid_member"),
  invalid_folder: () => new UnprocessableEntityException("invalid_folder"),
  invalid_upload: () => new UnprocessableEntityException("invalid_upload"),
  level_below_parent: () => new UnprocessableEntityException("level_below_parent"),
  subfolder_level_below: () => new UnprocessableEntityException("subfolder_level_below"),
  not_restricted: () => new UnprocessableEntityException("not_restricted"),
};

function mapDbError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? DB_ERRORS[e.message] : undefined;
  if (make) throw make();
  throw err;
}

interface FolderRow {
  id: string; parent_id: string | null; name: string; description: string | null; level: DatahubLevel; role_keys: string[];
  members_can_upload: boolean; location_id: string | null; row_version: number; created_at: Date; updated_at: Date;
  readable: boolean; managed: boolean; file_count: number; member_count: number; is_member: boolean;
}

const FOLDER_SELECT = `SELECT f.id, f.parent_id, f.name, f.description, f.level, f.role_keys, f.members_can_upload, f.location_id,
    f.row_version, f.created_at, f.updated_at,
    f.id = ANY (s.r) AS readable, f.id = ANY (s.m) AS managed,
    (SELECT count(*)::int FROM eureka.datahub_file x WHERE x.folder_id = f.id) AS file_count,
    (SELECT count(*)::int FROM eureka.datahub_folder_member m WHERE m.folder_id = f.id) AS member_count,
    EXISTS (SELECT 1 FROM eureka.datahub_folder_member m WHERE m.folder_id = f.id AND m.user_id = $1) AS is_member
  FROM eureka.datahub_folder f, (SELECT authz.datahub_readable_folders() AS r, authz.datahub_managed_folders() AS m) s`;

function presentFolder(r: FolderRow) {
  return {
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    description: r.description,
    level: r.level,
    roleKeys: r.role_keys,
    membersCanUpload: r.members_can_upload,
    locationId: r.location_id,
    /** Live files the caller can see (0 when the files are not readable). */
    fileCount: r.file_count,
    /** Restricted folders, managers only. */
    memberCount: r.managed && r.level === "restricted" ? r.member_count : null,
    isMember: r.is_member,
    rowVersion: r.row_version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    actions: {
      read: r.readable,
      upload: r.readable && (r.managed || r.members_can_upload),
      manage: r.managed,
      createSubfolder: r.managed && r.parent_id === null,
    },
  };
}

interface VersionRow {
  id: string; file_id: string; version: number; status: string; scan_result: string | null; content_type: DocumentContentType;
  size_bytes: number; uploaded_by: string; uploader_name: string | null; created_at: Date; scanned_at: Date | null;
}
const VERSION_COLUMNS = `v.id, v.file_id, v.version, o.status, o.scan_result, o.content_type, o.size_bytes, v.uploaded_by,
  u.display_name AS uploader_name, v.created_at, o.scanned_at`;
const VERSION_FROM = `eureka.datahub_file_version v JOIN eureka.file_object o ON o.id = v.file_object_id
  LEFT JOIN eureka.app_user u ON u.id = v.uploaded_by`;

const presentVersion = (r: VersionRow) => ({
  id: r.id,
  version: r.version,
  status: r.status,
  /** Why a scan did not pass (GuardDuty result or the worker's reason code); null otherwise. */
  reason: r.status === "clean" ? null : r.scan_result,
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
  uploadedBy: { id: r.uploaded_by, name: r.uploader_name },
  createdAt: r.created_at.toISOString(),
  scannedAt: r.scanned_at?.toISOString() ?? null,
});

interface FileRow extends Omit<VersionRow, "id" | "file_id"> {
  file_id: string; folder_id: string; name: string; version_id: string; version_count: number; created_by: string;
  only_mine: boolean; managed: boolean; lname: string;
}

const presentFile = (r: FileRow) => ({
  id: r.file_id,
  folderId: r.folder_id,
  name: r.name,
  versionCount: r.version_count,
  latestVersion: presentVersion({ ...r, id: r.version_id }),
  actions: { download: r.status === "clean", delete: r.managed || r.only_mine },
});

const FileCursor = z.object({ n: z.string().max(400), id: z.string().uuid() });
const LogCursor = z.object({ at: z.string().datetime({ offset: true }), id: z.string().uuid() });

/**
 * DataHub (docs/datahub-api.md, migration 0075): organisation folders and
 * files on the document storage and malware scan (0043). Read-before-write:
 * 404 when the folder (or file) is not visible, 403 when visible but not
 * allowed. RLS and the definer functions apply the same rules in the database
 * and write the audit rows (ids, levels and counts; never names).
 */
@Injectable()
export class DatahubService {
  private readonly uploadLimiter = new RateLimiter(DATAHUB_UPLOADS_PER_MINUTE, 60_000);
  private readonly downloadLimiter = new RateLimiter(DATAHUB_DOWNLOADS_PER_MINUTE, 60_000);

  constructor(
    private readonly db: DbService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  private async folderRow(c: pg.PoolClient, user: AuthedUser, id: string): Promise<FolderRow> {
    const row = (await c.query<FolderRow>(`${FOLDER_SELECT} WHERE f.id = $2`, [user.id, id])).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  /** What the caller may create: org-wide folders, and/or folders of these locations. */
  private createScope(user: AuthedUser) {
    const s = resolveScope(user.access, "datahub:manage");
    return { org: s?.all ?? false, locationIds: s ? [...s.locationIds] : [] };
  }

  async folders(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => {
      const { rows } = await c.query<FolderRow>(`${FOLDER_SELECT} ORDER BY lower(f.name), f.id`, [user.id]);
      const scope = this.createScope(user);
      return { items: rows.map(presentFolder), canCreate: scope.org || scope.locationIds.length > 0, createScope: scope };
    });
  }

  async folder(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => presentFolder(await this.folderRow(c, user, id)));
  }

  /** DH-2: datahub:manage. Optional Idempotency-Key: a retry with the same body returns the first answer. */
  async createFolder(user: AuthedUser, parse: () => FolderCreate, idempotencyKey: string | undefined) {
    if (!can(user.access, "datahub:manage")) throw new ForbiddenException("Not permitted");
    const body = parse();
    const key = idempotencyKey === undefined ? null : IdempotencyKey.safeParse(idempotencyKey);
    if (key && !key.success) throw new BadRequestException("invalid_idempotency_key");
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    return this.db.withUser(user.id, async (c) => {
      if (key?.success) {
        const claimed = await c.query(
          `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING RETURNING key`, [key.data, user.id, CREATE_FOLDER_ENDPOINT, hash]);
        if (claimed.rowCount === 0) {
          const prior = (await c.query<{ request_hash: string; response: unknown }>(
            `SELECT request_hash, response FROM eureka.idempotency_key WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
            [user.id, CREATE_FOLDER_ENDPOINT, key.data])).rows[0];
          if (!prior || prior.request_hash !== hash || prior.response === null) throw new ConflictException("idempotency_key_reused");
          return prior.response as { id: string; rowVersion: number };
        }
      }
      const id = (await c.query<{ id: string }>(
        `SELECT authz.datahub_create_folder($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
        [body.parentId ?? null, body.name, body.description ?? null, body.level, body.roleKeys ?? [], body.memberIds ?? [],
          body.membersCanUpload ?? false, body.locationId ?? null]).catch(mapDbError)).rows[0]!.id;
      const result = { id, rowVersion: 1 };
      if (key?.success) {
        await c.query(`UPDATE eureka.idempotency_key SET response = $4 WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
          [user.id, CREATE_FOLDER_ENDPOINT, key.data, result]);
      }
      return result;
    });
  }

  /** DH-4: managers only; If-Match carries the rowVersion (428 without it, 412 when stale). */
  async updateFolder(user: AuthedUser, id: string, expected: number | null, parse: () => FolderUpdate) {
    return this.db.withUser(user.id, async (c) => {
      const cur = await this.folderRow(c, user, id);
      if (!cur.managed) throw new ForbiddenException("Not permitted");
      const body = parse();
      if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
      if (expected !== cur.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      const level = body.level ?? cur.level;
      if (body.level === undefined && body.roleKeys !== undefined && level !== "confidential") {
        throw new UnprocessableEntityException("invalid_roles");
      }
      if (body.level === undefined && body.memberIds?.length && level !== "restricted") {
        throw new UnprocessableEntityException("invalid_member");
      }
      const changes: Record<string, unknown> = {};
      if (body.name !== undefined) changes.name = body.name;
      if (body.description !== undefined) changes.description = body.description;
      if (body.level !== undefined) changes.level = body.level;
      if (body.roleKeys !== undefined) changes.roleKeys = body.roleKeys;
      if (body.membersCanUpload !== undefined) changes.membersCanUpload = body.membersCanUpload;
      const rowVersion = (await c.query<{ v: number }>(`SELECT authz.datahub_update_folder($1, $2, $3::jsonb, $4) AS v`,
        [id, expected, JSON.stringify(changes), body.memberIds ?? []]).catch(mapDbError)).rows[0]!.v;
      return { id, rowVersion };
    });
  }

  async deleteFolder(user: AuthedUser, id: string, expected: number | null) {
    await this.db.withUser(user.id, async (c) => {
      const cur = await this.folderRow(c, user, id);
      if (!cur.managed) throw new ForbiddenException("Not permitted");
      if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
      if (expected !== cur.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      await c.query(`SELECT authz.datahub_delete_folder($1, $2)`, [id, expected]).catch(mapDbError);
    });
  }

  /** DH-3: members of a restricted folder (managers only). */
  async members(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const cur = await this.folderRow(c, user, id);
      if (!cur.managed) throw new ForbiddenException("Not permitted");
      const { rows } = await c.query<{ user_id: string; name: string | null; added_at: Date }>(
        `SELECT m.user_id, u.display_name AS name, m.added_at FROM eureka.datahub_folder_member m
         LEFT JOIN eureka.app_user u ON u.id = m.user_id WHERE m.folder_id = $1 ORDER BY lower(u.display_name), m.user_id`, [id]);
      return { items: rows.map((r) => ({ id: r.user_id, name: r.name, addedAt: r.added_at.toISOString() })) };
    });
  }

  async setMember(user: AuthedUser, id: string, memberId: string, member: boolean) {
    await this.db.withUser(user.id, async (c) => {
      const cur = await this.folderRow(c, user, id);
      if (!cur.managed) throw new ForbiddenException("Not permitted");
      if (cur.level !== "restricted") throw new UnprocessableEntityException("not_restricted");
      await c.query(`SELECT authz.datahub_set_member($1, $2, $3)`, [id, memberId, member]).catch(mapDbError);
    });
  }

  /** People picker for restricted folders: active staff (holders of datahub:read), ids and names only. */
  async people(user: AuthedUser, q: { q?: string; limit: number }) {
    if (!can(user.access, "datahub:manage")) throw new ForbiddenException("Not permitted");
    return this.db.withUser(user.id, async (c) => {
      const term = q.q?.trim() ?? "";
      const params: unknown[] = [q.limit];
      let where = "";
      if (term) { params.push(`%${likeEscape(term)}%`); where = `AND lower(u.display_name) LIKE $2`; }
      const { rows } = await c.query<{ id: string; name: string }>(
        `SELECT u.id, u.display_name AS name FROM eureka.app_user u
         WHERE u.status = 'active' ${where}
           AND EXISTS (SELECT 1 FROM eureka.user_role ur JOIN eureka.role_permission rp
                         ON rp.role_key = ur.role_key AND rp.permission = 'datahub:read'
                       WHERE ur.user_id = u.id AND ur.valid @> now())
         ORDER BY lower(u.display_name), u.id LIMIT $1`, params);
      return { items: rows };
    });
  }

  /** DH-1: the files of a folder whose files the caller may read, by name (keyset). */
  async files(user: AuthedUser, id: string, q: { cursor?: string; limit: number }) {
    return this.db.withUser(user.id, async (c) => {
      const folder = await this.folderRow(c, user, id);
      if (!folder.readable) throw new ForbiddenException("not_member");
      const after = decodeCursor(q.cursor, FileCursor);
      if (q.cursor && !after) throw new UnprocessableEntityException("invalid_cursor");
      const params: unknown[] = [user.id, id, q.limit + 1, folder.managed];
      let where = "";
      if (after) { params.push(after.n, after.id); where = `AND (lower(f.name), f.id) > ($5, $6::uuid)`; }
      const rows = (await c.query<FileRow>(this.fileSql(`f.folder_id = $2 ${where}`, "lower(f.name), f.id", "$3"), params)).rows;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(presentFile),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ n: last.lname, id: last.file_id }) : null,
      };
    });
  }

  /** Files with their newest version; `$1` is the caller, `$4` whether they manage the folder. */
  private fileSql(where: string, order: string, limit: string) {
    return `SELECT f.id AS file_id, f.folder_id, f.name, lower(f.name) AS lname, f.created_by,
        lv.id AS version_id, lv.version, o.status, o.scan_result, o.content_type, o.size_bytes, lv.uploaded_by,
        u.display_name AS uploader_name, lv.created_at, o.scanned_at,
        (SELECT count(*)::int FROM eureka.datahub_file_version x WHERE x.file_id = f.id) AS version_count,
        NOT EXISTS (SELECT 1 FROM eureka.datahub_file_version x WHERE x.file_id = f.id AND x.uploaded_by <> $1) AS only_mine,
        $4::boolean AS managed
      FROM eureka.datahub_file f
      JOIN eureka.datahub_file_version lv ON lv.file_id = f.id AND lv.version = f.latest_version
      JOIN eureka.file_object o ON o.id = lv.file_object_id
      LEFT JOIN eureka.app_user u ON u.id = lv.uploaded_by
      WHERE ${where} ORDER BY ${order} LIMIT ${limit}`;
  }

  async versions(user: AuthedUser, fileId: string) {
    return this.db.withUser(user.id, async (c) => {
      const f = (await c.query<{ id: string }>(`SELECT id FROM eureka.datahub_file WHERE id = $1`, [fileId])).rows[0];
      if (!f) throw new NotFoundException();
      const { rows } = await c.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM ${VERSION_FROM} WHERE v.file_id = $1 ORDER BY v.version DESC`, [fileId]);
      return { items: rows.map(presentVersion) };
    });
  }

  /** DH-5: a presigned POST into quarantine/documents/<file object id>; a same-named file gets a new version. */
  async requestUpload(user: AuthedUser, folderId: string, parse: () => UploadRequest) {
    return this.db.withUser(user.id, async (c) => {
      const folder = await this.folderRow(c, user, folderId);
      if (!folder.readable) throw new ForbiddenException("not_member");
      if (!folder.managed && !folder.members_can_upload) throw new ForbiddenException("Not permitted");
      const body = parse();
      if (!this.uploadLimiter.take(user.id)) {
        throw new HttpException("Too many uploads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      const row = (await c.query<{ file_id: string; version_id: string; version: number; file_object_id: string; classification: DocumentClassification }>(
        `SELECT * FROM authz.datahub_create_upload($1, $2, $3, $4)`, [folderId, body.name, body.contentType, body.size])
        .catch(mapDbError)).rows[0]!;
      const upload = await this.storage.presignUpload({
        key: documentQuarantineKey(row.file_object_id), contentType: body.contentType, size: body.size, expiresSeconds: DATAHUB_UPLOAD_TTL_SECONDS,
      });
      return { fileId: row.file_id, versionId: row.version_id, version: row.version, status: "pending" as const, upload };
    });
  }

  /** DH-6: uploader of every version, or a manager of the folder. */
  async deleteFile(user: AuthedUser, fileId: string) {
    await this.db.withUser(user.id, async (c) => {
      const f = (await c.query<{ folder_id: string; only_mine: boolean }>(
        `SELECT f.folder_id, NOT EXISTS (SELECT 1 FROM eureka.datahub_file_version x WHERE x.file_id = f.id AND x.uploaded_by <> $2) AS only_mine
         FROM eureka.datahub_file f WHERE f.id = $1`, [fileId, user.id])).rows[0];
      if (!f) throw new NotFoundException();
      const folder = await this.folderRow(c, user, f.folder_id);
      if (!folder.managed && !f.only_mine) throw new ForbiddenException("Not permitted");
      await c.query(`SELECT authz.datahub_delete_file($1)`, [fileId]).catch(mapDbError);
    });
  }

  /**
   * DH-7: a short-lived download link for one clean version. Restricted
   * folders need a live step-up of this session: 403 `step_up_required`
   * (the refusal is audited, so it is raised after the transaction commits).
   */
  async download(user: AuthedUser, versionId: string) {
    const out = await this.db.withUser(user.id, async (c) => {
      const v = (await c.query<{ name: string; content_type: DocumentContentType }>(
        `SELECT f.name, o.content_type FROM ${VERSION_FROM} JOIN eureka.datahub_file f ON f.id = v.file_id WHERE v.id = $1`, [versionId])).rows[0];
      if (!v) throw new NotFoundException();
      if (!this.downloadLimiter.take(user.id)) {
        throw new HttpException("Too many downloads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      const r = (await c.query<{ outcome: string; file_object_id: string | null; classification: DocumentClassification; version: number }>(
        `SELECT outcome, file_object_id, classification, version FROM authz.datahub_download($1, $2)`, [versionId, user.sessionHash])
        .catch(mapDbError)).rows[0]!;
      if (r.outcome !== "ok" || !r.file_object_id) return { outcome: r.outcome } as const;
      const ttl = r.outcome === "ok" && r.classification === "restricted" ? DATAHUB_DOWNLOAD_TTL_SECONDS.restricted : DATAHUB_DOWNLOAD_TTL_SECONDS.internal;
      const url = await this.storage.presignDownload({
        key: documentStoredKey(r.file_object_id, r.classification), contentType: v.content_type,
        fileName: datahubDownloadName(v.name, r.version, v.content_type), expiresSeconds: ttl,
      });
      return { outcome: "ok", url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() } as const;
    });
    if (out.outcome === "step_up_required") throw new ForbiddenException("step_up_required");
    if (out.outcome !== "ok") throw new ConflictException("not_available");
    return { url: out.url, expiresAt: out.expiresAt };
  }

  /** DH-8: every download link issued for the folder's files; folder managers (and audit:read). */
  async accessLog(user: AuthedUser, folderId: string, q: { cursor?: string; limit: number }) {
    return this.db.withUser(user.id, async (c) => {
      const folder = await this.folderRow(c, user, folderId);
      if (!folder.managed) throw new ForbiddenException("Not permitted");
      const before = decodeCursor(q.cursor, LogCursor);
      if (q.cursor && !before) throw new UnprocessableEntityException("invalid_cursor");
      const params: unknown[] = [folderId, q.limit + 1];
      let where = "";
      if (before) { params.push(before.at, before.id); where = `AND (a.at, a.id) < ($3::timestamptz, $4::uuid)`; }
      const { rows } = await c.query<{ id: string; at: Date; user_id: string; user_name: string | null; file_id: string;
        file_name: string | null; version: number; level: string; step_up_grant_id: string | null }>(
        `SELECT a.id, a.at, a.user_id, u.display_name AS user_name, a.file_id, f.name AS file_name, a.version, a.level, a.step_up_grant_id
         FROM eureka.datahub_access a
         LEFT JOIN eureka.datahub_file f ON f.id = a.file_id
         LEFT JOIN eureka.app_user u ON u.id = a.user_id
         WHERE a.folder_id = $1 ${where} ORDER BY a.at DESC, a.id DESC LIMIT $2`, params);
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => ({
          id: r.id, at: r.at.toISOString(), user: { id: r.user_id, name: r.user_name },
          // The name only when the caller can read the file (a manager who is not a member of a restricted folder sees ids).
          fileId: r.file_id, fileName: r.file_name, version: r.version, level: r.level, steppedUp: r.step_up_grant_id !== null,
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.at.toISOString(), id: last.id }) : null,
      };
    });
  }

  /** DH-9: file name or folder name, over the folders the caller can read (prefix matches first). */
  async search(user: AuthedUser, q: { q: string; limit: number }) {
    return this.db.withUser(user.id, async (c) => {
      const term = likeEscape(q.q);
      const folders = (await c.query<{ id: string; parent_id: string | null; name: string; level: DatahubLevel }>(
        `SELECT f.id, f.parent_id, f.name, f.level FROM eureka.datahub_folder f
         WHERE f.id = ANY ((SELECT authz.datahub_readable_folders())::uuid[]) AND lower(f.name) LIKE '%' || $1 || '%'
         ORDER BY lower(f.name) LIKE $1 || '%' DESC, lower(f.name), f.id LIMIT $2`, [term, q.limit])).rows;
      const files = (await c.query<FileRow & { folder_name: string; level: DatahubLevel }>(
        `SELECT f.id AS file_id, f.folder_id, f.name, fo.name AS folder_name, fo.level,
            lv.id AS version_id, lv.version, o.status, o.scan_result, o.content_type, o.size_bytes, lv.uploaded_by,
            u.display_name AS uploader_name, lv.created_at, o.scanned_at
         FROM eureka.datahub_file f
         JOIN eureka.datahub_folder fo ON fo.id = f.folder_id
         JOIN eureka.datahub_file_version lv ON lv.file_id = f.id AND lv.version = f.latest_version
         JOIN eureka.file_object o ON o.id = lv.file_object_id
         LEFT JOIN eureka.app_user u ON u.id = lv.uploaded_by
         WHERE lower(f.name) LIKE '%' || $1 || '%' OR lower(fo.name) LIKE '%' || $1 || '%'
         ORDER BY lower(f.name) LIKE $1 || '%' DESC, lower(f.name), f.id LIMIT $2`, [term, q.limit])).rows;
      return {
        folders: folders.map((f) => ({ id: f.id, parentId: f.parent_id, name: f.name, level: f.level })),
        files: files.map((f) => ({
          id: f.file_id, folderId: f.folder_id, folderName: f.folder_name, level: f.level, name: f.name,
          latestVersion: presentVersion({ ...f, id: f.version_id }),
        })),
      };
    });
  }
}
