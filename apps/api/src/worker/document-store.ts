import { createHash } from "node:crypto";
import { link, readFile, unlink } from "node:fs/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { fakeScanResult, localPath, writeTempBeside } from "../platform/storage/local-files.js";

/**
 * The worker's view of the documents bucket for the scan-and-promote job.
 * A verdict is tied to one object version: the job reads, checks and promotes
 * exactly the version whose scan tag it saw, so a second upload to the same
 * quarantine key cannot slip through between the check and the copy.
 */
export type ScanVerdict =
  | { state: "missing" }
  | { state: "pending"; versionId: string; versions?: number }
  | { state: "scanned"; result: string; versionId: string; versions?: number };

/** A different object already exists under a clean/ key (create-only write refused). */
export class CleanObjectConflictError extends Error {}

export interface DocumentStore {
  readonly kind: "s3" | "local";
  verdict(key: string, signal?: AbortSignal): Promise<ScanVerdict>;
  /** The bytes of one version; throws when it is larger than maxBytes. */
  read(key: string, versionId: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  /**
   * Create-only write of a scanned file to clean/ or restricted/. A
   * restricted/ object is encrypted with the restricted KMS key (`kmsKeyId`,
   * required there) and no S3 bucket key, so the KMS encryption context is
   * the object's own ARN (what the IAM conditions match on).
   */
  putClean(key: string, body: Buffer, sha256: Buffer, contentType: string, signal?: AbortSignal, opts?: { kmsKeyId?: string }): Promise<void>;
  /** Permanently removes one quarantine version (infected files, files promoted to clean/). */
  deleteVersion(key: string, versionId: string, signal?: AbortSignal): Promise<void>;
}

/** Promotion writes clean/ or restricted/ only; restricted/ needs the restricted key. Returns whether it is restricted. */
function promotionTarget(key: string, kmsKeyId: string | undefined): boolean {
  if (key.startsWith("clean/")) return false;
  if (!key.startsWith("restricted/")) throw new Error("promotion writes clean/ or restricted/ only");
  if (!kmsKeyId) throw new Error("restricted/ objects need the restricted KMS key");
  return true;
}

/** The tag GuardDuty Malware Protection for S3 writes on each scanned object. */
export const SCAN_TAG = "GuardDutyMalwareScanStatus";

export class ObjectTooLargeError extends Error {}

/**
 * S3 (infra/modules/stack/app.tf, worker role): ListBucketVersions limited to
 * quarantine/resumes/ and quarantine/documents/ (a missing object is then "no
 * versions" instead of an ambiguous 403), Get(Object|ObjectVersion)(Tagging)
 * and DeleteObjectVersion there, PutObject (create-only) and GetObject
 * (HeadObject checksum after a 412) on clean/resumes/*, clean/documents/* and
 * restricted/documents/*. Encryption is the bucket default (SSE-KMS, data
 * key), except restricted/ (the restricted key, set per object).
 */
export class S3DocumentStore implements DocumentStore {
  readonly kind = "s3" as const;
  constructor(private readonly s3: Pick<S3Client, "send">, private readonly bucket: string) {}

