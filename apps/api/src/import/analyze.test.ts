import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  identityHashes, matchPerson, normalizeRow, resolveBatch, rowKeyOf, sha256,
  type Decision, type Ledger, type RawRow, type Refs, type SalesNorm,
} from "./analyze.js";
import { DEFAULT_MAPPING_PATH, parseMapping, type MappingConfig } from "./mapping.js";

const base = JSON.parse(readFileSync(DEFAULT_MAPPING_PATH, "utf8"));
const cfg = (patch: (m: typeof base) => void = () => undefined): MappingConfig => {
  const m = structuredClone(base);
  patch(m);
  return parseMapping(m);
};
const refs: Refs = {
  technologies: new Map([["java", "tech-java"]]),
  locations: new Map([["dallas", "loc-dallas"]]),
  clients: new Map([["northwind financial", "client-nw"]]),
  vendors: new Map(), partners: new Map(),
  users: new Map([["r1@x.example", { id: "user-r1", active: true }], ["gone@x.example", { id: "user-gone", active: false }]]),
};
const sales = (rowNo: number, o: Record<string, string> = {}): RawRow => ({
  sheet: "sales", rowNo, cells: {
    "First Name": "Asha", "Last Name": "Verma", "Marketing Email": "asha@m.example", Phone: "214-555-0101", DOB: "",
    Technology: "Java", Location: "Dallas", "Recruiter Email": "r1@x.example", Status: "Active", ...o,
  },
});
const interview = (rowNo: number, o: Record<string, string> = {}): RawRow => ({
  sheet: "interviews", rowNo, cells: {
    "Candidate Name": "Asha Verma", "Candidate Email": "asha@m.example", Client: "Northwind Financial", "Job Title": "Dev",
    "Interview Date": "2026-09-01", "Start Time": "10:00 AM", "Call Status": "Scheduled", ...o,
  },
});
const placement = (rowNo: number, o: Record<string, string> = {}): RawRow => ({
  sheet: "placements", rowNo, cells: {
    "Candidate Name": "Asha Verma", "Candidate Email": "asha@m.example", Client: "Northwind Financial", "Job Title": "Dev",
    "Placement Type": "W2", "Work Mode": "Onsite", "Tentative Start": "2026-10-01", Status: "Confirmed", ...o,
  },
});
const emptyLedger = (): Ledger => ({ links: new Map(), identities: new Map() });

function resolve(raws: RawRow[], o: { config?: MappingConfig; ledger?: Ledger; decisions?: Map<string, Decision>; live?: Set<string> } = {}) {
  const c = o.config ?? cfg((m) => { m.placements.commit = true; });
  const rows = raws.map((r) => normalizeRow(r, c, refs));
  const out = resolveBatch({ rows, ledger: o.ledger ?? emptyLedger(), decisions: o.decisions ?? new Map(), liveMatches: o.live ?? new Set(), placementsCommit: c.placements.commit });
  return Object.fromEntries(out.map((r) => [`${r.sheet} ${r.rowNo}`, r]));
}

