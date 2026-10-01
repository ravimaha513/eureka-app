import {
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
import { resolveScope, resumeAccess, type CandidateRef, type ResumeContentType } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { resumeCleanKey, resumeDownloadName, resumeQuarantineKey } from "../../platform/storage/content.js";
import { DOCUMENT_STORAGE, type DocumentStorage } from "../../platform/storage/document-storage.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import type { ResumeUpload } from "./resumes.schemas.js";

/** Presigned POST lifetime; matches upload_expires_at in migration 0036 (5 minutes). */
export const RESUME_UPLOAD_TTL_SECONDS = 300;
/** Presigned GET lifetime: long enough to start the download, short enough not to be shared. */
export const RESUME_DOWNLOAD_TTL_SECONDS = 60;
export const RESUME_UPLOADS_PER_MINUTE = 10;
export const RESUME_DOWNLOADS_PER_MINUTE = 30;

interface ResumeRow {
  id: string;
  status: string;
  scan_result: string | null;
  content_type: ResumeContentType;
  size_bytes: number;
  sha256_hex: string | null;
  version: number | null;
  is_current: boolean;
  uploaded_by: string;
  uploader_name: string | null;
  created_at: Date;
  scanned_at: Date | null;
}

const RESUME_COLUMNS = `r.id, r.status, r.scan_result, r.content_type, r.size_bytes, r.sha256_hex, r.version,
  r.is_current, r.uploaded_by, u.display_name AS uploader_name, r.created_at, r.scanned_at`;

const present = (r: ResumeRow) => ({
  id: r.id,
  status: r.status,
  /** Why a scan did not pass (GuardDuty result or the worker's reason code); null otherwise. */
  reason: r.status === "clean" ? null : r.scan_result,
  version: r.version,
  isCurrent: r.is_current,
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
  sha256: r.sha256_hex,
  uploadedBy: { id: r.uploaded_by, name: r.uploader_name },
  createdAt: r.created_at.toISOString(),
  scannedAt: r.scanned_at?.toISOString() ?? null,
});

const DB_ERRORS: Record<string, () => HttpException> = {
  not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  invalid_upload: () => new UnprocessableEntityException("invalid_upload"),
  too_many_pending: () => new ConflictException("too_many_pending"),
};

function mapDbError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? DB_ERRORS[e.message] : undefined;
  if (make) throw make();
  throw err;
}

/**
 * Candidate resumes (FR-CAN-07) on the document quarantine pipeline (design
 * A6.5). Read-before-write: 404 when the candidate is not readable, 403 when
 * document:read / document:upload does not cover it. RLS (resume_read) and
 * authz.create_resume_upload apply the same rules in the database.
 */
@Injectable()
export class ResumesService {
  private readonly uploadLimiter = new RateLimiter(RESUME_UPLOADS_PER_MINUTE, 60_000);
  private readonly downloadLimiter = new RateLimiter(RESUME_DOWNLOADS_PER_MINUTE, 60_000);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  /** The candidate as the caller sees it under candidate:read; 404 when not readable. */
  private async candidate(c: pg.PoolClient, user: AuthedUser, id: string): Promise<CandidateRef> {
    const scope = resolveScope(user.access, "candidate:read");
    if (!scope) throw new NotFoundException();
    const params: unknown[] = [id];
    const row = (await c.query<{ recruiter_id: string | null; team_id: string; location_id: string; visibility: "team" | "all_teams"; marketing_status: string }>(
      `SELECT c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status
       FROM eureka.candidate c WHERE c.id = $1 AND ${scopePredicate(scope, params)}`, params)).rows[0];
    if (!row) throw new NotFoundException();
    return { recruiterId: row.recruiter_id, teamId: row.team_id, locationId: row.location_id, visibility: row.visibility, marketingStatus: row.marketing_status };
  }

  async list(user: AuthedUser, candidateId: string) {
    return this.db.withUser(user.id, async (c) => {
      const access = resumeAccess(user.access, await this.candidate(c, user, candidateId));
      if (!access.read) throw new ForbiddenException("Not permitted");
      const { rows } = await c.query<ResumeRow>(
        `SELECT ${RESUME_COLUMNS} FROM eureka.resume r LEFT JOIN eureka.app_user u ON u.id = r.uploaded_by
         WHERE r.candidate_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 50`, [candidateId]);
      return { items: rows.map(present), canUpload: access.upload };
    });
  }

  /** The body is parsed after the scope check, so callers without upload rights over the candidate get 403/404, not 422. */
  async requestUpload(user: AuthedUser, candidateId: string, parse: () => ResumeUpload) {
    return this.db.withUser(user.id, async (c) => {
      const access = resumeAccess(user.access, await this.candidate(c, user, candidateId));
      if (!access.upload) throw new ForbiddenException("Not permitted");
      const body = parse();
      if (!this.uploadLimiter.take(user.id)) {
        throw new HttpException("Too many uploads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      const row = (await c.query<{ id: string; upload_expires_at: Date }>(
        `SELECT * FROM authz.create_resume_upload($1, $2, $3)`, [candidateId, body.contentType, body.size]).catch(mapDbError)).rows[0]!;
      // Rule 5: ids, type and size only; never the file name.
      await this.audit.record(c, {
        actorId: user.id, action: "resume.upload_requested", entityType: "resume", entityId: row.id,
        changes: { candidateId, contentType: body.contentType, sizeBytes: body.size },
      });
      const upload = await this.storage.presignUpload({
        key: resumeQuarantineKey(row.id), contentType: body.contentType, size: body.size, expiresSeconds: RESUME_UPLOAD_TTL_SECONDS,
      });
      return { id: row.id, status: "pending", upload };
    });
  }

  async download(user: AuthedUser, candidateId: string, resumeId: string) {
    return this.db.withUser(user.id, async (c) => {
      const access = resumeAccess(user.access, await this.candidate(c, user, candidateId));
      if (!access.read) throw new NotFoundException();
      const r = (await c.query<ResumeRow>(
        `SELECT ${RESUME_COLUMNS} FROM eureka.resume r LEFT JOIN eureka.app_user u ON u.id = r.uploaded_by
         WHERE r.id = $1 AND r.candidate_id = $2`, [resumeId, candidateId])).rows[0];
      if (!r) throw new NotFoundException();
      if (r.status !== "clean" || r.version === null) throw new ConflictException("not_available");
      if (!this.downloadLimiter.take(user.id)) {
        throw new HttpException("Too many downloads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "resume.downloaded", entityType: "resume", entityId: r.id,
        changes: { candidateId, version: r.version },
      });
      const url = await this.storage.presignDownload({
        key: resumeCleanKey(r.id), contentType: r.content_type,
        fileName: resumeDownloadName(r.version, r.content_type), expiresSeconds: RESUME_DOWNLOAD_TTL_SECONDS,
      });
      return { url, expiresAt: new Date(Date.now() + RESUME_DOWNLOAD_TTL_SECONDS * 1000).toISOString() };
    });
  }
}
