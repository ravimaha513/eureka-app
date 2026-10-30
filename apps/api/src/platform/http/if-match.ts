/** `If-Match: "3"` (or 3, or W/"3") -> 3; anything else -> null. */
export function parseIfMatch(v: string | undefined): number | null {
  const m = v === undefined ? null : /^\s*(?:W\/)?"?([1-9][0-9]{0,8})"?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}
