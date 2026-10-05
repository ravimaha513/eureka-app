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
import {
  DOCUMENT_TYPES, can, documentAccess, resolveScope,
  type CandidateRef, type DocumentClassification, type DocumentContentType, type DocumentType,
} from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { documentDownloadName, documentQuarantineKey, documentStoredKey } from "../../platform/storage/content.js";
import { DOCUMENT_STORAGE, type DocumentStorage } from "../../platform/storage/document-storage.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import type { AccessLogQuery, DocumentUpload } from "./documents.schemas.js";
import type { z } from "zod";

/** Presigned POST lifetime (as resumes; the database upload window is 5 minutes). */
export const DOCUMENT_UPLOAD_TTL_SECONDS = 120;
/** Presigned GET lifetime: 60 s for internal files, 5 minutes for restricted ones (design A6.3). */
export const DOCUMENT_DOWNLOAD_TTL_SECONDS = { internal: 60, restricted: 300 } as const;
export const DOCUMENT_UPLOADS_PER_MINUTE = 10;
export const DOCUMENT_DOWNLOADS_PER_MINUTE = 30;

interface DocumentRow {
  id: string;
  candidate_id: string;
  placement_id: string | null;
  doc_type: DocumentType;
  classification: DocumentClassification;
  file_id: string;
  status: string;
  scan_result: string | null;
  content_type: DocumentContentType;
  size_bytes: number;
  sha256_hex: string | null;
  created_by: string;
  uploader_name: string | null;
  created_at: Date;
  scanned_at: Date | null;
}

const DOCUMENT_COLUMNS = `d.id, d.candidate_id, d.placement_id, d.doc_type, d.classification, d.file_id, f.status, f.scan_result,
  f.content_type, f.size_bytes, f.sha256_hex, d.created_by, u.display_name AS uploader_name, d.created_at, f.scanned_at`;
const DOCUMENT_FROM = `eureka.document d JOIN eureka.file_object f ON f.id = d.file_id LEFT JOIN eureka.app_user u ON u.id = d.created_by`;

/**
 * The response shape. `id` is the stable document id the paperwork checklist
 * links to; `docType` is a key of DOCUMENT_TYPES (packages/shared).
 */
