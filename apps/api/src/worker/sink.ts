import { createHash } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

/**
 * Where export files go. `sha256` is the raw 32-byte digest of `body`. Writes
 * are create-only: "written" when this call created the object, "existed" when
 * an object with identical content (same SHA-256) was already there. An
 * existing object with different content is an error.
 */
export interface ExportSink {
  readonly kind: "s3" | "dir";
  put(key: string, body: Buffer, sha256: Buffer, contentType: string, signal?: AbortSignal): Promise<PutResult>;
}

export type PutResult = "written" | "existed";

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412;
}

/**
 * S3 sink for the audit bucket. Encryption is left to the bucket default
 * (SSE-KMS with the data key): passing ServerSideEncryption without a key id
 * would select the AWS-managed aws/s3 key instead. Object Lock retention is
 * the bucket default too. S3 verifies x-amz-checksum-sha256 and rejects the
 * upload if the bytes do not match.
 *
 * `If-None-Match: *` makes the upload create-only, so a retry after a failed
 * ledger insert does not add another retained object version. On 412 the
 * existing object's SHA-256 (HeadObject, checksum mode) must equal ours; then
 * the day counts as written. HeadObject needs s3:GetObject on audit/*.
 */
export class S3Sink implements ExportSink {
  readonly kind = "s3" as const;
  constructor(private readonly s3: Pick<S3Client, "send">, private readonly bucket: string) {}

  async put(key: string, body: Buffer, sha256: Buffer, contentType: string, signal?: AbortSignal): Promise<PutResult> {
    const checksum = sha256.toString("base64");
    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        ChecksumSHA256: checksum,
        IfNoneMatch: "*",
      }), { abortSignal: signal });
      return "written";
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
    }
    const head = await this.s3.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED" }), { abortSignal: signal });
    if (head.ChecksumSHA256 !== checksum || (head.ContentLength !== undefined && head.ContentLength !== body.length)) {
      throw new Error(`s3://${this.bucket}/${key} already exists with different content ` +
        `(sha256 ${head.ChecksumSHA256 ?? "unknown"}, expected ${checksum})`);
    }
    return "existed";
  }
}

/** Local directory sink (development and tests). Create-only via hard link of a temp file. */
export class DirSink implements ExportSink {
  readonly kind = "dir" as const;
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  async put(key: string, body: Buffer, sha256: Buffer): Promise<PutResult> {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error(`export key escapes EXPORT_DIR: ${key}`);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, body);
    try {
      await link(tmp, path);
      return "written";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = createHash("sha256").update(await readFile(path)).digest();
      if (!existing.equals(sha256)) throw new Error(`${path} already exists with different content`);
      return "existed";
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
}
