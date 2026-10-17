/** Display labels for the Eureka App 4 candidate fields (vocabularies in @eureka/shared). */
import { DOCUMENTS_STATUSES, ELIGIBILITY_OPTIONS, VISA_CATEGORIES } from "@eureka/shared";
import type { Candidate } from "../api";

const pick = <T extends Record<string, string>>(m: T, k: string | null | undefined) =>
  k ? (Object.prototype.hasOwnProperty.call(m, k) ? m[k as keyof T] : k) : null;

export const visaLabel = (k: string | null | undefined) => pick(VISA_CATEGORIES, k) ?? "Not recorded";
export const documentsLabel = (k: string | null | undefined) => pick(DOCUMENTS_STATUSES, k) ?? "Not recorded";
export const eligibilityLabel = (ks: readonly string[] | undefined) =>
  ks && ks.length ? ks.map((k) => pick(ELIGIBILITY_OPTIONS, k)).join(", ") : "Not recorded";

/** "Remote", "Guest house (Dallas)" or "Not recorded". */
export function stayLabel(c: Pick<Candidate, "stay" | "ghLocation">): string {
  if (c.stay === "remote") return "Remote";
  if (c.stay === "guest_house") return c.ghLocation ? `Guest house (${c.ghLocation.name})` : "Guest house";
  return "Not recorded";
}
