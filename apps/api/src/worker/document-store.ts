import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { fakeScanResult, localPath } from "../platform/storage/local-files.js";

/**
 * The worker's view of the documents bucket for the scan-and-promote job.
 * A verdict is tied to one object version: the job reads, checks and promotes
 * exactly the version whose scan tag it saw, so a second upload to the same
 * quarantine key cannot slip through between the check and the copy.
 */
export type ScanVerdict =
  | { state: "missing" }
  | { state: "pending"; versionId: string }
  | { state: "scanned"; result: string; versionId: string };

export interface DocumentStore {
  readonly kind: "s3" | "local";
  verdict(key: string, signal?: AbortSignal): Promise<ScanVerdict>;
  /** The bytes of one version; throws when it is larger than maxBytes. */
  read(key: string, versionId: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  putClean(key: string, body: Buffer, sha256: Buffer, contentType: string, signal?: AbortSignal): Promise<void>;
  /** Permanently removes one quarantine version (infected files, files promoted to clean/). */
  deleteVersion(key: string, versionId: string, signal?: AbortSignal): Promise<void>;
}

/** The tag GuardDuty Malware Protection for S3 writes on each scanned object. */
export const SCAN_TAG = "GuardDutyMalwareScanStatus";

export class ObjectTooLargeError extends Error {}

/**
 * S3 (infra/modules/stack/app.tf, worker role): ListBucketVersions limited to
 * quarantine/resumes/ (a missing object is then "no versions" instead of an
 * ambiguous 403), Get(Object|ObjectVersion)(Tagging) and DeleteObjectVersion
 * on quarantine/resumes/*, PutObject on clean/resumes/*. Encryption is the
 * bucket default (SSE-KMS, data key).
 */
export class S3DocumentStore implements DocumentStore {
  readonly kind = "s3" as const;
  constructor(private readonly s3: Pick<S3Client, "send">, private readonly bucket: string) {}

  async verdict(key: string, signal?: AbortSignal): Promise<ScanVerdict> {
    const list = await this.s3.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key, MaxKeys: 50 }), { abortSignal: signal });
    const deleted = (list.DeleteMarkers ?? []).some((d) => d.Key === key && d.IsLatest);
    const latest = (list.Versions ?? []).find((v) => v.Key === key && v.IsLatest);
    if (deleted || !latest?.VersionId) return { state: "missing" };
    const tags = await this.s3.send(new GetObjectTaggingCommand({ Bucket: this.bucket, Key: key, VersionId: latest.VersionId }), { abortSignal: signal });
    const result = tags.TagSet?.find((t) => t.Key === SCAN_TAG)?.Value;
    return result ? { state: "scanned", result, versionId: latest.VersionId } : { state: "pending", versionId: latest.VersionId };
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

  async putClean(key: string, body: Buffer, sha256: Buffer, contentType: string, signal?: AbortSignal): Promise<void> {
    if (!key.startsWith("clean/")) throw new Error("promotion writes clean/ only");
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length,
      ChecksumSHA256: sha256.toString("base64"),
    }), { abortSignal: signal });
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

  async putClean(key: string, body: Buffer): Promise<void> {
    if (!key.startsWith("clean/")) throw new Error("promotion writes clean/ only");
    const path = localPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async deleteVersion(key: string, versionId: string): Promise<void> {
    if (!key.startsWith("quarantine/")) throw new Error("only quarantine versions are deleted");
    const body = await this.load(key);
    if (body && this.versionOf(body) === versionId) await unlink(localPath(this.root, key));
  }
}