describe("row keys and normalization", () => {
  it("row key ignores column order and surrounding whitespace, but not content", () => {
    expect(rowKeyOf("sales", { A: "1", B: " x " })).toBe(rowKeyOf("sales", { B: "x", A: "1" }));
    expect(rowKeyOf("sales", { A: "1" })).not.toBe(rowKeyOf("interviews", { A: "1" }));
    expect(rowKeyOf("sales", { A: "1" })).not.toBe(rowKeyOf("sales", { A: "2" }));
  });

  it("normalizes a sales row and maps the status (Active/All Teams -> active + all_teams)", () => {
    const r = normalizeRow(sales(2, { "First Name": "ASHA", Status: "active / all teams", Priority: "p1", "Marketing Start Date": "4-Aug-2026" }), cfg(), refs);
    expect(r.reasons).toEqual([]);
    expect(r.norm).toMatchObject({ firstName: "Asha", phone: "+12145550101", technologyId: "tech-java", locationId: "loc-dallas",
      ownerId: "user-r1", status: "active", visibility: "all_teams", priority: "P1", marketingStartDate: "2026-08-04" });
    expect(r.statusKey).toBe("active/all teams");
  });

  it("collects every problem on a row as field-level reasons", () => {
    const r = normalizeRow(sales(2, { Phone: "12", Technology: "Cobol", Location: "Mars", "Recruiter Email": "gone@x.example", Status: "Hot", Priority: "urgent" }), cfg(), refs);
    expect(r.reasons.sort()).toEqual(["inactive_owner:owner", "invalid_phone:phone", "invalid_priority:priority",
      "unconfirmed_status:status", "unknown_location:location", "unknown_technology:technology"]);
  });

  it("row colour: placeholders and unmapped colours go to review; a confirmed colour must agree with the text", () => {
    const withGreen = cfg((m) => { m.rowColors.sales["#00ff00"] = { status: "on_hold" }; });
    const go = (o: Record<string, string>, c = withGreen) => normalizeRow(sales(2, { "Row Color": "", ...o }), c, refs).reasons;
    expect(go({ "Row Color": "#B7E1CD" })).toEqual(["unconfirmed_row_color:rowColor"]);
    expect(go({ "Row Color": "#123456" })).toEqual(["unmapped_row_color:rowColor"]);
    expect(go({ "Row Color": "#00ff00" })).toEqual(["status_color_conflict:rowColor"]);
    expect(go({ "Row Color": "#00ff00", Status: "On Hold" })).toEqual([]);
    expect(normalizeRow(sales(2, { "Row Color": "#00ff00", Status: "" }), withGreen, refs).norm).toMatchObject({ status: "on_hold" });
    expect(go({ Status: "" })).toEqual(["missing:status"]);
  });

  it("interview time: end time or duration, time-zone abbreviations, defaults", () => {
    const n = (o: Record<string, string>) => normalizeRow(interview(2, o), cfg(), refs);
    expect(n({ "End Time": "11:30 AM", "Time Zone": "est" }).norm).toMatchObject({ startLocal: "2026-09-01T10:00", minutes: 90, timeZone: "America/New_York" });
    expect(n({ "Duration (min)": "45 min", "Time Zone": "Asia/Kolkata" }).norm).toMatchObject({ minutes: 45, timeZone: "Asia/Kolkata" });
    expect(n({}).norm).toMatchObject({ minutes: 60, timeZone: "America/Chicago", round: "Not recorded" });
    expect(n({ "Time Zone": "XYZ" }).reasons).toEqual(["unknown_time_zone:timeZone"]);
    expect(n({ "End Time": "9:00 AM" }).reasons).toEqual(["invalid_time:endTime"]);
    expect(n({ "Start Time": "" }).reasons).toEqual(["missing:startTime"]);
  });
});

describe("matching (email, then phone, then name + DOB; a name alone is only a suggestion)", () => {
  const strong = new Map<string, string>([
    [sha256("email:a@x.io"), "A"], [sha256("phone:+12145550101"), "B"], [sha256("namedob:asha|verma|1995-03-15"), "C"],
  ]);
  const names = new Map([[sha256("name:asha|verma"), new Set(["C"])], [sha256("name:ravi|kumar"), new Set(["D", "E"])]]);
  const id = (o: Partial<{ emails: string[]; phone: string | null; nameKey: string | null; dob: string | null }>) =>
    ({ emails: [], phone: null, nameKey: null, dob: null, ...o });
  it("prefers email, then phone, then name + DOB", () => {
    expect(matchPerson(id({ emails: ["a@x.io"] }), strong, names)).toEqual({ personKey: "A", reason: null });
    expect(matchPerson(id({ phone: "+12145550101" }), strong, names)).toEqual({ personKey: "B", reason: null });
    expect(matchPerson(id({ nameKey: "asha|verma", dob: "1995-03-15" }), strong, names)).toEqual({ personKey: "C", reason: null });
  });
  it("conflicting, ambiguous, name-only and missing matches go to review", () => {
    expect(matchPerson(id({ emails: ["a@x.io"], phone: "+12145550101" }), strong, names).reason).toBe("conflicting_match");
    expect(matchPerson(id({ nameKey: "asha|verma" }), strong, names)).toEqual({ personKey: "C", reason: "name_only_match" });
    expect(matchPerson(id({ nameKey: "ravi|kumar" }), strong, names)).toEqual({ personKey: null, reason: "ambiguous_match" });
    expect(matchPerson(id({ emails: ["z@x.io"] }), strong, names)).toEqual({ personKey: null, reason: "no_candidate_match" });
  });
});

