import { HttpException, HttpStatus } from "@nestjs/common";

/** `If-Match: "3"` (or 3, or W/"3") -> 3; anything else -> null. */
export function parseIfMatch(v: string | undefined): number | null {
  const m = v === undefined ? null : /^\s*(?:W\/)?"?([1-9][0-9]{0,8})"?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}

/**
 * Optional If-Match (audit R-10): no header, empty or `*` -> null (no check); `"N"` / N / W/"N" with
 * N >= 0 -> N (0 = "nothing stored yet" where a resource advertises it); anything else -> 412 `stale`,
 * so a malformed header never silently skips the check.
 */
export function optionalIfMatch(header: string | undefined): number | null {
  const h = header?.trim();
  if (h === undefined || h === "" || h === "*") return null;
  const m = /^(?:W\/)?(?:"(0|[1-9][0-9]{0,8})"|(0|[1-9][0-9]{0,8}))$/.exec(h);
  if (!m) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
  return Number(m[1] ?? m[2]);
}
