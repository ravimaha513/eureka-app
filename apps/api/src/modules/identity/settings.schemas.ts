import { z } from "zod";
import { NOTIFICATION_PREFERENCE_TYPES, PHONE_PROBLEM_MESSAGES, normalizePhoneE164, phoneProblem } from "@eureka/shared";

/** docs/interviews-settings-api.md ST-2: the only profile fields a staff member edits. */
export const ProfileUpdate = z
  .object({
    phone: z.string().trim().max(40).nullable().transform((v, ctx) => {
      if (v === null || v === "") return null;
      const n = normalizePhoneE164(v);
      if (!n) { ctx.addIssue({ code: "custom", message: PHONE_PROBLEM_MESSAGES[phoneProblem(v) ?? "invalid"] }); return z.NEVER; }
      return n;
    }),
    bio: z.string().max(500).nullable()
      .refine((v) => v === null || !/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), "remove control characters")
      .transform((v) => (v === null || v.trim() === "" ? null : v.trim())),
  })
  .strict();
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

/** `If-Match: "3"` (or 3, or W/"3"); "0" means "no profile saved yet". Anything else -> null. */
export function parseVersion(v: string | undefined): number | null {
  const m = v === undefined ? null : /^\s*(?:W\/)?"?(0|[1-9][0-9]{0,8})"?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}

const TYPES = NOTIFICATION_PREFERENCE_TYPES.map((t) => t.type) as [string, ...string[]];
export const PreferenceType = z.enum(TYPES);
export const PreferenceUpdate = z.object({ inApp: z.boolean() }).strict();
