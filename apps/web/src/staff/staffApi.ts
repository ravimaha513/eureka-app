/** Typed client for staff birthdays (docs/alerts-calendar-birthdays.md BD-2). */
import type { Birthday } from "@eureka/shared";
import { ApiError, api } from "../api";

export interface StaffMember {
  id: string; name: string; email: string; designation: string | null; location: string | null; roles: string[]; birthday: Birthday | null;
}
const enc = encodeURIComponent;
export const staffApi = {
  birthdays: () => api<{ items: StaffMember[] }>("/api/v1/staff/birthdays"),
  setBirthday: (userId: string, birthday: Birthday | null) =>
    api<{ id: string; birthday: Birthday | null }>(`/api/v1/staff/${enc(userId)}/birthday`, { method: "PUT", body: JSON.stringify({ birthday }) }),
};
export const staffKeys = { birthdays: ["staff", "birthdays"] as const };
export function staffError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.status === 422) return e.errors?.length ? e.errors.map((x) => x.message).join(" ") : "That is not a calendar day.";
  if (e.status === 403) return "You are not allowed to change staff birthdays.";
  if (e.status === 404) return "That staff member is no longer active.";
  return e.detail ?? e.title ?? e.message;
}
