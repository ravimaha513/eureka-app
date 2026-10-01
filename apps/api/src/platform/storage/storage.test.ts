import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { decideScan, DEFAULT_RESUME_SCAN_OPTIONS } from "../../worker/jobs/resume-scan.js";
import { resumeCleanKey, resumeDownloadName, resumeQuarantineKey } from "./content.js";
import { LocalDocumentStorage, S3DocumentStorage, attachmentDisposition } from "./document-storage.js";
import { localPath } from "./local-files.js";
import { parseMultipart } from "./local-routes.js";

const ID = "0b9f0f3e-6a43-4c55-9b54-1f2d3c4b5a69";
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const s3 = new S3Client({ region: "us-east-2", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" } });
const storage = new S3DocumentStorage(s3, "eureka-prod-documents-123456789012");

describe("S3 presigned POST (upload policy conditions)", () => {
  it("pins bucket, exact key, exact content type and exact size, expiring in 5 minutes", async () => {
    const before = Date.now();
    const t = await storage.presignUpload({ key: resumeQuarantineKey(ID), contentType: PDF, size: 12345, expiresSeconds: 300 });
    expect(new URL(t.url).host).toBe("eureka-prod-documents-123456789012.s3.us-east-2.amazonaws.com");
    const policy = JSON.parse(Buffer.from(t.fields.Policy!, "base64").toString("utf8")) as { expiration: string; conditions: unknown[] };
    expect(policy.conditions).toEqual(expect.arrayContaining([
      { bucket: "eureka-prod-documents-123456789012" },
      { key: `quarantine/resumes/${ID}` },
      { "Content-Type": PDF },
      ["content-length-range", 12345, 12345],
      { "X-Amz-Algorithm": "AWS4-HMAC-SHA256" },
      { "X-Amz-Security-Token": "token" },
    ]));
    // No prefix (starts-with) conditions: the client cannot pick another key or type.
    expect(JSON.stringify(policy.conditions)).not.toContain("starts-with");
    // No tagging, ACL or redirect fields can be added: every form field must match a condition.
    expect(Object.keys(policy.conditions.reduce((a: object, c) => ({ ...a, ...(Array.isArray(c) ? {} : c as object) }), {})).sort())
      .toEqual(["Content-Type", "X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Security-Token", "bucket", "key"]);
    const exp = Date.parse(policy.expiration);
    expect(exp - before).toBeGreaterThan(295_000);
    expect(exp - before).toBeLessThanOrEqual(301_000);
    expect(t.fields.key).toBe(`quarantine/resumes/${ID}`);
    expect(t.fields["Content-Type"]).toBe(PDF);
  });

  it("refuses keys outside quarantine/", async () => {
    await expect(storage.presignUpload({ key: resumeCleanKey(ID), contentType: PDF, size: 1, expiresSeconds: 300 })).rejects.toThrow(/quarantine/);
  });
});

describe("S3 presigned GET (download)", () => {
  it("is short-lived, forces an attachment and the stored type, for clean/ only", async () => {
    const url = new URL(await storage.presignDownload({ key: resumeCleanKey(ID), contentType: PDF, fileName: resumeDownloadName(3, PDF), expiresSeconds: 60 }));
    expect(url.pathname).toBe(`/clean/resumes/${ID}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="resume-v3.pdf"');
    expect(url.searchParams.get("response-content-type")).toBe(PDF);
    await expect(storage.presignDownload({ key: resumeQuarantineKey(ID), contentType: PDF, fileName: "a.pdf", expiresSeconds: 60 })).rejects.toThrow(/clean/);
  });

  it("download names are generated, never user input", () => {
    expect(resumeDownloadName(2, DOCX)).toBe("resume-v2.docx");
    expect(() => attachmentDisposition('x"; filename="evil.html')).toThrow();
    expect(() => attachmentDisposition("Jane Doe résumé.pdf")).toThrow();
  });
});

describe("object keys", () => {
  it("derive from a uuid only and stay under the local root", () => {
    expect(() => resumeQuarantineKey("../../etc/passwd")).toThrow();
    expect(() => resumeCleanKey("x")).toThrow();
    expect(localPath("/tmp/docs", resumeCleanKey(ID))).toBe(`/tmp/docs/clean/resumes/${ID}`);
    expect(() => localPath("/tmp/docs", "clean/resumes/../../../etc/passwd")).toThrow();
  });
});
describe("local driver policies", () => {
  const local = new LocalDocumentStorage("/tmp/docs", "local-dev-session-secret-local-dev-session");
  it("verifies its own signature and expiry; tampering or another secret fails", async () => {
    const t = await local.presignUpload({ key: resumeQuarantineKey(ID), contentType: PDF, size: 10, expiresSeconds: 300 });
    expect(local.verify(t.fields.policy!, t.fields.signature!)).toMatchObject({ key: resumeQuarantineKey(ID), contentType: PDF, size: 10 });
    const forged = Buffer.from(JSON.stringify({ key: resumeQuarantineKey(ID), contentType: "text/html", size: 10, expiresAt: "2999-01-01T00:00:00Z" })).toString("base64url");
    expect(local.verify(forged, t.fields.signature!)).toBeNull();
    const other = new LocalDocumentStorage("/tmp/docs", "another-secret-another-secret-another-secret");
    expect(other.verify(t.fields.policy!, t.fields.signature!)).toBeNull();
    const expired = await local.presignUpload({ key: resumeQuarantineKey(ID), contentType: PDF, size: 10, expiresSeconds: -1 });
    expect(local.verify(expired.fields.policy!, expired.fields.signature!)).toBeNull();
  });

  it("parses multipart form data", () => {
    const body = Buffer.from("--b\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\nk\r\n--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.pdf\"\r\nContent-Type: application/pdf\r\n\r\n%PDF-\r\n1\r\n--b--\r\n");
    const parts = parseMultipart(body, "multipart/form-data; boundary=b");
    expect(parts?.map((p) => [p.name, p.data.toString()])).toEqual([["key", "k"], ["file", "%PDF-\r\n1"]]);
    expect(parseMultipart(Buffer.from("junk"), "multipart/form-data; boundary=b")).toBeNull();
  });
});

describe("scan decision (timeouts)", () => {
  const created = new Date("2026-10-01T10:00:00Z");
  const row = { created_at: created, upload_expires_at: new Date("2026-10-01T10:05:00Z") };
  const o = DEFAULT_RESUME_SCAN_OPTIONS; // grace 10 min, scan timeout 60 min
  const at = (min: number) => new Date(created.getTime() + min * 60_000);

  it("missing object: wait until expiry + grace, then expire", () => {
    expect(decideScan({ state: "missing" }, row, at(14), o)).toEqual({ kind: "wait" });
    expect(decideScan({ state: "missing" }, row, at(16), o)).toEqual({ kind: "expire" });
  });
  it("uploaded, no scan result: wait until the scan timeout, then fail", () => {
    expect(decideScan({ state: "pending", versionId: "v1" }, row, at(59), o)).toEqual({ kind: "wait" });
    expect(decideScan({ state: "pending", versionId: "v1" }, row, at(61), o)).toEqual({ kind: "timeout", versionId: "v1" });
  });
  it("scanned: act on the result of that exact version", () => {
    expect(decideScan({ state: "scanned", result: "THREATS_FOUND", versionId: "v2" }, row, at(1), o))
      .toEqual({ kind: "scanned", result: "THREATS_FOUND", versionId: "v2" });
  });
});
