import { z } from "zod";
import {
  WORK_AUTH_NUMBER_RE, WORK_AUTH_STATUSES, WORK_AUTH_TYPE_LIST, normalizeWorkAuthNumber, type WorkAuthType,
} from "@eureka/shared";

/**
 * Write schemas (design B4.7: strict, unknown keys refused). The number is
 * normalized (spaces removed, upper case) and validated; the error never
 * echoes it. Server-managed fields (id, person, key, ciphertext, audit
 * columns) are not accepted.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= "1950-01-01" && v <= "2200-01-01";
}, "Not a valid date");

const number = z.string().max(80).transform(normalizeWorkAuthNumber)
  .refine((v) => WORK_AUTH_NUMBER_RE.test(v), "Use 1-40 letters, digits or hyphens");

const type = z.enum(WORK_AUTH_TYPE_LIST as [WorkAuthType, ...WorkAuthType[]]);
const status = z.enum(WORK_AUTH_STATUSES);

const datesInOrder = (v: { validFrom?: string | null; validTo?: string | null }) =>
  !v.validFrom || !v.validTo || v.validTo >= v.validFrom;

export const WorkAuthCreate = z
  .object({
    type,
    number: number.nullable().optional(),
    validFrom: isoDate.nullable().optional(),
    validTo: isoDate.nullable().optional(),
    status,
  })
  .strict()
  .refine(datesInOrder, { message: "validTo must not be before validFrom", path: ["validTo"] });
export type WorkAuthCreate = z.infer<typeof WorkAuthCreate>;

/**
 * Partial update; `number: null` removes the number, an omitted number keeps
 * it. The row version the client saw travels in `If-Match` (not the body,
 * where row versions are server-managed).
 */
export const WorkAuthUpdate = z
  .object({
    type: type.optional(),
    number: number.nullable().optional(),
    validFrom: isoDate.nullable().optional(),
    validTo: isoDate.nullable().optional(),
    status: status.optional(),
  })
  .strict();
export type WorkAuthUpdate = z.infer<typeof WorkAuthUpdate>;

/** `If-Match: "3"` (or 3, or W/"3") -> 3; anything else -> null. */
export function parseIfMatch(v: string | undefined): number | null {
  const m = v === undefined ? null : /^\s*(?:W\/)?"?([1-9][0-9]{0,8})"?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}