  async verdict(key: string, signal?: AbortSignal): Promise<ScanVerdict> {
    const list = await this.s3.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key, MaxKeys: 50 }), { abortSignal: signal });
    const deleted = (list.DeleteMarkers ?? []).some((d) => d.Key === key && d.IsLatest);
    const versions = (list.Versions ?? []).filter((v) => v.Key === key);
    const latest = versions.find((v) => v.IsLatest);
    if (deleted || !latest?.VersionId) return { state: "missing" };
    // The latest version decides: a newer upload that is not scanned yet means wait, even if an older one was clean.
    const tags = await this.s3.send(new GetObjectTaggingCommand({ Bucket: this.bucket, Key: key, VersionId: latest.VersionId }), { abortSignal: signal });
    const result = tags.TagSet?.find((t) => t.Key === SCAN_TAG)?.Value;
    return result
      ? { state: "scanned", result, versionId: latest.VersionId, versions: versions.length }
      : { state: "pending", versionId: latest.VersionId, versions: versions.length };
  }

  async read(key: string, versionId: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }), { abortSignal: signal });
    if (out.ContentLength !== undefined && out.ContentLength > maxBytes) throw new ObjectTooLargeError(`${key} is larger than ${maxBytes} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new ObjectTooLargeError(`${key} is larger than ${maxBytes} bytes`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async putClean(key: string, body: Buffer, sha256: Buffer, contentType: string, signal?: AbortSignal, opts: { kmsKeyId?: string } = {}): Promise<void> {
    const restricted = promotionTarget(key, opts.kmsKeyId);
    const checksum = sha256.toString("base64");
    try {
      // Create-only: a clean object is never overwritten (a retry finds its own bytes, compared below).
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length,
        ChecksumSHA256: checksum, IfNoneMatch: "*",
        ...(restricted ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: opts.kmsKeyId, BucketKeyEnabled: false } : {}),
      }), { abortSignal: signal });
      return;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
      if (e?.name !== "PreconditionFailed" && e?.$metadata?.httpStatusCode !== 412) throw err;
    }
    // HeadObject (s3:GetObject on clean/resumes/*, metadata only).
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED" }), { abortSignal: signal });
    if (head.ChecksumSHA256 !== checksum || head.ContentLength !== body.length) {
      throw new CleanObjectConflictError(`${key} already exists with different content`);
    }
  }

  async deleteVersion(key: string, versionId: string, signal?: AbortSignal): Promise<void> {
    if (!key.startsWith("quarantine/")) throw new Error("only quarantine versions are deleted");
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }), { abortSignal: signal });
  }
}

/**
 * Local directory (development, tests) with the fake scanner standing in for
 * GuardDuty. The version id is the content hash, so a replaced file is a new
 * version, as in S3.
 */
export class LocalDocumentStore implements DocumentStore {
  readonly kind = "local" as const;
  constructor(private readonly root: string, private readonly scan: (body: Buffer) => string | null = fakeScanResult) {}

  private async load(key: string): Promise<Buffer | null> {
    try { return await readFile(localPath(this.root, key)); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private versionOf(body: Buffer): string {
    return createHash("sha256").update(body).digest("hex").slice(0, 32);
  }

  async verdict(key: string): Promise<ScanVerdict> {
    const body = await this.load(key);
    if (!body) return { state: "missing" };
    const versionId = this.versionOf(body);
    const result = this.scan(body);
    return result ? { state: "scanned", result, versionId } : { state: "pending", versionId };
  }

  async read(key: string, versionId: string, maxBytes: number): Promise<Buffer> {
    const body = await this.load(key);
    if (!body || this.versionOf(body) !== versionId) throw new Error(`${key}: version ${versionId} not found`);
    if (body.length > maxBytes) throw new ObjectTooLargeError(`${key} is larger than ${maxBytes} bytes`);
    return body;
  }

  async putClean(key: string, body: Buffer, sha256: Buffer, _contentType?: string, _signal?: AbortSignal, opts: { kmsKeyId?: string } = {}): Promise<void> {
    promotionTarget(key, opts.kmsKeyId);
    const path = localPath(this.root, key);
    const tmp = await writeTempBeside(path, body);
    try {
      await link(tmp, path); // create-only, like If-None-Match: *
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!createHash("sha256").update(await readFile(path)).digest().equals(sha256)) {
        throw new CleanObjectConflictError(`${key} already exists with different content`);
      }
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  async deleteVersion(key: string, versionId: string): Promise<void> {
    if (!key.startsWith("quarantine/")) throw new Error("only quarantine versions are deleted");
    const body = await this.load(key);
    if (body && this.versionOf(body) === versionId) await unlink(localPath(this.root, key));
  }
}
