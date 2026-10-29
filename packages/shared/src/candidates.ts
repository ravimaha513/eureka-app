/**
 * Candidate profile vocabularies and Hot List filters (Eureka App 4 spec,
 * gap/candidates; migration 0140). Every list here is mirrored by a CHECK
 * constraint in the database; adding a value is a migration plus an entry here.
 */

/** Where and how a candidate can work ("in person eligibility etc."); several may apply. */
export const ELIGIBILITY_OPTIONS = {
  in_person: "In person",
  hybrid: "Hybrid",
  remote: "Remote",
  relocation: "Open to relocation",
  travel: "Open to travel",
} as const;
export type Eligibility = keyof typeof ELIGIBILITY_OPTIONS;
export const ELIGIBILITY_LIST = Object.keys(ELIGIBILITY_OPTIONS) as Eligibility[];

/**
 * The visa the candidate is marketed on (a Hot List column, entered by Sales).
 * Not the work-authorization record (numbers, dates and copies stay restricted
 * under visa:read; docs/work-authorization-api.md).
 */
export const VISA_CATEGORIES = {
  us_citizen: "US citizen",
  green_card: "Green card",
  gc_ead: "GC EAD",
  h1b: "H-1B",
  h4_ead: "H-4 EAD",
  l2_ead: "L-2 EAD",
  f1_opt: "F-1 OPT",
  f1_stem_opt: "F-1 STEM OPT",
  f1_cpt: "F-1 CPT",
  tn: "TN",
  o1: "O-1",
  other: "Other",
} as const;
export type VisaCategory = keyof typeof VISA_CATEGORIES;
export const VISA_CATEGORY_LIST = Object.keys(VISA_CATEGORIES) as VisaCategory[];

/** Documents status summary, kept by the compliance teams (candidate.compliance:update). */
export const DOCUMENTS_STATUSES = {
  pending: "Pending",
  partial: "Partially received",
  complete: "Complete",
} as const;
export type DocumentsStatus = keyof typeof DOCUMENTS_STATUSES;
export const DOCUMENTS_STATUS_LIST = Object.keys(DOCUMENTS_STATUSES) as DocumentsStatus[];

/** Hot List "documents" filter: a status, or "none" for candidates with no status recorded. */
export const DOCUMENTS_FILTERS = ["pending", "partial", "complete", "none"] as const satisfies readonly (DocumentsStatus | "none")[];
/**
 * Hot List / Candidates list order: "default" (stable id order), priority
 * (P1 first), days in market (longest first; no start date last), name.
 */
export const LIST_SORTS = ["default", "priority", "days", "name"] as const;
export type ListSort = (typeof LIST_SORTS)[number];
export const LIST_SORT_LABELS: Record<ListSort, string> = {
  default: "Default order", priority: "Priority (P1 first)", days: "Longest in market", name: "Name",
};

/** Hot List "stay" filter: in a guest house (gh_location_id set) or remote. */
export const STAY_FILTERS = ["guest_house", "remote"] as const;
export type StayFilter = (typeof STAY_FILTERS)[number];

/** Company links on a candidate (each an own company, eureka.company). */
export const CANDIDATE_COMPANY_LINKS = {
  everify: "E-Verify company",
  offerLetter: "Offer letter company",
  form1099: "1099 company",
} as const;
export type CandidateCompanyLink = keyof typeof CANDIDATE_COMPANY_LINKS;

/** Marketing locations: at most this many "City, ST" entries per candidate. */
export const MARKETING_LOCATIONS_MAX = 5;

const STATUS_WORDS: Record<string, string> = {
  in_training: "In training",
  active: "Active",
  on_hold: "On hold",
  stopped: "Stopped",
  full_of_interviews: "Full of interviews",
  confirmation: "Confirmation",
  placed: "Placed",
  bench: "Bench",
  terminated: "Terminated",
};

/**
 * Display label for the marketing status (spec values "Active/Remote",
 * "Active/All Teams", "N/A"). Derived, never stored: the status machine keeps
 * its states, "All Teams" mirrors `visibility` and "Remote" mirrors the remote
 * stay flag, so the label cannot disagree with the fields that drive access.
 * "N/A" is a candidate not in the market yet (in training).
 */
export function marketingStatusLabel(status: string, visibility: "team" | "all_teams" | "selected_teams", remote: boolean): string {
  if (status === "in_training") return "N/A";
  const base = STATUS_WORDS[status] ?? status;
  if (status !== "active") return base;
  const parts = [base];
  if (remote) parts.push("Remote");
  if (visibility === "all_teams") parts.push("All Teams");
  if (visibility === "selected_teams") parts.push("Shared");
  return parts.join("/");
}
