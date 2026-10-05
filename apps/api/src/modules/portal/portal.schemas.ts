import { z } from "zod";
import { PHONE_PROBLEM_MESSAGES, normalizeEmail, normalizePhoneE164, phoneProblem } from "@eureka/shared";

/** docs/jobs-portal-api.md "Applicant portal". Bodies are strict. */
// eslint-disable-next-line no-control-regex
const noControl = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);
const Name = z.string().trim().min(1).max(80).refine(noControl, "control characters are not allowed");
const Email = z.string().max(254).transform(normalizeEmail).pipe(z.string().email().max(254));
const Phone = z.string().max(40).transform((v, ctx) => {
  const p = normalizePhoneE164(v);
  if (!p) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: PHONE_PROBLEM_MESSAGES[phoneProblem(v) ?? "invalid"] });
    return z.NEVER;
  }
  return p;
});

/** Date of birth is not collected (see the docs: it would need the dob field class end to end, OD-04). */
export const SignUp = z.object({ firstName: Name, lastName: Name, email: Email, phone: Phone }).strict();
export type SignUp = z.infer<typeof SignUp>;

export const RequestLink = z.object({ email: Email }).strict();
export type RequestLink = z.infer<typeof RequestLink>;

/** The token from the link's fragment: "<link id>.<secret>". */
export const VerifyLink = z.object({ token: z.string().min(1).max(200) }).strict();
