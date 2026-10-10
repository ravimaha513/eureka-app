import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CANDIDATE_STATUSES, PLACEMENT_STATUSES } from "@eureka/shared";
import { labelKey, validTimeZone } from "./normalize.js";

/**
 * Import mapping configuration (docs/import.md). design.md does not fix the
 * sheet layouts, so column headers, status texts, row colours, technology
 * aliases and time-zone abbreviations all live in one reviewed JSON file.
 * Status and row-colour entries are PLACEHOLDERS until SRS Q6 is answered:
 * a null value means "known label, meaning not confirmed" and sends the row
 * to review, exactly like an unmapped label. Nothing is guessed.
 */
export const SHEETS = ["sales", "submissions", "interviews", "placements"] as const;
export type Sheet = (typeof SHEETS)[number];

export const CALL_STATUSES = ["scheduled", "in_progress", "completed", "rescheduled", "cancelled", "no_invite"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

const header = z.string().min(1).max(100);

const nameColumns = {
  firstName: header.optional(),
  lastName: header.optional(),
  /** One "Name" cell instead of first/last: "First Last" or "Last, First". */
  fullName: header.optional(),
  /**
   * A stable id of the person within the source (e.g. "Candidate Ref" written
   * by the team-workbook adapter): matched across sheets like an email, for
   * sheets that carry no email or phone.
   */
  personRef: header.optional(),
};

export const SalesColumns = z.object({
  ...nameColumns,
  personalEmail: header.optional(),
  marketingEmail: header.optional(),
  phone: header.optional(),
  dob: header.optional(),
  technology: header,
  /** Optional only with sheets.sales.locationFromOwner. */
  location: header.optional(),
  /** Email (or, through `owners`, name) of the Eureka user who owns the row (recruiter, or lead for unassigned candidates). */
  owner: header,
  status: header,
  rowColor: header.optional(),
  priority: header.optional(),
  marketingStartDate: header.optional(),
}).strict();

/** One row per submission of a candidate to a client (the recruiters' daily log). */
export const SubmissionColumns = z.object({
  ...nameColumns,
  email: header.optional(),
  phone: header.optional(),
  dob: header.optional(),
  owner: header.optional(),
  client: header,
  vendor: header.optional(),
  jobTitle: header,
  rate: header.optional(),
  /** Submission date (stored as the submission's submitted_at). */
  date: header,
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
  /** Non-blank when the client was not in the sheet but inferred (team-workbook adapter): the row needs approval. */
  clientInferred: header.optional(),
  date: header,
  /** Optional only with defaults.interviewTime. */
  startTime: header.optional(),
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
    /** Start time ("HH:MM") for interview rows whose sheet records only the date; null: the time is required. */
    interviewTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).nullable().default(null),
  }).strict(),
  sheets: z.object({
    sales: z.object({
      columns: SalesColumns, dateOrders,
      /** A row without a location gets its owner's primary location (sheets that record no candidate location). */
      locationFromOwner: z.boolean().default(false),
    }).strict(),
    /** Optional: only mappings for sheets that log submissions have it. */
    submissions: z.object({ columns: SubmissionColumns, dateOrders }).strict().optional(),
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
  /**
   * Owner cell as typed (a person's name or a variant of it) -> Eureka user email. Owner cells
   * are resolved as an email, then through this list, then as the display name of exactly one
   * active user (authz.import_owner, 0086, does the same).
   */
  owners: keyed(z.string().email()).default({}),
  /**
   * Clients, vendors and implementation partners not in the reference lists: by default the row
   * goes to review (unknown_client, ...). With create, the name is kept and the loader adds it to
   * the list (the preview shows every new name). Names in `ignore` count as blank ("confidential").
   */
  references: z.object({
    create: z.object({
      clients: z.boolean().default(false), vendors: z.boolean().default(false), partners: z.boolean().default(false),
    }).strict().default({}),
    ignore: z.array(z.string().min(1).max(100)).default([]),
  }).strict().default({}),
  /** Alias -> canonical technology name (must exist in the technology list). */
  technologies: keyed(z.string().min(1)).default({}),
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

/** A sheet's mapping; a sheet the mapping does not describe (submissions is optional) cannot be staged. */
export function sheetConfig(cfg: MappingConfig, sheet: Sheet) {
  const sc = cfg.sheets[sheet];
  if (!sc) throw new Error(`The mapping has no sheets.${sheet} section`);
  return sc as { columns: Record<string, string | undefined>; dateOrders: Record<string, "detect" | "MDY" | "DMY"> };
}

export const DEFAULT_MAPPING_PATH = join(dirname(fileURLToPath(import.meta.url)), "mapping.default.json");

export function parseMapping(json: unknown): MappingConfig {
  const r = MappingConfig.safeParse(json);
  if (!r.success) {
    throw new Error(`Invalid mapping config: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const cfg = r.data;
  for (const sheet of SHEETS) {
    const sc = cfg.sheets[sheet];
    if (!sc) continue;
    const c = sc.columns as Record<string, string | undefined>;
    for (const f of Object.keys(sc.dateOrders)) {
      if (!c[f]) throw new Error(`Invalid mapping config: sheets.${sheet}.dateOrders.${f} names no mapped column`);
    }
    if (!c.fullName && !(c.firstName && c.lastName)) {
      throw new Error(`Invalid mapping config: sheets.${sheet}.columns needs fullName or firstName and lastName`);
    }
  }
  if (!cfg.sheets.sales.columns.location && !cfg.sheets.sales.locationFromOwner) {
    throw new Error("Invalid mapping config: sheets.sales.columns.location is required unless sheets.sales.locationFromOwner is true");
  }
  if (!cfg.sheets.interviews.columns.startTime && cfg.defaults.interviewTime === null) {
    throw new Error("Invalid mapping config: sheets.interviews.columns.startTime is required unless defaults.interviewTime is set");
  }
  return cfg;
}

export function loadMapping(path: string = DEFAULT_MAPPING_PATH): { config: MappingConfig; text: string } {
  const text = readFileSync(path, "utf8");
  return { config: parseMapping(JSON.parse(text)), text };
}