const present = (r: DocumentRow) => ({
  id: r.id,
  candidateId: r.candidate_id,
  placementId: r.placement_id,
  docType: r.doc_type,
  docTypeLabel: DOCUMENT_TYPES[r.doc_type]?.label ?? r.doc_type,
  classification: r.classification,
  status: r.status,
  /** Why a scan did not pass (GuardDuty result or the worker's reason code); null otherwise. */
  reason: r.status === "clean" ? null : r.scan_result,
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
  sha256: r.sha256_hex,
  uploadedBy: { id: r.created_by, name: r.uploader_name },
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

type Owner = { kind: "candidate"; id: string } | { kind: "placement"; id: string };

/**
 * Paperwork and compliance documents (FR-PPR-01 to 03) on the document
 * quarantine pipeline (design A6.5), shared with resumes. Read-before-write:
 * 404 when the candidate (or placement) is not readable, 403 when
 * document:read / document:upload (and document.restricted:read for
 * restricted types) does not cover the candidate. RLS (document_read) and the
 * definer functions of migration 0043 apply the same rules in the database;
 * authz.document_download also enforces step-up and writes the access log.
 */
@Injectable()
export class DocumentsService {
  private readonly uploadLimiter = new RateLimiter(DOCUMENT_UPLOADS_PER_MINUTE, 60_000);
  private readonly downloadLimiter = new RateLimiter(DOCUMENT_DOWNLOADS_PER_MINUTE, 60_000);

  constructor(
    private readonly db: DbService,
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

  /** The owner's candidate id: the candidate itself, or a placement readable under placement RLS. */
  private async candidateOf(c: pg.PoolClient, owner: Owner): Promise<string> {
    if (owner.kind === "candidate") return owner.id;
    const p = (await c.query<{ candidate_id: string }>(`SELECT candidate_id FROM eureka.placement WHERE id = $1`, [owner.id])).rows[0];
    if (!p) throw new NotFoundException();
    return p.candidate_id;
  }

  async list(user: AuthedUser, owner: Owner) {
    return this.db.withUser(user.id, async (c) => {
      const candidateId = await this.candidateOf(c, owner);
      const access = documentAccess(user.access, await this.candidate(c, user, candidateId));
      if (!access.read) throw new ForbiddenException("Not permitted");
      const where = owner.kind === "candidate" ? `d.candidate_id = $1` : `d.placement_id = $1`;
      const { rows } = await c.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT 200`, [owner.id]);
      return {
        items: rows.map(present),
        canUpload: access.upload,
        canUploadRestricted: access.uploadRestricted,
        canViewRestricted: access.readRestricted,
      };
    });
  }

  /** The body is parsed after the scope check, so callers without upload rights get 403/404, not 422. */
  async requestUpload(user: AuthedUser, owner: Owner, parse: () => DocumentUpload) {
    return this.db.withUser(user.id, async (c) => {
      const candidateId = await this.candidateOf(c, owner);
      const access = documentAccess(user.access, await this.candidate(c, user, candidateId));
      if (!access.upload) throw new ForbiddenException("Not permitted");
      const body = parse();
      if (DOCUMENT_TYPES[body.docType].classification === "restricted" && !access.uploadRestricted) {
        throw new ForbiddenException("Not permitted");
      }
      if (!this.uploadLimiter.take(user.id)) {
        throw new HttpException("Too many uploads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      // The definer re-checks scope, writes the rows and audits document.upload_requested (ids, type, size).
      const row = (await c.query<{ document_id: string; file_id: string; classification: DocumentClassification; upload_expires_at: Date }>(
        `SELECT * FROM authz.create_document_upload($1, $2, $3, $4, $5)`,
        [owner.kind === "candidate" ? owner.id : null, owner.kind === "placement" ? owner.id : null, body.docType, body.contentType, body.size],
      ).catch(mapDbError)).rows[0]!;
      const upload = await this.storage.presignUpload({
        key: documentQuarantineKey(row.file_id), contentType: body.contentType, size: body.size, expiresSeconds: DOCUMENT_UPLOAD_TTL_SECONDS,
      });
      return { id: row.document_id, fileId: row.file_id, classification: row.classification, status: "pending", upload };
    });
  }

  /**
   * A short-lived download link. Restricted documents need a live step-up of
   * this session: 403 `step_up_required` otherwise (the refusal is audited, so
   * it is raised after the transaction commits). Each link issued is one
   * access-log row and one audit row (document.viewed / document.downloaded).
   */
  async download(user: AuthedUser, documentId: string) {
    const out = await this.db.withUser(user.id, async (c) => {
      const d = (await c.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE d.id = $1`, [documentId])).rows[0];
      if (!d) throw new NotFoundException();
      const access = documentAccess(user.access, await this.candidate(c, user, d.candidate_id));
      if (!access.read || (d.classification === "restricted" && !access.readRestricted)) throw new NotFoundException();
      if (!this.downloadLimiter.take(user.id)) {
        throw new HttpException("Too many downloads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      const r = (await c.query<{ outcome: string; file_id: string | null; classification: DocumentClassification }>(
        `SELECT outcome, file_id, classification FROM authz.document_download($1, $2)`, [documentId, user.sessionHash]).catch(mapDbError)).rows[0]!;
      if (r.outcome !== "ok" || !r.file_id) return { outcome: r.outcome } as const;
      const ttl = DOCUMENT_DOWNLOAD_TTL_SECONDS[r.classification];
      const url = await this.storage.presignDownload({
        key: documentStoredKey(r.file_id, r.classification), contentType: d.content_type,
        fileName: documentDownloadName(d.doc_type, d.id, d.content_type), expiresSeconds: ttl,
      });
      return { outcome: "ok", url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() } as const;
    });
    if (out.outcome === "step_up_required") throw new ForbiddenException("step_up_required");
    if (out.outcome !== "ok") throw new ConflictException("not_available");
    return { url: out.url, expiresAt: out.expiresAt };
  }

  /**
   * The document access log: everything for org admins (audit:read), or one
   * restricted document for those who can read it (HR, Accounts, Immigration).
   * RLS (document_access_read) applies the same rule.
   */
  async accessLog(user: AuthedUser, q: z.infer<typeof AccessLogQuery>) {
    const auditor = can(user.access, "audit:read");
    if (!auditor && !can(user.access, "document.restricted:read")) throw new ForbiddenException("Not permitted");
    if (!auditor && !q.documentId) throw new UnprocessableEntityException("documentId is required");
    return this.db.withUser(user.id, async (c) => {
      if (!auditor) {
        const d = (await c.query<{ candidate_id: string; classification: string }>(
          `SELECT candidate_id, classification FROM eureka.document WHERE id = $1`, [q.documentId])).rows[0];
        if (!d) throw new NotFoundException();
        const access = documentAccess(user.access, await this.candidate(c, user, d.candidate_id));
        if (d.classification !== "restricted" || !access.readRestricted) throw new ForbiddenException("Not permitted");
      }
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.documentId) { params.push(q.documentId); where.push(`a.document_id = $${params.length}`); }
      if (q.before) { params.push(q.before); where.push(`a.at < $${params.length}`); }
      params.push(q.limit);
      const { rows } = await c.query<{ id: string; document_id: string; doc_type: string; classification: string; user_id: string;
        user_name: string | null; action: string; step_up_grant_id: string | null; at: Date }>(
        `SELECT a.id, a.document_id, a.doc_type, a.classification, a.user_id, u.display_name AS user_name, a.action, a.step_up_grant_id, a.at
         FROM eureka.document_access a LEFT JOIN eureka.app_user u ON u.id = a.user_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY a.at DESC, a.id DESC LIMIT $${params.length}`, params);
      return {
        items: rows.map((r) => ({
          id: r.id, documentId: r.document_id, docType: r.doc_type, classification: r.classification,
          user: { id: r.user_id, name: r.user_name }, action: r.action, steppedUp: r.step_up_grant_id !== null, at: r.at.toISOString(),
        })),
      };
    });
  }

  async types() {
    return this.db.system(async (c) => {
      const { rows } = await c.query<{ key: string; label: string; classification: string }>(
        `SELECT key, label, classification FROM authz.document_type ORDER BY classification, label`);
      return { items: rows };
    });
  }
}
