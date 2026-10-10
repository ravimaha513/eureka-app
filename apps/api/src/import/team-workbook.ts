/**
 * Team workbooks (docs/import.md "Team workbooks"): one Google Sheets workbook
 * per manager with a Submissions, Interviews and Placements tab per team lead
 * ("Rohit Submissions", ...), usually IMPORTRANGE copies of each team's own
 * sheet. Recruiters are named, not emailed; candidates have no email; clients
 * and vendors are free text.
 *
 * This adapter turns such a workbook into the importer's four sheets, so
 * normalization, review, the approval digest and the database loader stay the
 * same. It never guesses silently. What it derives is written into the
 * generated rows, visible in staging and the review queue:
 *   - a people sheet (one row per candidate name across all tabs): the
 *     recruiter with the most submissions owns the candidate; a candidate
 *     submitted by more than one team is "Active/All Teams" so every team can
 *     act on them; phone from the placement tab
 *   - "Candidate Ref" (the name's letters) ties a person's rows together, as
 *     an email would; the sheets have nothing better
 *   - job title = the technology (the tabs record no job title)
 *   - "Implementer / End client" clients are split: the end client is the
 *     client, the implementer the implementation partner
 *   - interviews have no client: when the candidate was submitted to exactly
 *     one client in the 30 days before, that client is filled in and the row
 *     is marked "Client Inferred" (approval needed); otherwise the row waits
 *     in review (missing:client)
 *   - interview call status: Scheduled when dated after `asOf`, else Completed
 *   - placement status from the BGV status and joining date
 * Every generated row names its source tab and row ("Source Tab", "Source Row").
 */
import { clean, labelKey, parseDate } from "./normalize.js";
import type { Sheet } from "./mapping.js";
import { sheetToCsv, type SheetSource, type WorkbookSheet } from "./xlsx.js";

type Kind = "submissions" | "interviews" | "placements";
const KINDS: Kind[] = ["submissions", "interviews", "placements"];

/** Input headers (labelKey) per field, including the spellings seen in real sheets. */
const ALIASES: Record<string, string[]> = {
  date: ["date", "submission date", "interview date"],
  candidate: ["candidate name", "canddiate name", "candidate", "consultant name", "name"],
  technology: ["technology", "tech", "skill"],
  rate: ["rate", "pay rate", "bill rate"],
  vendor: ["vendor", "vendor name"],
  client: ["client", "client name", "end client"],
  manager: ["manager"],
  lead: ["team lead", "lead", "tl"],
  recruiter: ["recruiter name", "recruiter", "submitted by"],
  support: ["support name", "support"],
  interviewType: ["interview type", "round", "interview round"],
  clientFeedback: ["feedback from client", "client feedback"],
  candidateFeedback: ["feedback from candidate", "candidate feedback"],
  rejection: ["reason for rejection", "rejection reason"],
  bgv: ["bgv status", "bgc status", "background check"],
  placementDate: ["placement date"],
  joiningDate: ["joining date", "start date", "doj"],
  phone: ["phone number", "phone", "mobile"],
  marketingCompany: ["marketing company"],
  everifyCompany: ["everify company", "e-verify company", "e verify company"],
};

/** Columns that tell the kinds apart when neither the IMPORTRANGE source nor the tab name does. */
const SIGNATURE: Record<Kind, string[]> = {
  placements: ["bgv", "joiningDate", "placementDate"],
  interviews: ["interviewType", "clientFeedback", "support"],
  submissions: ["vendor", "client", "rate"],
};

