/**
 * Staging analysis (design B9 steps 2 and 3), pure and deterministic:
 *   normalizeRow()  cells -> typed values + field-level review reasons
 *   resolveBatch()  duplicate rows, cross-sheet matching, reviewer decisions,
 *                   status consistency, final state per row
 * The database layer (stage.ts) supplies reference lists, the commit ledger,
 * decisions and live-duplicate hits; nothing here touches the database.
 */
import { createHash } from "node:crypto";
import { OPEN_PLACEMENT_STATUSES, type CandidateStatus, type PlacementStatus } from "@eureka/shared";
import type { CallStatus, MappingConfig, SalesTarget, Sheet } from "./mapping.js";
import {
  clean, labelKey, lookupLabel, nameKey, normalizeColor, normalizeEmail, normalizeName, normalizePhone,
  normalizePlacementType, normalizeState, normalizeText, normalizeWorkMode, parseDate, parseRate, parseTime,
  splitFullName, validTimeZone, type Mapped, type Norm,
} from "./normalize.js";

export type RowState = "clean" | "review" | "rejected" | "skipped" | "held" | "committed";

export interface RawRow { sheet: Sheet; rowNo: number; cells: Record<string, string> }

export interface Refs {
  /** lower-case name -> id */
  technologies: Map<string, string>;
  locations: Map<string, string>;
  clients: Map<string, string>;
  vendors: Map<string, string>;
  partners: Map<string, string>;
  /** lower-case email -> user */
  users: Map<string, { id: string; active: boolean }>;
}

export interface Ledger {
  /** `${sheet}:${rowKey}` of every loaded source row -> the entity it created */
  links: Map<string, string>;
  /** identity hash -> candidate created by an earlier import */
  identities: Map<string, { candidateId: string; ownerId: string }>;
}

export interface Decision { action: "approve" | "reject" | "link"; linkRowKey: string | null }

export interface Identity { emails: string[]; phone: string | null; nameKey: string | null; dob: string | null }

export interface SalesNorm {
  firstName: string | null; lastName: string | null; personalEmail: string | null; marketingEmail: string | null;
  phone: string | null; dob: string | null; technologyId: string | null; locationId: string | null;
  ownerId: string | null; status: CandidateStatus | null; visibility: "team" | "all_teams";
  priority: "P1" | "P2" | "P3" | null; marketingStartDate: string | null;
}
export interface InterviewNorm {
  firstName: string | null; lastName: string | null; email: string | null; phone: string | null; dob: string | null;
  ownerId: string | null; clientId: string | null; vendorId: string | null; jobTitle: string | null; round: string;
  /** Local wall-clock start "YYYY-MM-DDTHH:MM" in timeZone; the database converts it. */
  startLocal: string | null; minutes: number; timeZone: string; callStatus: CallStatus | null;
}
export interface PlacementNorm {
  firstName: string | null; lastName: string | null; email: string | null; phone: string | null; dob: string | null;
  ownerId: string | null; clientId: string | null; vendorId: string | null; partnerId: string | null;
  jobTitle: string | null; placementType: "c2c" | "w2" | "1099" | null; rate: number | null;
  workMode: "onsite" | "remote" | "hybrid" | null; projectCity: string | null; projectState: string | null;
  tentativeStart: string | null; status: PlacementStatus | null; statusReason: string | null;
}
export type AnyNorm = SalesNorm | InterviewNorm | PlacementNorm;

export interface NormalizedRow {
  sheet: Sheet;
  rowNo: number;
  rowKey: string;
  raw: Record<string, string>;
  norm: AnyNorm;
  /** Status label as typed (lookup key), for per-status reconciliation. */
  statusKey: string;
  reasons: string[];
  identity: Identity;
}

