import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { RESUME_MAX_BYTES } from "@eureka/shared";
import {
  LOCAL_DOWNLOAD_PATH,
  LOCAL_UPLOAD_PATH,
  attachmentDisposition,
  type LocalDocumentStorage,
  type LocalDownloadPolicy,
  type LocalUploadPolicy,
} from "./document-storage.js";
import { localPath } from "./local-files.js";

interface Part { name: string; filename?: string; data: Buffer }

/** Minimal multipart/form-data parser (local driver only; S3 parses the real thing). */
export function parseMultipart(body: Buffer, contentType: string): Part[] | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return null;
  const delim = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let pos = body.indexOf(delim);
  if (pos !== 0) return null;
  for (;;) {
    pos += delim.length;
    if (body.subarray(pos, pos + 2).toString() === "--") return parts;
    if (body.subarray(pos, pos + 2).toString() !== "\r\n") return null;
    pos += 2;
    const headEnd = body.indexOf("\r\n\r\n", pos);
    if (headEnd < 0) return null;
    const head = body.subarray(pos, headEnd).toString("utf8");
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delim]), headEnd + 4);
    if (next < 0) return null;
    const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(head)?.[1] ?? "";
    const name = /\bname="([^"]*)"/.exec(disp)?.[1];
    if (name === undefined) return null;
    const filename = /\bfilename="([^"]*)"/.exec(disp)?.[1];
    parts.push({ name, ...(filename !== undefined ? { filename } : {}), data: body.subarray(headEnd + 4, next) });
    pos = next + 2;
  }
}

const problem = (reply: FastifyReply, status: number, title: string) =>
  reply.status(status).header("content-type", "application/problem+json").send({ type: "about:blank", title, status });

/**
 * Local stand-in for the S3 bucket (development and tests only; the config
 * refuses the local driver in production). Enforces what the S3 POST policy
 * enforces: valid signature and expiry, exact key, exact Content-Type, exact
 * size, no unsigned fields, a single file field last. Downloads serve clean/
 * objects only, as attachments. Registered outside Nest (no session needed:
 * the signed policy is the authorization, as with S3).
 */
export async function registerLocalStorageRoutes(app: FastifyInstance, storage: LocalDocumentStorage): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser("multipart/form-data", { parseAs: "buffer", bodyLimit: RESUME_MAX_BYTES + 64 * 1024 },
      (_req, body, done) => done(null, body));

    scope.post(LOCAL_UPLOAD_PATH, async (req, reply) => {
      const parts = Buffer.isBuffer(req.body) ? parseMultipart(req.body, String(req.headers["content-type"] ?? "")) : null;
      if (!parts) return problem(reply, 400, "Malformed upload");
      const file = parts[parts.length - 1];
      const fields = new Map(parts.slice(0, -1).map((p) => [p.name, p.data.toString("utf8")]));
      const allowed = ["key", "Content-Type", "policy", "signature"];
      if (!file || file.name !== "file" || fields.size !== allowed.length || !allowed.every((k) => fields.has(k))) {
        return problem(reply, 400, "Unexpected form fields");
      }
      const policy = storage.verify<LocalUploadPolicy>(fields.get("policy")!, fields.get("signature")!);
      if (!policy || policy.purpose !== "upload" || !policy.key.startsWith("quarantine/")) return problem(reply, 403, "Invalid or expired policy");
      if (fields.get("key") !== policy.key || fields.get("Content-Type") !== policy.contentType) {
        return problem(reply, 403, "Policy condition failed");
      }
      if (file.data.length !== policy.size) return problem(reply, 400, "EntityTooSmall or EntityTooLarge");
      const path = localPath(storage.root, policy.key);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, file.data);
      await rename(tmp, path);
      return reply.status(204).send();
    });

    scope.get(LOCAL_DOWNLOAD_PATH, async (req, reply) => {
      const q = req.query as { policy?: string; signature?: string };
      const policy = q.policy && q.signature ? storage.verify<LocalDownloadPolicy>(q.policy, q.signature) : null;
      if (!policy || policy.purpose !== "download" || !policy.key.startsWith("clean/")) return problem(reply, 403, "Invalid or expired link");
      let body: Buffer;
      try { body = await readFile(localPath(storage.root, policy.key)); } catch { return problem(reply, 404, "Not Found"); }
      return reply
        .header("content-type", policy.contentType)
        .header("content-disposition", attachmentDisposition(policy.fileName))
        .send(body);
    });
  });
}
