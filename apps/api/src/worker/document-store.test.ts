import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand, GetObjectCommand, GetObjectTaggingCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { CleanObjectConflictError, ObjectTooLargeError, S3DocumentStore } from "./document-store.js";

const KEY = "quarantine/resumes/0b9f0f3e-6a43-4c55-9b54-1f2d3c4b5a69";
const CLEAN = "clean/resumes/0b9f0f3e-6a43-4c55-9b54-1f2d3c4b5a69";

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };
/** Mock S3 client: answers by command class; records every call. */
function mockS3(answers: Partial<Record<string, (input: Record<string, unknown>) => unknown>>) {
  const calls: { cmd: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      async send(c: Cmd) {
        const cmd = c.constructor.name;
        calls.push({ cmd, input: c.input });
        const a = answers[cmd];
        if (!a) throw new Error(`unexpected ${cmd}`);
        return a(c.input);
      },
    } as never,
  };
}
const tags = (byVersion: Record<string, string | undefined>) => (i: Record<string, unknown>) => {
  const v = byVersion[String(i.VersionId)];
  return { TagSet: v ? [{ Key: "GuardDutyMalwareScanStatus", Value: v }] : [] };
};

describe("S3DocumentStore: verdicts are pinned to the latest version", () => {
  it("a newer, unscanned upload means wait even when an older version was clean", async () => {
    const s3 = mockS3({
      ListObjectVersionsCommand: () => ({ Versions: [
        { Key: KEY, VersionId: "v2", IsLatest: true },
        { Key: KEY, VersionId: "v1", IsLatest: false },
        { Key: `${KEY}x`, VersionId: "other", IsLatest: true }, // another key sharing the prefix
      ] }),
      GetObjectTaggingCommand: tags({ v1: "NO_THREATS_FOUND" }),
    });
    const v = await new S3DocumentStore(s3.client, "b").verdict(KEY);
    expect(v).toEqual({ state: "pending", versionId: "v2", versions: 2 });
    expect(s3.calls[0]).toMatchObject({ cmd: ListObjectVersionsCommand.name, input: { Bucket: "b", Prefix: KEY } });
    expect(s3.calls[1]).toMatchObject({ cmd: GetObjectTaggingCommand.name, input: { Key: KEY, VersionId: "v2" } });
  });

  it("reports the scan result of the latest version with its id", async () => {
    const s3 = mockS3({
      ListObjectVersionsCommand: () => ({ Versions: [{ Key: KEY, VersionId: "v1", IsLatest: true }] }),
      GetObjectTaggingCommand: tags({ v1: "THREATS_FOUND" }),
    });
    expect(await new S3DocumentStore(s3.client, "b").verdict(KEY)).toEqual({ state: "scanned", result: "THREATS_FOUND", versionId: "v1", versions: 1 });
  });

  it("no versions, or a delete marker on top, is missing", async () => {
    const none = mockS3({ ListObjectVersionsCommand: () => ({}) });
    expect(await new S3DocumentStore(none.client, "b").verdict(KEY)).toEqual({ state: "missing" });
    const deleted = mockS3({ ListObjectVersionsCommand: () => ({
      Versions: [{ Key: KEY, VersionId: "v1", IsLatest: false }], DeleteMarkers: [{ Key: KEY, VersionId: "d1", IsLatest: true }],
    }) });
    expect(await new S3DocumentStore(deleted.client, "b").verdict(KEY)).toEqual({ state: "missing" });
    expect(deleted.calls.map((c) => c.cmd)).toEqual([ListObjectVersionsCommand.name]);
  });
});

