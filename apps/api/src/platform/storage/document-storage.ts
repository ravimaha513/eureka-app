import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DEFAULT_LOCAL_STORAGE_DIR } from "./local-files.js";

/**
 * Where documents live (design A5 "Files"). The API never handles file bytes:
 * it signs a short-lived POST into quarantine/ and a short-lived GET for clean
 * objects. "s3" in AWS; "local" (a directory, served by local-routes.ts) for
 * development and tests, refused in production by the config.
 */
export interface UploadTicket {
  /** Form POST target. */
  url: string;
  /** Form fields to send before the file field ("file"). */
  fields: Record<string, string>;
  expiresAt: string;
}

export interface UploadRequest { key: string; contentType: string; size: number; expiresSeconds: number }
export interface DownloadRequest { key: string; contentType: string; fileName: string; expiresSeconds: number }

export interface DocumentStorage {
  readonly kind: "s3" | "local";
  presignUpload(r: UploadRequest): Promise<UploadTicket>;
  presignDownload(r: DownloadRequest): Promise<string>;
}

export const DOCUMENT_STORAGE = Symbol("DOCUMENT_STORAGE");

/** `attachment` with an ASCII-only name (callers pass ids and versions, never user input). */
export function attachmentDisposition(fileName: string): string {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(fileName)) throw new Error("unsafe download name");
  return `attachment; filename="${fileName}"`;
}

const quarantineOnly = (key: string) => {
  if (!key.startsWith("quarantine/")) throw new Error("uploads go to quarantine/ only");
};
const cleanOnly = (key: string) => {
  if (!key.startsWith("clean/")) throw new Error("downloads are signed for clean/ only");
};

/**
 * S3: presigned POST whose policy pins the bucket, the exact key, the exact
 * Content-Type and an exact content-length-range (the declared size), signed
 * by the API task role (which may PutObject only under quarantine/resumes/,
 * and has no PutObjectTagging, so a client cannot add the scan tag). Encryption
 * is the bucket default (SSE-KMS). Downloads: presigned GET forcing
 * Content-Disposition: attachment and the stored type.
 */
export class S3DocumentStorage implements DocumentStorage {
  readonly kind = "s3" as const;
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async presignUpload(r: UploadRequest): Promise<UploadTicket> {
    quarantineOnly(r.key);
    const expiresAt = new Date(Date.now() + r.expiresSeconds * 1000).toISOString();
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: r.key,
      Conditions: [["content-length-range", r.size, r.size]],
      // Fields become exact-match conditions ({"Content-Type": ...}); the key condition is added too.
      Fields: { "Content-Type": r.contentType },
      Expires: r.expiresSeconds,
    });
    return { url, fields, expiresAt };
  }

  async presignDownload(r: DownloadRequest): Promise<string> {
    cleanOnly(r.key);
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucket,
      Key: r.key,
      ResponseContentDisposition: attachmentDisposition(r.fileName),
      ResponseContentType: r.contentType,
    }), { expiresIn: r.expiresSeconds });
  }
}

/** Fields the local POST accepts, in the S3 spirit: everything signed, nothing else allowed. */
/** `purpose` binds a signature to one route: an upload policy is never a download link and vice versa. */
export interface LocalUploadPolicy { purpose: "upload"; key: string; contentType: string; size: number; expiresAt: string }
export interface LocalDownloadPolicy { purpose: "download"; key: string; contentType: string; fileName: string; expiresAt: string }

export const LOCAL_UPLOAD_PATH = "/api/local-storage/upload";
export const LOCAL_DOWNLOAD_PATH = "/api/local-storage/object";

/**
 * Local driver: the same contract as S3, served by the API itself
 * (local-routes.ts) from a directory. Policies are HMAC-signed with a key
 * derived from the session secret, so only this API can mint them.
 */
export class LocalDocumentStorage implements DocumentStorage {
  readonly kind = "local" as const;
  private readonly key: Buffer;

  constructor(readonly root: string, secret: string) {
    this.key = Buffer.from(hkdfSync("sha256", secret, "eureka-local-storage", "documents", 32));
  }

  sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  /** Returns the decoded policy when the signature is valid and it has not expired. */
  verify<T extends { expiresAt: string }>(policy: string, signature: string): T | null {
    const expected = Buffer.from(this.sign(policy));
    const got = Buffer.from(signature);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    let p: T;
    try { p = JSON.parse(Buffer.from(policy, "base64url").toString("utf8")) as T; } catch { return null; }
    const exp = Date.parse(p.expiresAt);
    return Number.isFinite(exp) && exp > Date.now() ? p : null;
  }

  private encode(p: object): string {
    return Buffer.from(JSON.stringify(p)).toString("base64url");
  }

  async presignUpload(r: UploadRequest): Promise<UploadTicket> {
    quarantineOnly(r.key);
    const expiresAt = new Date(Date.now() + r.expiresSeconds * 1000).toISOString();
    const policy = this.encode({ purpose: "upload", key: r.key, contentType: r.contentType, size: r.size, expiresAt } satisfies LocalUploadPolicy);
    return {
      url: LOCAL_UPLOAD_PATH,
      fields: { key: r.key, "Content-Type": r.contentType, policy, signature: this.sign(policy) },
      expiresAt,
    };
  }

  async presignDownload(r: DownloadRequest): Promise<string> {
    cleanOnly(r.key);
    attachmentDisposition(r.fileName);
    const expiresAt = new Date(Date.now() + r.expiresSeconds * 1000).toISOString();
    const policy = this.encode({ purpose: "download", key: r.key, contentType: r.contentType, fileName: r.fileName, expiresAt } satisfies LocalDownloadPolicy);
    return `${LOCAL_DOWNLOAD_PATH}?policy=${policy}&signature=${this.sign(policy)}`;
  }
}

/** S3 when DOCUMENTS_BUCKET is set, else the local directory (the config refuses that in production). */
export function createDocumentStorage(c: {
  DOCUMENTS_BUCKET?: string; AWS_REGION?: string; LOCAL_STORAGE_DIR?: string; SESSION_SECRET: string;
}): DocumentStorage {
  if (c.DOCUMENTS_BUCKET) {
    return new S3DocumentStorage(new S3Client({ region: c.AWS_REGION, maxAttempts: 3 }), c.DOCUMENTS_BUCKET);
  }
  return new LocalDocumentStorage(c.LOCAL_STORAGE_DIR ?? DEFAULT_LOCAL_STORAGE_DIR, c.SESSION_SECRET);
}
