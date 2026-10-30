import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CANDIDATE_STATUSES, PLACEMENT_STATUSES, VISA_CATEGORY_LIST } from "@eureka/shared";
import { validTimeZone } from "../platform/time-zone.js";
import { labelKey } from "./normalize.js";

/**
 * Import mapping configuration (docs/import.md). design.md does not fix the
 * sheet layouts, so column headers, status texts, row colours, technology
 * aliases and time-zone abbreviations all live in one reviewed JSON file.
 * Status and row-colour entries are PLACEHOLDERS until SRS Q6 is answered:
 * a null value means "known label, meaning not confirmed" and sends the row
 * to review, exactly like an unmapped label. Nothing is guessed.
 */
export const SHEETS = ["sales", "interviews", "placements"] as const;
export type Sheet = (typeof SHEETS)[number];

export const CALL_STATUSES = ["scheduled", "in_progress", "completed", "rescheduled", "cancelled", "no_invite"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

const header = z.string().min(1).max(100);

const nameColumns = {
  firstName: header.optional(),
  lastName: header.optional(),
  /** One "Name" cell instead of first/last: "First Last" or "Last, First". */
  fullName: header.optional(),
};

export const SalesColumns = z.object({
  ...nameColumns,
  personalEmail: header.optional(),
  marketingEmail: header.optional(),
  phone: header.optional(),
  dob: header.optional(),
  technology: header,
  /** Office location; a blank cell falls back to the candidate's team location. */
  location: header.optional(),
  /**
   * The Eureka user who owns the row (recruiter, or lead for unassigned
   * candidates): an email, an `owners` alias, or a user's exact display name.
   */
  owner: header,
  /** The candidate's team ("Lead" column): a `teams` alias, a team name, or its lead's display name. Blank: the owner's team. */
  team: header.optional(),
  /** Who markets the candidate ("Marketing Teams"): a `sharedWithAll` label, the own team, or another team. */
  sharedWith: header.optional(),
  status: header,
  rowColor: header.optional(),
  priority: header.optional(),
  marketingStartDate: header.optional(),
  /** Marketed visa: a `visas` alias or a visa label/key ("Green card", "gc_ead"). */
  visa: header.optional(),
  /** Guest house ("GH"): a `guestHouses` alias, a location name, or "Remote". */
  guestHouse: header.optional(),
  /** In-person candidate: yes/no. */
  inPerson: header.optional(),
}).strict();

export const InterviewColumns = z.object({
  ...nameColumns,
  email: header.optional(),
  phone: header.optional(),
  dob: header.optional(),
  owner: header.optional(),
  client: header,
  vendor: header.optional(),
  jobTitle: header,
  round: header.optional(),
  date: header,
  startTime: header,
  endTime: header.optional(),
  durationMinutes: header.optional(),
  timeZone: header.optional(),
  callStatus: header,
  rowColor: header.optional(),
}).strict();

export const PlacementColumns = z.object({
  ...nameColumns,
  email: header.optional(),
  phone: header.optional(),
  dob: header.optional(),
  owner: header.optional(),
  client: header,
  vendor: header.optional(),
  implementationPartner: header.optional(),
  jobTitle: header,
  placementType: header,
  rate: header.optional(),
  workMode: header,
  projectCity: header.optional(),
  projectState: header.optional(),
  tentativeStart: header,
  status: header,
  statusReason: header.optional(),
  rowColor: header.optional(),
}).strict();

const dateOrder = z.enum(["detect", "MDY", "DMY"]);
/** Day/month order per date column (field name -> order); unset columns use defaults.dateOrder. */
const dateOrders = z.record(z.string(), dateOrder).default({});

const SalesTarget = z.object({
  status: z.enum(CANDIDATE_STATUSES),
  visibility: z.enum(["team", "all_teams"]).optional(),
}).strict();

/** Label -> value map; keys starting with "_" are comments ("_note"); labels are matched by labelKey. */
const keyed = <T extends z.ZodTypeAny>(v: T) => z.preprocess(
  (m) => (m && typeof m === "object" && !Array.isArray(m)
    ? Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("_")))
    : m),
  z.record(z.string(), v.nullable()).transform((m) => {
    const out: Record<string, z.infer<T> | null> = {};
    for (const [k, val] of Object.entries(m)) out[labelKey(k)] = val;
    return out;
  }));