describe("S3DocumentStore: reads, deletes and promotion use the scanned version", () => {
  it("GetObject and DeleteObjectVersion carry the scanned VersionId; oversize bodies are refused", async () => {
    const s3 = mockS3({
      GetObjectCommand: () => ({ ContentLength: 5, Body: Readable.from([Buffer.from("%PDF-")]) }),
      DeleteObjectCommand: () => ({}),
    });
    const store = new S3DocumentStore(s3.client, "b");
    expect((await store.read(KEY, "v7", 10)).toString()).toBe("%PDF-");
    await store.deleteVersion(KEY, "v7");
    expect(s3.calls).toEqual([
      { cmd: GetObjectCommand.name, input: { Bucket: "b", Key: KEY, VersionId: "v7" } },
      { cmd: DeleteObjectCommand.name, input: { Bucket: "b", Key: KEY, VersionId: "v7" } },
    ]);
    await expect(store.read(KEY, "v7", 4)).rejects.toBeInstanceOf(ObjectTooLargeError);
    await expect(store.deleteVersion(CLEAN, "v1")).rejects.toThrow(/quarantine/);
  });

  it("writes clean objects create-only with a checksum; on 412 compares the stored checksum", async () => {
    const body = Buffer.from("%PDF-1.7 resume");
    const sha = createHash("sha256").update(body).digest();
    const precondition = Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });

    const fresh = mockS3({ PutObjectCommand: () => ({}) });
    await new S3DocumentStore(fresh.client, "b").putClean(CLEAN, body, sha, "application/pdf");
    expect(fresh.calls[0]).toMatchObject({ cmd: PutObjectCommand.name, input: { Key: CLEAN, IfNoneMatch: "*", ChecksumSHA256: sha.toString("base64") } });

    const same = mockS3({
      PutObjectCommand: () => { throw precondition; },
      HeadObjectCommand: () => ({ ChecksumSHA256: sha.toString("base64"), ContentLength: body.length }),
    });
    await new S3DocumentStore(same.client, "b").putClean(CLEAN, body, sha, "application/pdf");
    expect(same.calls[1]).toMatchObject({ cmd: HeadObjectCommand.name, input: { Key: CLEAN, ChecksumMode: "ENABLED" } });

    const other = mockS3({
      PutObjectCommand: () => { throw precondition; },
      HeadObjectCommand: () => ({ ChecksumSHA256: "different", ContentLength: body.length }),
    });
    await expect(new S3DocumentStore(other.client, "b").putClean(CLEAN, body, sha, "application/pdf")).rejects.toBeInstanceOf(CleanObjectConflictError);
    await expect(new S3DocumentStore(fresh.client, "b").putClean(KEY, body, sha, "application/pdf")).rejects.toThrow(/clean/);
    // Clean objects use the bucket default encryption (no SSE headers).
    expect(fresh.calls[0]!.input).not.toHaveProperty("SSEKMSKeyId");
  });

  it("restricted/ objects are written with the restricted KMS key and no bucket key; refused without the key", async () => {
    const RESTRICTED = "restricted/documents/0b9f0f3e-6a43-4c55-9b54-1f2d3c4b5a69";
    const KMS = "arn:aws:kms:us-east-2:123456789012:key/restricted";
    const body = Buffer.from("%PDF-1.7 i9");
    const sha = createHash("sha256").update(body).digest();
    const s3 = mockS3({ PutObjectCommand: () => ({}) });
    await new S3DocumentStore(s3.client, "b").putClean(RESTRICTED, body, sha, "application/pdf", undefined, { kmsKeyId: KMS });
    expect(s3.calls[0]).toMatchObject({ cmd: PutObjectCommand.name, input: {
      Key: RESTRICTED, IfNoneMatch: "*", ServerSideEncryption: "aws:kms", SSEKMSKeyId: KMS, BucketKeyEnabled: false,
      Metadata: { sha256: sha.toString("hex") } } });
    await expect(new S3DocumentStore(s3.client, "b").putClean(RESTRICTED, body, sha, "application/pdf")).rejects.toThrow(/restricted KMS key/);
    await expect(new S3DocumentStore(s3.client, "b").putClean("public/x", body, sha, "application/pdf", undefined, { kmsKeyId: KMS })).rejects.toThrow(/clean\/ or restricted\//);
    expect(s3.calls).toHaveLength(1);
  });

  it("restricted/ after a 412: a plain HEAD (no checksum mode, so no kms:Decrypt) compares metadata, size and key", async () => {
    const RESTRICTED = "restricted/documents/0b9f0f3e-6a43-4c55-9b54-1f2d3c4b5a69";
    const KMS = "arn:aws:kms:us-east-2:123456789012:key/restricted";
    const body = Buffer.from("%PDF-1.7 i9");
    const sha = createHash("sha256").update(body).digest();
    const precondition = Object.assign(new Error("precondition"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    const head = (h: Record<string, unknown>) => mockS3({ PutObjectCommand: () => { throw precondition; }, HeadObjectCommand: () => h });
    const ours = { Metadata: { sha256: sha.toString("hex") }, ContentLength: body.length, ServerSideEncryption: "aws:kms", SSEKMSKeyId: KMS };

    const same = head(ours);
    await new S3DocumentStore(same.client, "b").putClean(RESTRICTED, body, sha, "application/pdf", undefined, { kmsKeyId: KMS });
    expect(same.calls[1]).toEqual({ cmd: HeadObjectCommand.name, input: { Bucket: "b", Key: RESTRICTED } });

    for (const other of [
      { ...ours, Metadata: { sha256: "0".repeat(64) } },
      { ...ours, Metadata: {} },
      { ...ours, ContentLength: body.length + 1 },
      { ...ours, SSEKMSKeyId: "arn:aws:kms:us-east-2:123456789012:key/data" },
      { ...ours, ServerSideEncryption: "AES256" },
    ]) {
      await expect(new S3DocumentStore(head(other).client, "b").putClean(RESTRICTED, body, sha, "application/pdf", undefined, { kmsKeyId: KMS }))
        .rejects.toBeInstanceOf(CleanObjectConflictError);
    }
  });
});
