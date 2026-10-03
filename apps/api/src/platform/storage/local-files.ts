import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Default directory of the local document driver (API and worker must agree):
 * under the working directory (gitignored `.local/`), never the shared OS temp
 * directory, where other local users could pre-create or read files.
 */
export const DEFAULT_LOCAL_STORAGE_DIR = join(process.cwd(), ".local", "documents");

/**
 * Writes `data` to a new, unpredictably named temporary file next to `path`
 * (owner-only directory and file, exclusive create so an existing file or
 * symlink is never reused) and returns its path; the caller renames or links
 * it into place.
 */
export async function writeTempBeside(path: string, data: Buffer): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  await writeFile(tmp, data, { flag: "wx", mode: 0o600 });
  return tmp;
}

/** Path of an object key under the local root; refuses keys that would escape it. */
export function localPath(root: string, key: string): string {
  if (!/^(quarantine|clean|restricted)\/[a-z]+\/[0-9a-f-]{36}$/.test(key)) throw new Error("invalid object key");
  const base = resolve(root);
  const p = resolve(join(base, key));
  if (!p.startsWith(base + sep)) throw new Error("object key escapes the storage root");
  return p;
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/**
 * Fake malware scanner for development and tests (stands in for GuardDuty's
 * GuardDutyMalwareScanStatus tag). Deterministic on the file content:
 *   the EICAR test string              -> THREATS_FOUND
 *   "EUREKA-FAKE-SCAN:FAILED"          -> FAILED
 *   "EUREKA-FAKE-SCAN:UNSUPPORTED"     -> UNSUPPORTED
 *   "EUREKA-FAKE-SCAN:PENDING"         -> no result yet (the scan never finishes)
 *   anything else                      -> NO_THREATS_FOUND
 */
export function fakeScanResult(body: Buffer): string | null {
  if (body.includes(Buffer.from(EICAR, "latin1"))) return "THREATS_FOUND";
  if (body.includes(Buffer.from("EUREKA-FAKE-SCAN:FAILED"))) return "FAILED";
  if (body.includes(Buffer.from("EUREKA-FAKE-SCAN:UNSUPPORTED"))) return "UNSUPPORTED";
  if (body.includes(Buffer.from("EUREKA-FAKE-SCAN:PENDING"))) return null;
  return "NO_THREATS_FOUND";
}

export const EICAR_TEST_STRING = EICAR;