export const MappingConfig = z.object({
  version: z.literal(1),
  defaults: z.object({
    dateOrder: dateOrder.default("detect"),
    twoDigitYearPivot: z.number().int().min(0).max(99).default(30),
    timeZone: z.string().refine(validTimeZone, "unknown IANA time zone").default("America/Chicago"),
    interviewMinutes: z.number().int().min(5).max(720).default(60),
    /** "US": 10-digit numbers with an assigned +1 area code are US/Canada; null: every phone needs its country code. */
    phoneRegion: z.enum(["US"]).nullable().default("US"),
  }).strict(),
  sheets: z.object({
    sales: z.object({ columns: SalesColumns, dateOrders }).strict(),
    interviews: z.object({ columns: InterviewColumns, dateOrders }).strict(),
    placements: z.object({ columns: PlacementColumns, dateOrders }).strict(),
  }).strict(),
  statuses: z.object({
    sales: keyed(SalesTarget),
    interviews: keyed(z.enum(CALL_STATUSES)),
    placements: keyed(z.enum(PLACEMENT_STATUSES)),
  }).strict(),
  rowColors: z.object({
    sales: keyed(SalesTarget).default({}),
    interviews: keyed(z.enum(CALL_STATUSES)).default({}),
    placements: keyed(z.enum(PLACEMENT_STATUSES)).default({}),
  }).strict(),
  /** Alias -> canonical technology name (tried first; the cell itself is the fallback). */
  technologies: keyed(z.string().min(1)).default({}),
  /** Owner cell label (a name as typed in the sheet) -> Eureka user email. */
  owners: keyed(z.string().email()).default({}),
  /** Team or sharedWith label as typed (e.g. "Rasheed") -> a team name or its lead's display name. */
  teams: keyed(z.string().min(1)).default({}),
  /** sharedWith labels meaning "open to all teams" (e.g. "All"). */
  sharedWithAll: z.array(z.string().min(1)).transform((a) => a.map(labelKey)).default([]),
  /** Visa label -> visa category key. Added to the built-in labels and keys. */
  visas: keyed(z.enum(VISA_CATEGORY_LIST as [string, ...string[]])).default({}),
  /** Guest house label -> location name, or "remote". */
  guestHouses: keyed(z.string().min(1)).default({}),
  /** Abbreviation -> IANA zone, e.g. "CST" -> "America/Chicago". */
  timeZones: z.record(z.string(), z.string().refine(validTimeZone, "unknown IANA time zone"))
    .transform((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k.trim().toUpperCase(), v])))
    .default({}),
  placements: z.object({
    /**
     * Loading placements runs authz.create_placement, which also queues
     * placement.created outbox events for HR, Accounts and Immigration.
     * Off by default until it is decided whether historical placements may
     * notify (docs/import.md, open question).
     */
    commit: z.boolean().default(false),
    /** Reason recorded when a sheet row says backout without one (the database requires a reason). */
    defaultBackoutReason: z.string().min(1).max(200).default("Backout recorded in the placement sheet (import)"),
  }).strict().default({}),
}).strict();
export type MappingConfig = z.infer<typeof MappingConfig>;
export type SalesTarget = z.infer<typeof SalesTarget>;

export const DEFAULT_MAPPING_PATH = join(dirname(fileURLToPath(import.meta.url)), "mapping.default.json");

export function parseMapping(json: unknown): MappingConfig {
  const r = MappingConfig.safeParse(json);
  if (!r.success) {
    throw new Error(`Invalid mapping config: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const cfg = r.data;
  for (const sheet of SHEETS) {
    const c = cfg.sheets[sheet].columns as Record<string, string | undefined>;
    for (const f of Object.keys(cfg.sheets[sheet].dateOrders)) {
      if (!c[f]) throw new Error(`Invalid mapping config: sheets.${sheet}.dateOrders.${f} names no mapped column`);
    }
    if (!c.fullName && !(c.firstName && c.lastName)) {
      throw new Error(`Invalid mapping config: sheets.${sheet}.columns needs fullName or firstName and lastName`);
    }
  }
  return cfg;
}

export function loadMapping(path: string = DEFAULT_MAPPING_PATH): { config: MappingConfig; text: string } {
  const text = readFileSync(path, "utf8");
  return { config: parseMapping(JSON.parse(text)), text };
}
