import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

/** Default directory of the local document driver (API and worker must agree). */
export const DEFAULT_LOCAL_STORAGE_DIR = join(tmpdir(), "eureka-documents");

/** Path of an object key under the local root; refuses keys that would escape it. */
export function localPath(root: string, key: string): string {
  if (!/^(quarantine|clean)\/[a-z]+\/[0-9a-f-]{36}$/.test(key)) throw new Error("invalid object key");
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
