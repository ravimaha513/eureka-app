import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

/** Where export files go. `sha256` is the raw 32-byte digest of `body`. */
export interface ExportSink {
  readonly kind: "s3" | "dir";
  put(key: string, body: Buffer, sha256: Buffer, contentType: string): Promise<void>;
}

/**
 * S3 sink for the audit bucket. Encryption is left to the bucket default
 * (SSE-KMS with the data key): passing ServerSideEncryption without a key id
 * would select the AWS-managed aws/s3 key instead. Object Lock retention is
 * the bucket default too. S3 verifies x-amz-checksum-sha256 and rejects the
 * upload if the bytes do not match.
 */
export class S3Sink implements ExportSink {
  readonly kind = "s3" as const;
  constructor(private readonly s3: Pick<S3Client, "send">, private readonly bucket: string) {}

  async put(key: string, body: Buffer, sha256: Buffer, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.length,
      ChecksumSHA256: sha256.toString("base64"),
    }));
  }
}

/** Local directory sink (development and tests). Writes atomically via rename. */
export class DirSink implements ExportSink {
  readonly kind = "dir" as const;
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  async put(key: string, body: Buffer): Promise<void> {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error(`export key escapes EXPORT_DIR: ${key}`);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }
}