export interface StagedRow extends Omit<NormalizedRow, "identity"> {
  state: RowState;
  /** rowKey of the sales row this row belongs to, or "ledger:<candidate id>". */
  personKey: string | null;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Stable key of a source row: sheet + cells sorted by header (column order does not matter). */
export function rowKeyOf(sheet: Sheet, cells: Record<string, string>): string {
  const entries = Object.entries(cells).map(([k, v]) => [k.trim().toLowerCase(), clean(v)] as const)
    .filter(([, v]) => v !== "").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(`${sheet}\u0000${JSON.stringify(entries)}`);
}

export function identityHashes(id: Identity): { strong: string[]; name: string | null } {
  const strong = [
    ...id.emails.map((e) => sha256(`email:${e}`)),
    ...(id.phone ? [sha256(`phone:${id.phone}`)] : []),
    ...(id.nameKey && id.dob ? [sha256(`namedob:${id.nameKey}|${id.dob}`)] : []),
  ];
  return { strong, name: id.nameKey ? sha256(`name:${id.nameKey}`) : null };
}

// ---------------------------------------------------------------------------
// Reasons. Field-level reasons are "<code>:<field>". Approving a row drops the
// value of a DROPPABLE field and clears the reason; other field reasons need
// the sheet or the mapping fixed and a re-stage.
// ---------------------------------------------------------------------------
export const DROPPABLE_FIELDS = new Set([
  "phone", "personalEmail", "marketingEmail", "email", "dob", "priority", "marketingStartDate",
  "vendor", "implementationPartner", "rate", "projectCity", "projectState", "statusReason",
]);
/** Row-level reasons a reviewer may approve. */
export const APPROVABLE_REASONS = new Set([
  "probable_duplicate", "possible_duplicate_name", "matches_existing_candidate", "name_only_match",
]);
/** Reasons that put a dependent row on hold rather than in review (not the row's own fault). */
const HOLD_REASONS = new Set(["candidate_not_loadable", "placements_commit_disabled"]);

export function approvable(reason: string): boolean {
  if (APPROVABLE_REASONS.has(reason)) return true;
  const field = reason.split(":")[1];
  return field !== undefined && DROPPABLE_FIELDS.has(field);
}

const NORM_FIELD: Record<string, string> = {
  vendor: "vendorId", implementationPartner: "partnerId",
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
type Cols = Record<string, string | undefined>;

class RowNormalizer {
  reasons: string[] = [];
  constructor(private readonly cells: Record<string, string>, private readonly cols: Cols) {}

  cell(field: string): string {
    const h = this.cols[field];
    if (!h) return "";
    const hit = Object.keys(this.cells).find((k) => k.trim().toLowerCase() === h.toLowerCase());
    return hit === undefined ? "" : this.cells[hit] ?? "";
  }

  take<T>(field: string, r: Norm<T>): T | null {
    if (r.ok) return r.value;
    this.reasons.push(`${r.reason}:${field}`);
    return null;
  }

  required<T>(field: string, v: T | null): T | null {
    if (v === null && !this.reasons.some((x) => x.endsWith(`:${field}`))) this.reasons.push(`missing:${field}`);
    return v;
  }

  ref(field: string, map: Map<string, string>, unknown: string, requiredField: boolean): string | null {
    const v = clean(this.cell(field));
    if (!v) return requiredField ? this.required(field, null) : null;
    const id = map.get(v.toLowerCase());
    if (!id) this.reasons.push(`${unknown}:${field}`);
    return id ?? null;
  }

  names(): { first: string | null; last: string | null } {
    if (this.cols.fullName && clean(this.cell("fullName"))) {
      const r = this.take("name", splitFullName(this.cell("fullName")));
      return { first: r?.first ?? null, last: r?.last ?? null };
    }
    const first = this.take("name", normalizeName(this.cell("firstName")));
    const last = this.take("name", normalizeName(this.cell("lastName")));
    if ((!first || !last) && !this.reasons.some((x) => x.endsWith(":name"))) this.reasons.push("missing:name");
    return { first, last };
  }

  owner(refs: Refs, requiredField: boolean): string | null {
    const v = clean(this.cell("owner")).toLowerCase();
    if (!v) return requiredField ? this.required("owner", null) : null;
    const u = refs.users.get(v);
    if (!u) { this.reasons.push("unknown_owner:owner"); return null; }
    if (!u.active) { this.reasons.push("inactive_owner:owner"); return null; }
    return u.id;
  }

  /** Status from the text column and the optional row colour (SRS Q6: never guessed). */
  status<T>(statusMap: Record<string, T | null>, colorMap: Record<string, T | null>, same: (a: T, b: T) => boolean): T | null {
    const text = lookupLabel(statusMap, this.cell("status") || this.cell("callStatus"));
    const statusField = this.cols.callStatus ? "callStatus" : "status";
    let color: Mapped<T> = { kind: "empty" };
    if (this.cols.rowColor) {
      const c = normalizeColor(this.cell("rowColor"));
      if (!c.ok) { this.reasons.push(`${c.reason}:rowColor`); return null; }
      if (c.value) color = lookupLabel(colorMap, c.value);
    }
    if (text.kind === "unmapped") this.reasons.push(`unmapped_status:${statusField}`);
    if (text.kind === "placeholder") this.reasons.push(`unconfirmed_status:${statusField}`);
    if (color.kind === "unmapped") this.reasons.push("unmapped_row_color:rowColor");
    if (color.kind === "placeholder") this.reasons.push("unconfirmed_row_color:rowColor");
    if (text.kind === "mapped" && color.kind === "mapped" && !same(text.value, color.value)) {
      this.reasons.push("status_color_conflict:rowColor");
      return null;
    }
    if (text.kind === "mapped") return color.kind === "mapped" || color.kind === "empty" ? text.value : null;
    if (text.kind === "empty" && color.kind === "mapped") return color.value;
    if (text.kind === "empty" && color.kind === "empty") this.reasons.push(`missing:${statusField}`);
    return null;
  }
}

function technologyId(n: RowNormalizer, cfg: MappingConfig, refs: Refs): string | null {
  const v = clean(n.cell("technology"));
  if (!v) return n.required("technology", null);
  const alias = cfg.technologies[labelKey(v)];
  const id = refs.technologies.get((alias ?? v).toLowerCase());
  if (!id) n.reasons.push("unknown_technology:technology");
  return id ?? null;
}

function identityOf(first: string | null, last: string | null, emails: (string | null)[], phone: string | null, dob: string | null): Identity {
  return {
    emails: [...new Set(emails.filter((e): e is string => !!e))],
    phone,
    nameKey: first && last ? nameKey(first, last) : null,
    dob,
  };
}

export function normalizeRow(row: RawRow, cfg: MappingConfig, refs: Refs): NormalizedRow {
  const sheetCfg = cfg.sheets[row.sheet];
  const cols = sheetCfg.columns as Cols;
  const order = sheetCfg.dateOrder ?? cfg.defaults.dateOrder;
  const pivot = cfg.defaults.twoDigitYearPivot;
  const n = new RowNormalizer(row.cells, cols);
  const rowKey = rowKeyOf(row.sheet, row.cells);
  const { first, last } = n.names();
  const phone = n.take("phone", normalizePhone(n.cell("phone")));
  const dob = n.take("dob", parseDate(n.cell("dob"), order, pivot));
  let norm: AnyNorm;
  let identity: Identity;
  let statusKey: string;

  if (row.sheet === "sales") {
    const personalEmail = n.take("personalEmail", normalizeEmail(n.cell("personalEmail")));
    const marketingEmail = n.take("marketingEmail", normalizeEmail(n.cell("marketingEmail")));
    const target = n.status<SalesTarget>(cfg.statuses.sales, cfg.rowColors.sales,
      (a, b) => a.status === b.status && (a.visibility ?? "team") === (b.visibility ?? "team"));
    const pr = clean(n.cell("priority")).toUpperCase();
    let priority: SalesNorm["priority"] = null;
    if (pr) {
      if (pr === "P1" || pr === "P2" || pr === "P3") priority = pr;
      else n.reasons.push("invalid_priority:priority");
    }
    norm = {
      firstName: first, lastName: last, personalEmail, marketingEmail, phone, dob,
      technologyId: technologyId(n, cfg, refs),
      locationId: n.ref("location", refs.locations, "unknown_location", true),
      ownerId: n.owner(refs, true),
      status: target?.status ?? null, visibility: target?.visibility ?? "team", priority,
      marketingStartDate: n.take("marketingStartDate", parseDate(n.cell("marketingStartDate"), order, pivot)),
    } satisfies SalesNorm;
    identity = identityOf(first, last, [marketingEmail, personalEmail], phone, dob);
    statusKey = labelKey(n.cell("status")) || "(blank)";
  } else if (row.sheet === "interviews") {
    const email = n.take("email", normalizeEmail(n.cell("email")));
    const date = n.required("date", n.take("date", parseDate(n.cell("date"), order, pivot)));
    const start = n.required("startTime", n.take("startTime", parseTime(n.cell("startTime"))));
    let minutes = cfg.defaults.interviewMinutes;
    const end = n.take("endTime", parseTime(n.cell("endTime")));
    const dur = clean(n.cell("durationMinutes"));
    if (end && start) {
      const [sh, sm] = start.split(":").map(Number) as [number, number];
      const [eh, em] = end.split(":").map(Number) as [number, number];
      const d = eh * 60 + em - (sh * 60 + sm);
      if (d < 5 || d > 720) n.reasons.push("invalid_time:endTime");
      else minutes = d;
    } else if (dur) {
      const d = Number(dur.replace(/\s*(min|mins|minutes)$/i, ""));
      if (!Number.isInteger(d) || d < 5 || d > 720) n.reasons.push("invalid_duration:durationMinutes");
      else minutes = d;
    }
    const tzCell = clean(n.cell("timeZone"));
    let timeZone = cfg.defaults.timeZone;
    if (tzCell) {
      const tz = cfg.timeZones[tzCell.toUpperCase()] ?? (validTimeZone(tzCell) && tzCell.includes("/") ? tzCell : null);
      if (tz) timeZone = tz;
      else n.reasons.push("unknown_time_zone:timeZone");
    }
    const round = n.take("round", normalizeText(n.cell("round"), 40)) ?? "Not recorded";
    norm = {
      firstName: first, lastName: last, email, phone, dob,
      ownerId: n.owner(refs, false),
      clientId: n.ref("client", refs.clients, "unknown_client", true),
      vendorId: n.ref("vendor", refs.vendors, "unknown_vendor", false),
      jobTitle: n.required("jobTitle", n.take("jobTitle", normalizeText(n.cell("jobTitle"), 200))),
      round,
      startLocal: date && start ? `${date}T${start}` : null,
      minutes, timeZone,
      callStatus: n.status<CallStatus>(cfg.statuses.interviews, cfg.rowColors.interviews, (a, b) => a === b),
    } satisfies InterviewNorm;
    identity = identityOf(first, last, [email], phone, dob);
    statusKey = labelKey(n.cell("callStatus")) || "(blank)";
  } else {
    const email = n.take("email", normalizeEmail(n.cell("email")));
    norm = {
      firstName: first, lastName: last, email, phone, dob,
      ownerId: n.owner(refs, false),
      clientId: n.ref("client", refs.clients, "unknown_client", true),
      vendorId: n.ref("vendor", refs.vendors, "unknown_vendor", false),
      partnerId: n.ref("implementationPartner", refs.partners, "unknown_partner", false),
      jobTitle: n.required("jobTitle", n.take("jobTitle", normalizeText(n.cell("jobTitle"), 200))),
      placementType: n.required("placementType", n.take("placementType", normalizePlacementType(n.cell("placementType")))),
      rate: n.take("rate", parseRate(n.cell("rate"))),
      workMode: n.required("workMode", n.take("workMode", normalizeWorkMode(n.cell("workMode")))),
      projectCity: n.take("projectCity", normalizeText(n.cell("projectCity"), 80)),
      projectState: n.take("projectState", normalizeState(n.cell("projectState"))),
      tentativeStart: n.required("tentativeStart", n.take("tentativeStart", parseDate(n.cell("tentativeStart"), order, pivot))),
      status: n.status<PlacementStatus>(cfg.statuses.placements, cfg.rowColors.placements, (a, b) => a === b),
      statusReason: n.take("statusReason", normalizeText(n.cell("statusReason"), 500)),
    } satisfies PlacementNorm;
    identity = identityOf(first, last, [email], phone, dob);
    statusKey = labelKey(n.cell("status")) || "(blank)";
  }
  return { sheet: row.sheet, rowNo: row.rowNo, rowKey, raw: row.cells, norm, statusKey, reasons: [...new Set(n.reasons)], identity };
}

// ---------------------------------------------------------------------------
// Resolution: duplicates, matching, decisions, consistency, final state
// ---------------------------------------------------------------------------
export interface ResolveInput {
  rows: NormalizedRow[];
  ledger: Ledger;
  decisions: Map<string, Decision>;
  /** rowKeys of sales rows whose email or phone is used by a live (non-imported) candidate */
  liveMatches: Set<string>;
  placementsCommit: boolean;
}

const dkey = (sheet: Sheet, rowKey: string) => `${sheet}:${rowKey}`;

export function resolveBatch(input: ResolveInput): StagedRow[] {
  const { rows, ledger, decisions, liveMatches } = input;
  const out = rows.map((r): StagedRow & { identity: Identity; final?: boolean } => ({
    sheet: r.sheet, rowNo: r.rowNo, rowKey: r.rowKey, raw: r.raw, norm: { ...r.norm } as AnyNorm,
    statusKey: r.statusKey, reasons: [...r.reasons], identity: r.identity, state: "clean", personKey: null,
  }));
  const setFinal = (r: (typeof out)[number], state: RowState, reasons: string[]) => {
    r.state = state; r.reasons = reasons; r.final = true;
  };

  // 1-3: exact duplicate rows, already-loaded rows, reviewer rejections.
  const seen = new Set<string>();
  for (const r of out) {
    const k = dkey(r.sheet, r.rowKey);
    if (seen.has(k)) { setFinal(r, "rejected", ["duplicate_row"]); continue; }
    seen.add(k);
    const loaded = ledger.links.get(k);
    if (loaded) {
      if (r.sheet === "sales") r.personKey = `ledger:${loaded}`;
      setFinal(r, "skipped", ["already_imported"]);
      continue;
    }
    if (decisions.get(k)?.action === "reject") setFinal(r, "rejected", ["rejected_by_reviewer"]);
  }

  // 4: sales rows form the people. Earlier rows claim identity keys.
  const strongIndex = new Map<string, string>(); // identity hash -> personKey
  const nameIndex = new Map<string, Set<string>>(); // name hash -> personKeys
  const salesByKey = new Map<string, (typeof out)[number]>();
  const ownerOf = new Map<string, string | null>(); // personKey -> owner
  for (const [hash, l] of ledger.identities) {
    strongIndex.set(hash, `ledger:${l.candidateId}`);
    ownerOf.set(`ledger:${l.candidateId}`, l.ownerId);
  }
  const addName = (name: string | null, personKey: string) => {
    if (name) nameIndex.set(name, new Set([...(nameIndex.get(name) ?? []), personKey]));
  };
  for (const r of out) {
    if (r.sheet !== "sales") continue;
    const { strong, name } = identityHashes(r.identity);
    if (r.final) {
      // An already-loaded row still names its person, for links and name suggestions.
      if (r.personKey?.startsWith("ledger:")) { salesByKey.set(r.rowKey, r); addName(name, r.personKey); }
      continue;
    }
    salesByKey.set(r.rowKey, r);
    const dec = decisions.get(dkey("sales", r.rowKey));
    const ledgerHit = strong.map((h) => strongIndex.get(h)).find((p) => p?.startsWith("ledger:"));
    if (ledgerHit) { r.personKey = ledgerHit; setFinal(r, "skipped", ["person_already_imported"]); addName(name, ledgerHit); continue; }
    if (dec?.action === "link") { r.personKey = dec.linkRowKey; setFinal(r, "rejected", ["merged_into_row"]); continue; }
    const strongHit = strong.map((h) => strongIndex.get(h)).find((p) => p !== undefined);
    const nameHit = !strongHit && name ? [...(nameIndex.get(name) ?? [])][0] : undefined;
    if (strongHit) { r.reasons.push("probable_duplicate"); r.personKey = strongHit; }
    else if (nameHit) { r.reasons.push("possible_duplicate_name"); r.personKey = nameHit; }
    if (liveMatches.has(r.rowKey)) r.reasons.push("matches_existing_candidate");
    const approved = dec?.action === "approve";
    if (approved) applyApproval(r);
    const isDuplicate = r.reasons.includes("probable_duplicate") || r.reasons.includes("possible_duplicate_name");
    if (!isDuplicate) {
      r.personKey = r.rowKey;
      ownerOf.set(r.rowKey, (r.norm as SalesNorm).ownerId);
      for (const h of strong) if (!strongIndex.has(h)) strongIndex.set(h, r.rowKey);
      addName(name, r.rowKey);
    }
  }

  // 5: interview and placement rows find their person.
  for (const r of out) {
    if (r.sheet === "sales" || r.final) continue;
    const dec = decisions.get(dkey(r.sheet, r.rowKey));
    if (dec?.action === "link") {
      const target = dec.linkRowKey ? salesByKey.get(dec.linkRowKey) : undefined;
      if (target?.personKey) r.personKey = target.personKey;
      else r.reasons.push("invalid_link");
    } else {
      const m = matchPerson(r.identity, strongIndex, nameIndex);
      r.personKey = m.personKey;
      if (m.reason) r.reasons.push(m.reason);
    }
    if (dec?.action === "approve") applyApproval(r);
  }

  // 6: placements per person: one live (open or joined) placement each, importable statuses only.
  const byPerson = new Map<string, (typeof out)[number][]>();
  for (const r of out) {
    if (r.final || !r.personKey || r.sheet === "sales") continue;
    byPerson.set(r.personKey, [...(byPerson.get(r.personKey) ?? []), r]);
  }
  const ownBlocking = (r: (typeof out)[number]) => r.reasons.filter((x) => !HOLD_REASONS.has(x));
  for (const deps of byPerson.values()) {
    let live = 0;
    for (const p of deps.filter((d) => d.sheet === "placements")) {
      const st = (p.norm as PlacementNorm).status;
      if (st === "bgc_failed") p.reasons.push("placement_status_not_importable");
      if (st && (st === "joined" || OPEN_PLACEMENT_STATUSES.has(st)) && ownBlocking(p).length === 0) {
        live++;
        if (live > 1) p.reasons.push("multiple_open_placements");
      }
    }
  }

  // 7: the sales status must be reachable through the app's own transitions.
  for (const r of salesByKey.values()) {
    if (r.final || r.personKey !== r.rowKey) continue;
    const s = (r.norm as SalesNorm).status;
    if (!s) continue;
    const placements = (byPerson.get(r.rowKey) ?? []).filter((d) => d.sheet === "placements" && ownBlocking(d).length === 0);
    const statuses = placements.map((p) => (p.norm as PlacementNorm).status);
    const joined = statuses.filter((x) => x === "joined").length;
    const open = statuses.filter((x) => x !== null && OPEN_PLACEMENT_STATUSES.has(x)).length;
    if (s === "bench") r.reasons.push("status_not_importable");
    else if (s === "placed" || s === "confirmation") {
      const okPlaced = s === "placed" && joined === 1 && open === 0;
      const okConfirmation = s === "confirmation" && open === 1 && joined === 0;
      if (!input.placementsCommit || !(okPlaced || okConfirmation)) r.reasons.push("status_requires_placement");
    } else if (joined + open > 0 || (s === "in_training" && placements.length > 0)) {
      r.reasons.push("status_conflicts_with_placement");
    }
  }

  // 8: final states.
  for (const r of out) {
    if (r.final) continue;
    r.reasons = [...new Set(r.reasons)];
    if (r.reasons.length > 0) { r.state = "review"; continue; }
    if (r.sheet === "sales") { r.state = "clean"; continue; }
    const pk = r.personKey!;
    const parent = salesByKey.get(pk);
    const parentOk = pk.startsWith("ledger:") || (parent !== undefined && !parent.final && parent.reasons.length === 0);
    if (!parentOk) { r.state = "held"; r.reasons = ["candidate_not_loadable"]; continue; }
    if (r.sheet === "placements" && !input.placementsCommit) { r.state = "held"; r.reasons = ["placements_commit_disabled"]; continue; }
    if ((r.norm as InterviewNorm | PlacementNorm).ownerId === null) {
      (r.norm as InterviewNorm | PlacementNorm).ownerId = ownerOf.get(pk) ?? null;
    }
    r.state = "clean";
  }
  return out.map(({ identity: _i, final: _f, ...rest }) => rest);
}

/** Approval: clear approvable reasons, dropping the rejected field values. */
function applyApproval(r: { reasons: string[]; norm: AnyNorm }) {
  const keep: string[] = [];
  for (const reason of r.reasons) {
    if (!approvable(reason)) { keep.push(reason); continue; }
    const field = reason.split(":")[1];
    if (field) (r.norm as unknown as Record<string, unknown>)[NORM_FIELD[field] ?? field] = null;
  }
  r.reasons = keep;
}

/**
 * Cross-sheet match (design B9 step 3): marketing/personal email, then phone,
 * then name + DOB. A name alone is only a suggestion for review. Conflicting
 * or multiple hits go to review.
 */
export function matchPerson(id: Identity, strongIndex: Map<string, string>, nameIndex: Map<string, Set<string>>):
  { personKey: string | null; reason: string | null } {
  const hit = (hashes: string[]) => new Set(hashes.map((h) => strongIndex.get(h)).filter((p): p is string => !!p));
  const byEmail = hit(id.emails.map((e) => sha256(`email:${e}`)));
  const byPhone = hit(id.phone ? [sha256(`phone:${id.phone}`)] : []);
  const byNameDob = hit(id.nameKey && id.dob ? [sha256(`namedob:${id.nameKey}|${id.dob}`)] : []);
  for (const tier of [byEmail, byPhone, byNameDob]) {
    if (tier.size > 1) return { personKey: null, reason: "ambiguous_match" };
    if (tier.size === 1) {
      const p = [...tier][0]!;
      const conflict = [byEmail, byPhone].some((t) => t.size > 0 && !t.has(p));
      return conflict ? { personKey: null, reason: "conflicting_match" } : { personKey: p, reason: null };
    }
  }
  const byName = id.nameKey ? nameIndex.get(sha256(`name:${id.nameKey}`)) : undefined;
  if (byName && byName.size === 1) return { personKey: [...byName][0]!, reason: "name_only_match" };
  if (byName && byName.size > 1) return { personKey: null, reason: "ambiguous_match" };
  return { personKey: null, reason: "no_candidate_match" };
}