const OUT_HEADERS: Record<Sheet, string[]> = {
  sales: ["Candidate Name", "Candidate Ref", "Phone", "Technology", "Recruiter", "Status", "Teams", "Source Tab", "Source Row"],
  submissions: ["Date", "Candidate Name", "Candidate Ref", "Technology", "Job Title", "Rate", "Vendor", "Client",
    "Client As Typed", "Recruiter", "Team Lead", "Manager", "Source Tab", "Source Row"],
  interviews: ["Date", "Candidate Name", "Candidate Ref", "Technology", "Job Title", "Interview Type", "Call Status",
    "Client", "Client Inferred", "Vendor", "Support Name", "Feedback From Client", "Feedback From Candidate",
    "Reason For Rejection", "Recruiter", "Team Lead", "Manager", "Source Tab", "Source Row"],
  placements: ["Date", "Candidate Name", "Candidate Ref", "Phone", "Technology", "Job Title", "Rate", "Vendor", "Client",
    "Implementation Partner", "Client As Typed", "Placement Type", "Work Mode", "Tentative Start", "Status", "BGV Status",
    "Placement Date", "Joining Date", "Marketing Company", "Everify Company", "Recruiter", "Team Lead", "Manager",
    "Source Tab", "Source Row"],
};

export interface TeamTab { name: string; kind: Kind; team: string; rows: number; source?: SheetSource; by: "source" | "name" | "headers" }
export interface TeamWorkbook {
  tabs: TeamTab[];
  /** Tabs that are not a submissions, interviews or placements log. */
  ignored: string[];
  sheets: Record<Sheet, { headers: string[]; rows: string[][] }>;
  stats: { candidates: number; multiTeamCandidates: number; interviewsWithInferredClient: number; interviewsWithoutClient: number };
}

/** A person's key within the workbook: the letters of the name, lower case, in order. */
export function personRef(name: string): string {
  const letters = clean(name).toLowerCase().replace(/[^\p{L}]+/gu, "");
  return letters ? `wb:${letters}` : "";
}

/**
 * "Contoso / Tailspin Energy" -> implementer Contoso, client Tailspin Energy. Only a
 * single "/" with letters on both sides splits ("Proseware - 3/12" does not).
 */
export function splitClient(cell: string): { client: string; partner: string } {
  const v = clean(cell);
  const parts = v.split("/");
  const hasLetters = (s: string) => (s.match(/\p{L}/gu) ?? []).length >= 2;
  if (parts.length === 2 && hasLetters(parts[0]!) && hasLetters(parts[1]!)) {
    return { partner: parts[0]!.trim(), client: parts[1]!.trim() };
  }
  return { client: v, partner: "" };
}

const BGV: Record<string, "cleared" | "in_progress" | "failed"> = {
  cleared: "cleared", clear: "cleared", done: "cleared", complete: "cleared", completed: "cleared", passed: "cleared",
  ongoing: "in_progress", "on going": "in_progress", "in progress": "in_progress", initiated: "in_progress", pending: "in_progress",
  "not cleared": "failed", failed: "failed", fail: "failed",
};

/** App placement status (as the mapping's labels) from the BGV status and joining date. */
export function placementStatus(bgv: string, joining: string | null, asOf: string): string {
  const b = BGV[labelKey(bgv)];
  if (b === "failed") return "BGC Failed";
  if (b === "cleared") return joining && joining <= asOf ? "Joined" : "Ready";
  if (b === "in_progress") return "BGC";
  return "Confirmed";
}

const isoOf = (cell: string): string | null => {
  const d = parseDate(cell, "MDY");
  return d.ok ? d.value : null;
};

function kindFromText(s: string): Kind | undefined {
  const k = labelKey(s);
  if (/\bsubmissions?$/.test(k)) return "submissions";
  if (/\binterviews?$/.test(k)) return "interviews";
  if (/\bplacements?$/.test(k)) return "placements";
  return undefined;
}

function fieldIndex(headers: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const keys = headers.map(labelKey);
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const i = keys.findIndex((k) => aliases.includes(k));
    if (i >= 0) out.set(field, i);
  }
  return out;
}

function classify(s: WorkbookSheet, idx: Map<string, number>): { kind: Kind; by: TeamTab["by"] } | undefined {
  const fromSource = s.source ? kindFromText(s.source.tab) : undefined;
  if (fromSource) return { kind: fromSource, by: "source" };
  const fromName = kindFromText(s.name);
  if (fromName) return { kind: fromName, by: "name" };
  if (!idx.has("candidate") || !idx.has("date")) return undefined;
  const k = KINDS.find((kind) => SIGNATURE[kind].every((f) => idx.has(f)));
  return k ? { kind: k, by: "headers" } : undefined;
}