describe("resolveBatch", () => {
  it("rejects exact duplicate rows and flags probable duplicates of an earlier person", () => {
    const r = resolve([sales(2), sales(3), sales(4, { Phone: "214-555-0199" }), sales(5, { "Marketing Email": "other@m.example", Phone: "214-555-0177" })]);
    expect(r["sales 2"]!.state).toBe("clean");
    expect(r["sales 3"]).toMatchObject({ state: "rejected", reasons: ["duplicate_row"] });
    expect(r["sales 4"]).toMatchObject({ state: "review", reasons: ["probable_duplicate"], personKey: r["sales 2"]!.rowKey });
    expect(r["sales 5"]).toMatchObject({ state: "review", reasons: ["possible_duplicate_name"] });
  });

  it("links interview and placement rows to their person and fills the owner from the candidate", () => {
    const r = resolve([sales(2, { Status: "Confirmation" }), interview(2), placement(2)]);
    expect(r["interviews 2"]).toMatchObject({ state: "clean", personKey: r["sales 2"]!.rowKey });
    expect((r["interviews 2"]!.norm as { ownerId: string }).ownerId).toBe("user-r1");
    expect(r["placements 2"]!.state).toBe("clean");
    expect(r["sales 2"]!.state).toBe("clean");
  });

  it("holds activity of a person who cannot load, and placements while placement loading is off", () => {
    const r = resolve([sales(2, { Phone: "bad" }), interview(2)]);
    expect(r["interviews 2"]).toMatchObject({ state: "held", reasons: ["candidate_not_loadable"] });
    const off = resolve([sales(2), placement(2, { Status: "Backout" })], { config: cfg() });
    expect(off["placements 2"]).toMatchObject({ state: "held", reasons: ["placements_commit_disabled"] });
  });

  it("only accepts a sales status the app's transitions can reach", () => {
    expect(resolve([sales(2, { Status: "Bench" })])["sales 2"]!.reasons).toEqual(["status_not_importable"]);
    expect(resolve([sales(2, { Status: "Placed" })])["sales 2"]!.reasons).toEqual(["status_requires_placement"]);
    expect(resolve([sales(2, { Status: "Placed" }), placement(2, { Status: "Joined" })])["sales 2"]!.state).toBe("clean");
    expect(resolve([sales(2, { Status: "On Hold" }), placement(2)])["sales 2"]!.reasons).toEqual(["status_conflicts_with_placement"]);
    expect(resolve([sales(2, { Status: "On Hold" }), placement(2, { Status: "Backout" })])["sales 2"]!.state).toBe("clean");
    const two = resolve([sales(2, { Status: "Confirmation" }), placement(2), placement(3, { "Job Title": "Other" })]);
    expect(two["placements 3"]!.reasons).toEqual(["multiple_open_placements"]);
    expect(resolve([sales(2), placement(2, { Status: "BGC Failed" })])["placements 2"]!.reasons).toEqual(["placement_status_not_importable"]);
  });

  it("applies reviewer decisions: approve drops the bad field, reject, link", () => {
    const bad = sales(2, { Phone: "12" });
    const key = rowKeyOf("sales", bad.cells);
    const approved = resolve([bad], { decisions: new Map([[`sales:${key}`, { action: "approve", linkRowKey: null }]]) });
    expect(approved["sales 2"]).toMatchObject({ state: "clean", reasons: [] });
    expect((approved["sales 2"]!.norm as SalesNorm).phone).toBe(null);
    const rejected = resolve([bad], { decisions: new Map([[`sales:${key}`, { action: "reject", linkRowKey: null }]]) });
    expect(rejected["sales 2"]).toMatchObject({ state: "rejected", reasons: ["rejected_by_reviewer"] });
    const stray = interview(3, { "Candidate Name": "Someone Else", "Candidate Email": "" });
    const s2 = sales(2);
    const linked = resolve([s2, stray], { decisions: new Map([[`interviews:${rowKeyOf("interviews", stray.cells)}`,
      { action: "link", linkRowKey: rowKeyOf("sales", s2.cells) }]]) });
    expect(linked["interviews 3"]).toMatchObject({ state: "clean", personKey: rowKeyOf("sales", s2.cells) });
    // Blocking reasons are not cleared by an approval.
    const blocked = sales(2, { Status: "Hot" });
    const b = resolve([blocked], { decisions: new Map([[`sales:${rowKeyOf("sales", blocked.cells)}`, { action: "approve", linkRowKey: null }]]) });
    expect(b["sales 2"]!.reasons).toEqual(["unconfirmed_status:status"]);
  });

  it("skips rows and people already loaded by an earlier batch, and attaches new activity to them", () => {
    const s = sales(2);
    const ledger = emptyLedger();
    for (const h of identityHashes({ emails: ["asha@m.example"], phone: null, nameKey: null, dob: null }).strong) {
      ledger.identities.set(h, { candidateId: "cand-1", ownerId: "user-r1" });
    }
    const r = resolve([sales(3, { Status: "On Hold" }), interview(2)], { ledger });
    expect(r["sales 3"]).toMatchObject({ state: "skipped", reasons: ["person_already_imported"], personKey: "ledger:cand-1" });
    expect(r["interviews 2"]).toMatchObject({ state: "clean", personKey: "ledger:cand-1" });
    ledger.links.set(`sales:${rowKeyOf("sales", s.cells)}`, "cand-1");
    expect(resolve([s], { ledger })["sales 2"]).toMatchObject({ state: "skipped", reasons: ["already_imported"] });
  });

  it("flags a person whose email or phone a live candidate already uses", () => {
    const s = sales(2);
    expect(resolve([s], { live: new Set([rowKeyOf("sales", s.cells)]) })["sales 2"]!.reasons).toEqual(["matches_existing_candidate"]);
  });
});