const mostCommon = (xs: string[]): string => {
  const n = new Map<string, number>();
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

interface Row { tab: TeamTab; rowNo: number; get: (f: string) => string }

export function teamWorkbook(sheets: WorkbookSheet[], opts: { asOf: string }): TeamWorkbook {
  const tabs: TeamTab[] = [];
  const ignored: string[] = [];
  const rows: Record<Kind, Row[]> = { submissions: [], interviews: [], placements: [] };
  for (const s of sheets) {
    const idx = fieldIndex(s.headers);
    const c = classify(s, idx);
    if (!c || !idx.has("candidate")) { ignored.push(s.name); continue; }
    const kindWord = new RegExp(`\\s*${c.kind.slice(0, -1)}s?\\s*$`, "i");
    const team = clean(s.name.replace(kindWord, "")) || mostCommon(s.rows.map((r) => clean(r[idx.get("lead") ?? -1] ?? "")));
    const tab: TeamTab = { name: s.name, kind: c.kind, team, rows: 0, by: c.by, ...(s.source ? { source: s.source } : {}) };
    s.rows.forEach((r, i) => {
      const get = (f: string) => clean(r[idx.get(f) ?? -1] ?? "");
      if (!get("candidate")) return;
      tab.rows++;
      rows[c.kind].push({ tab, rowNo: s.headerRow + i + 1, get });
    });
    tabs.push(tab);
  }

  // People: every candidate name across the tabs.
  interface Person { ref: string; names: string[]; techs: string[]; teams: Set<string>; subsBy: string[]; otherBy: string[]; phone: string; first: Row }
  const people = new Map<string, Person>();
  for (const kind of KINDS) {
    for (const r of rows[kind]) {
      const ref = personRef(r.get("candidate"));
      if (!ref) continue;
      const p = people.get(ref) ?? { ref, names: [], techs: [], teams: new Set(), subsBy: [], otherBy: [], phone: "", first: r };
      p.names.push(r.get("candidate"));
      p.teams.add(r.tab.team);
      if (r.get("technology")) p.techs.push(r.get("technology"));
      (kind === "submissions" ? p.subsBy : p.otherBy).push(r.get("recruiter"));
      if (!p.phone && r.get("phone")) p.phone = r.get("phone");
      people.set(ref, p);
    }
  }

  const src = (r: Row) => [r.tab.name, String(r.rowNo)];
  const out: TeamWorkbook["sheets"] = {
    sales: { headers: OUT_HEADERS.sales, rows: [] }, submissions: { headers: OUT_HEADERS.submissions, rows: [] },
    interviews: { headers: OUT_HEADERS.interviews, rows: [] }, placements: { headers: OUT_HEADERS.placements, rows: [] },
  };
  for (const p of people.values()) {
    // The recruiter with the most submissions (the latest wins a tie), else from interviews/placements.
    const by = p.subsBy.length ? p.subsBy : p.otherBy;
    const counts = new Map<string, number>();
    by.forEach((x) => { if (x) counts.set(x, (counts.get(x) ?? 0) + 1); });
    let owner = "";
    let best = 0;
    by.forEach((x) => { if (x && counts.get(x)! >= best) { best = counts.get(x)!; owner = x; } });
    out.sales.rows.push([mostCommon(p.names), p.ref, p.phone, mostCommon(p.techs), owner,
      p.teams.size > 1 ? "Active/All Teams" : "Active", [...p.teams].sort().join(", "), ...src(p.first)]);
  }

  // Submissions, and per person the clients they were submitted to (for interviews).
  const submittedTo = new Map<string, { date: string; client: string; vendor: string; job: string }[]>();
  for (const r of rows.submissions) {
    const { client } = splitClient(r.get("client"));
    const tech = r.get("technology");
    out.submissions.rows.push([r.get("date"), r.get("candidate"), personRef(r.get("candidate")), tech, tech, r.get("rate"),
      r.get("vendor"), client, r.get("client"), r.get("recruiter"), r.get("lead"), r.get("manager"), ...src(r)]);
    const d = isoOf(r.get("date"));
    const ref = personRef(r.get("candidate"));
    if (d && client) submittedTo.set(ref, [...(submittedTo.get(ref) ?? []), { date: d, client, vendor: r.get("vendor"), job: tech }]);
  }

  let inferred = 0;
  let noClient = 0;
  for (const r of rows.interviews) {
    const d = isoOf(r.get("date"));
    const ref = personRef(r.get("candidate"));
    let client = splitClient(r.get("client")).client;
    let vendor = r.get("vendor");
    let job = r.get("technology");
    let marker = "";
    if (!client && d) {
      const from = new Date(Date.parse(`${d}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
      const recent = (submittedTo.get(ref) ?? []).filter((x) => x.date >= from && x.date <= d);
      const clients = [...new Set(recent.map((x) => labelKey(x.client)))];
      if (clients.length === 1) {
        const hits = recent.filter((x) => labelKey(x.client) === clients[0]);
        client = hits[hits.length - 1]!.client;
        const vendors = [...new Set(hits.map((x) => labelKey(x.vendor)))];
        vendor = vendors.length === 1 ? hits[hits.length - 1]!.vendor : "";
        job = hits[hits.length - 1]!.job || job;
        marker = `submitted to only this client in the 30 days before (${hits.length} submission${hits.length > 1 ? "s" : ""})`;
        inferred++;
      }
    }
    if (!client) noClient++;
    out.interviews.rows.push([r.get("date"), r.get("candidate"), ref, r.get("technology"), job, r.get("interviewType"),
      d && d > opts.asOf ? "Scheduled" : "Completed", client, marker, vendor, r.get("support"), r.get("clientFeedback"),
      r.get("candidateFeedback"), r.get("rejection"), r.get("recruiter"), r.get("lead"), r.get("manager"), ...src(r)]);
  }

  for (const r of rows.placements) {
    const { client, partner } = splitClient(r.get("client"));
    const joining = isoOf(r.get("joiningDate"));
    const tech = r.get("technology");
    out.placements.rows.push([r.get("date"), r.get("candidate"), personRef(r.get("candidate")), r.get("phone"), tech, tech,
      r.get("rate"), r.get("vendor"), client, partner, r.get("client"), "", "", joining ? r.get("joiningDate") : "",
      placementStatus(r.get("bgv"), joining, opts.asOf), r.get("bgv"), r.get("placementDate"), r.get("joiningDate"),
      r.get("marketingCompany"), r.get("everifyCompany"), r.get("recruiter"), r.get("lead"), r.get("manager"), ...src(r)]);
  }

  return {
    tabs, ignored, sheets: out,
    stats: {
      candidates: people.size, multiTeamCandidates: [...people.values()].filter((p) => p.teams.size > 1).length,
      interviewsWithInferredClient: inferred, interviewsWithoutClient: noClient,
    },
  };
}

/** The generated sheets as staging input (stageTexts), with the tabs each came from in the batch's file list. */
export function workbookTexts(wb: TeamWorkbook, file: string, asOf: string):
  Partial<Record<Sheet, { file: string; text: string; source: unknown }>> {
  const tabs = (kind: Sheet) => wb.tabs.filter((t) => kind === "sales" || t.kind === kind)
    .map((t) => ({ tab: t.name, team: t.team, rows: t.rows, by: t.by, ...(t.source ? { range: t.source.range } : {}) }));
  return Object.fromEntries((["sales", "submissions", "interviews", "placements"] as const)
    .filter((k) => wb.sheets[k].rows.length > 0)
    .map((k) => [k, {
      file: `${file} (${k === "sales" ? "people from all tabs" : `${k} tabs`})`,
      text: sheetToCsv({ name: k, headerRow: 1, ...wb.sheets[k] }),
      source: { adapter: "team-workbook", asOf, tabs: tabs(k) },
    }]));
}
