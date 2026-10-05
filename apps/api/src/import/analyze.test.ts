import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dobToken, identityHashes, makeHmac, matchPerson, normalizeRow, resolveBatch, rowKeyFor, rowKeyOf, sourceRowKey,
  type Decision, type Ledger, type RawRow, type Refs, type SalesNorm,
} from "./analyze.js";
import { DEFAULT_MAPPING_PATH, parseMapping, type MappingConfig } from "./mapping.js";

const h = makeHmac("unit-test-key-unit-test-key-unit-test-key");
const TODAY = "2026-10-01";
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
const norm = (r: RawRow, c = cfg()) => normalizeRow(r, c, refs, h, TODAY);
const key = (r: RawRow) => rowKeyOf(r.sheet, r.cells, h);
const dec = (action: Decision["action"], linkRowKey: string | null = null, approvedReasons: string[] | null = null): Decision =>
  ({ action, linkRowKey, approvedReasons });

function resolve(raws: RawRow[], o: { config?: MappingConfig; ledger?: Ledger; decisions?: Map<string, Decision>; live?: Set<string> } = {}) {
  const c = o.config ?? cfg((m) => { m.placements.commit = true; });
  const rows = raws.map((r) => normalizeRow(r, c, refs, h, TODAY));
  const out = resolveBatch({ rows, ledger: o.ledger ?? emptyLedger(), decisions: o.decisions ?? new Map(), liveMatches: o.live ?? new Set(), placementsCommit: c.placements.commit, hmac: h });
  return Object.fromEntries(out.map((r) => [`${r.sheet} ${r.rowNo}`, r]));
}

describe("keys and normalization", () => {
  it("row key ignores column order and whitespace, and depends on the secret key", () => {
    expect(rowKeyOf("sales", { A: "1", B: " x " }, h)).toBe(rowKeyOf("sales", { B: "x", A: "1" }, h));
    expect(rowKeyOf("sales", { A: "1" }, h)).not.toBe(rowKeyOf("interviews", { A: "1" }, h));
    expect(rowKeyOf("sales", { A: "1" }, h)).not.toBe(rowKeyOf("sales", { A: "1" }, makeHmac("x".repeat(40))));
    expect(() => makeHmac("short")).toThrow(/32/);
  });

  it("normalizes a sales row and maps the status (Active/All Teams -> active + all_teams)", () => {
    const r = norm(sales(2, { "First Name": "ASHA", Status: "active / all teams", Priority: "p1", "Marketing Start Date": "4-Aug-2026" }));
    expect(r.reasons).toEqual([]);
    expect(r.norm).toMatchObject({ firstName: "Asha", phone: "+12145550101", technologyId: "tech-java", locationId: "loc-dallas",
      ownerId: "user-r1", status: "active", visibility: "all_teams", priority: "P1", marketingStartDate: "2026-08-04" });
    expect(r.statusKey).toBe("active/all teams");
  });

  it("keeps only a keyed hash of the DOB, and checks it is plausible", () => {
    const r = norm(sales(2, { DOB: "03/15/1995" }));
    expect((r.norm as SalesNorm).dob).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toMatch(/1995/);
    expect(norm(sales(2, { DOB: "03/15/2020" })).reasons).toEqual(["implausible_dob:dob"]);
    expect(norm(sales(2, { DOB: "05/06/1992" })).reasons).toEqual(["ambiguous_date:dob"]);
    expect(dobToken("1995-03-15", "detect", 30, TODAY, h)).toBe(dobToken("15/03/1995", "detect", 30, TODAY, h));
    // A stored token is read back as-is (re-analysis never sees the date).
    const t = dobToken("1995-03-15", "detect", 30, TODAY, h);
    expect((norm(sales(2, { DOB: t })).norm as SalesNorm).dob).toBe(t.slice(5));
  });

  it("date order per column: a configured order resolves ambiguity and flags contradictions", () => {
    const mdy = cfg((m) => { m.sheets.sales.dateOrders = { marketingStartDate: "MDY" }; });
    expect(norm(sales(2, { "Marketing Start Date": "05/06/2026" }), mdy).norm).toMatchObject({ marketingStartDate: "2026-05-06" });
    expect(norm(sales(2, { "Marketing Start Date": "25/06/2026" }), mdy).reasons).toEqual(["date_order_conflict:marketingStartDate"]);
    expect(norm(sales(2, { "Marketing Start Date": "05/06/2026" })).reasons).toEqual(["ambiguous_date:marketingStartDate"]);
    expect(() => cfg((m) => { m.sheets.sales.dateOrders = { nope: "MDY" }; })).toThrow(/names no mapped column/);
  });

  it("phones: bare numbers need an assigned +1 area code, or a country code when no region is set", () => {
    expect(norm(sales(2, { Phone: "9876543210" })).reasons).toEqual(["invalid_phone:phone"]);
    const noRegion = cfg((m) => { m.defaults.phoneRegion = null; });
    expect(norm(sales(2), noRegion).reasons).toEqual(["phone_needs_country_code:phone"]);
    expect(norm(sales(2, { Phone: "+1 214 555 0101" }), noRegion).reasons).toEqual([]);
  });

  it("collects every problem on a row as field-level reasons", () => {
    const r = norm(sales(2, { Phone: "12", Technology: "Cobol", Location: "Mars", "Recruiter Email": "gone@x.example", Status: "Hot", Priority: "urgent" }));
    expect(r.reasons.sort()).toEqual(["inactive_owner:owner", "invalid_phone:phone", "invalid_priority:priority",
      "unconfirmed_status:status", "unknown_location:location", "unknown_technology:technology"]);
  });

  it("row colour: placeholders and unmapped colours go to review; a confirmed colour must agree with the text", () => {
    const withGreen = cfg((m) => { m.rowColors.sales["#00ff00"] = { status: "on_hold" }; });
    const go = (o: Record<string, string>, c = withGreen) => norm(sales(2, { "Row Color": "", ...o }), c).reasons;
    expect(go({ "Row Color": "#B7E1CD" })).toEqual(["unconfirmed_row_color:rowColor"]);
    expect(go({ "Row Color": "#123456" })).toEqual(["unmapped_row_color:rowColor"]);
    expect(go({ "Row Color": "#00ff00" })).toEqual(["status_color_conflict:rowColor"]);
    expect(go({ "Row Color": "#00ff00", Status: "On Hold" })).toEqual([]);
    expect(norm(sales(2, { "Row Color": "#00ff00", Status: "" }), withGreen).norm).toMatchObject({ status: "on_hold" });
    expect(go({ Status: "" })).toEqual(["missing:status"]);
  });

  it("interview time: end time or duration, time-zone abbreviations, defaults", () => {
    const n = (o: Record<string, string>) => norm(interview(2, o));
    expect(n({ "End Time": "11:30 AM", "Time Zone": "est" }).norm).toMatchObject({ startLocal: "2026-09-01T10:00", minutes: 90, timeZone: "America/New_York" });
    expect(n({ "Duration (min)": "45 min", "Time Zone": "Asia/Kolkata" }).norm).toMatchObject({ minutes: 45, timeZone: "Asia/Kolkata" });
    expect(n({}).norm).toMatchObject({ minutes: 60, timeZone: "America/Chicago", round: "Not recorded" });
    expect(n({ "Time Zone": "XYZ" }).reasons).toEqual(["unknown_time_zone:timeZone"]);
    expect(n({ "End Time": "9:00 AM" }).reasons).toEqual(["invalid_time:endTime"]);
    expect(n({ "Start Time": "" }).reasons).toEqual(["missing:startTime"]);
  });
});

describe("matching (email, then phone; name + DOB or a name alone is only a suggestion)", () => {
  const ids = (o: Partial<{ emails: string[]; phone: string | null; nameKey: string | null; dob: string | null }>) =>
    ({ emails: [], phone: null, nameKey: null, dob: null, ...o });
  const strong = new Map<string, string>([
    [h("email:a@x.io"), "A"], [h("phone:+12145550101"), "B"], [h("namedob:asha|verma|d1"), "C"],
  ]);
  const names = new Map([[h("name:asha|verma"), new Set(["C"])], [h("name:ravi|kumar"), new Set(["D", "E"])]]);
  it("email, then phone; name + DOB is a reviewable suggestion", () => {
    expect(matchPerson(ids({ emails: ["a@x.io"] }), strong, names, h)).toEqual({ personKey: "A", reason: null });
    expect(matchPerson(ids({ phone: "+12145550101" }), strong, names, h)).toEqual({ personKey: "B", reason: null });
    expect(matchPerson(ids({ nameKey: "asha|verma", dob: "d1" }), strong, names, h)).toEqual({ personKey: "C", reason: "name_dob_match" });
  });
  it("conflicting, ambiguous, name-only and missing matches go to review", () => {
    expect(matchPerson(ids({ emails: ["a@x.io"], phone: "+12145550101" }), strong, names, h).reason).toBe("conflicting_match");
    expect(matchPerson(ids({ nameKey: "asha|verma" }), strong, names, h)).toEqual({ personKey: "C", reason: "name_only_match" });
    expect(matchPerson(ids({ nameKey: "ravi|kumar" }), strong, names, h)).toEqual({ personKey: null, reason: "ambiguous_match" });
    expect(matchPerson(ids({ emails: ["z@x.io"] }), strong, names, h)).toEqual({ personKey: null, reason: "no_candidate_match" });
  });
  it("non-Latin names keep their letters (they do not all collapse to one key)", () => {
    const a = norm(sales(2, { "First Name": "राम", "Last Name": "शर्मा", "Marketing Email": "", Phone: "" }));
    const b = norm(sales(3, { "First Name": "सीता", "Last Name": "वर्मा", "Marketing Email": "", Phone: "" }));
    expect(a.identity.nameKey).not.toBe(b.identity.nameKey);
    expect(a.identity.nameKey).not.toBe("|");
    const r = resolve([sales(2, { "First Name": "राम", "Last Name": "शर्मा", "Marketing Email": "", Phone: "" }),
      sales(3, { "First Name": "सीता", "Last Name": "वर्मा", "Marketing Email": "", Phone: "" })]);
    expect(r["sales 3"]!.state).toBe("clean");
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
    expect((r["sales 2"]!.norm as SalesNorm).identities).toHaveLength(2); // email, phone
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

  it("approve clears only the reasons the reviewer accepted, dropping the bad field", () => {
    const bad = sales(2, { Phone: "12" });
    const k = `sales:${key(bad)}`;
    const approved = resolve([bad], { decisions: new Map([[k, dec("approve", null, ["invalid_phone:phone"])]]) });
    expect(approved["sales 2"]).toMatchObject({ state: "clean", reasons: [] });
    expect((approved["sales 2"]!.norm as SalesNorm).phone).toBe(null);
    // The same row with a new problem the reviewer never saw stays in review.
    const changed = sales(2, { Phone: "12" });
    const c2 = cfg((m) => { m.placements.commit = true; m.statuses.sales["active"] = null; });
    const again = resolve([changed], { config: c2, decisions: new Map([[k, dec("approve", null, ["invalid_phone:phone"])]]) });
    expect(again["sales 2"]!.reasons).toEqual(["unconfirmed_status:status"]);
    // An approval without accepted reasons clears nothing.
    expect(resolve([bad], { decisions: new Map([[k, dec("approve", null, [])]]) })["sales 2"]!.reasons).toEqual(["invalid_phone:phone"]);
    const rejected = resolve([bad], { decisions: new Map([[k, dec("reject")]]) });
    expect(rejected["sales 2"]).toMatchObject({ state: "rejected", reasons: ["rejected_by_reviewer"] });
  });

  it("link attaches a stray row to a sales row", () => {
    const stray = interview(3, { "Candidate Name": "Someone Else", "Candidate Email": "" });
    const s2 = sales(2);
    const linked = resolve([s2, stray], { decisions: new Map([[`interviews:${key(stray)}`, dec("link", key(s2))]]) });
    expect(linked["interviews 3"]).toMatchObject({ state: "clean", personKey: key(s2) });
  });

  it("skips rows and people already loaded by email or phone; name + DOB alone goes to review", () => {
    const s = sales(2);
    const ledger = emptyLedger();
    for (const x of identityHashes({ emails: ["asha@m.example"], phone: null, nameKey: null, dob: null }, h).strong) {
      ledger.identities.set(x, { candidateId: "cand-1", ownerId: "user-r1" });
    }
    const r = resolve([sales(3, { Status: "On Hold" }), interview(2)], { ledger });
    expect(r["sales 3"]).toMatchObject({ state: "skipped", reasons: ["person_already_imported"], personKey: "ledger:cand-1" });
    expect(r["interviews 2"]).toMatchObject({ state: "clean", personKey: "ledger:cand-1" });
    ledger.links.set(`sales:${key(s)}`, "cand-1");
    expect(resolve([s], { ledger })["sales 2"]).toMatchObject({ state: "skipped", reasons: ["already_imported"] });

    const dobOnly = emptyLedger();
    const withDob = sales(4, { "Marketing Email": "new@m.example", Phone: "214-555-0144", DOB: "1995-03-15" });
    const nd = identityHashes(normalizeRow(withDob, cfg(), refs, h, TODAY).identity, h).nameDob!;
    dobOnly.identities.set(nd, { candidateId: "cand-2", ownerId: "user-r1" });
    expect(resolve([withDob], { ledger: dobOnly })["sales 4"]).toMatchObject({ state: "review", reasons: ["matches_imported_person"] });
  });

  it("flags a person whose email or phone a live candidate already uses", () => {
    const s = sales(2);
    expect(resolve([s], { live: new Set([key(s)]) })["sales 2"]!.reasons).toEqual(["matches_existing_candidate"]);
  });
});

describe("crewnex batches: source ids (C1a.2, D3)", () => {
  const cn = () => cfg((m) => {
    m.placements.commit = true;
    for (const sheet of ["sales", "interviews", "placements"]) m.sheets[sheet].columns.sourceId = "Source Id";
    for (const sheet of ["interviews", "placements"]) m.sheets[sheet].columns.consultantSourceId = "Consultant Id";
  });
  const cnKey = (r: RawRow) => rowKeyFor(r.sheet, r.cells, cn(), "crewnex", h);
  function resolveCn(raws: RawRow[], o: { ledger?: Ledger; decisions?: Map<string, Decision> } = {}) {
    const c = cn();
    const rows = raws.map((r) => normalizeRow(r, c, refs, h, TODAY, "crewnex"));
    const out = resolveBatch({ rows, ledger: o.ledger ?? emptyLedger(), decisions: o.decisions ?? new Map(), liveMatches: new Set(),
      placementsCommit: true, hmac: h, source: "crewnex" });
    return Object.fromEntries(out.map((r) => [`${r.sheet} ${r.rowNo}`, r]));
  }
  const srcHash = (id: string) => identityHashes({ emails: [], phone: null, nameKey: null, dob: null, source: id }, h).source!;

  it("keys a row by sheet + CrewNex id, so a cell edit keeps the key and the review decision", () => {
    const before = sales(2, { "Source Id": "cn_1", Phone: "12" });
    const edited = sales(7, { "Source Id": "cn_1", Phone: "12", Priority: "P2", "Last Name": "Verma-Rao" });
    expect(cnKey(edited)).toBe(cnKey(before));
    expect(cnKey(before)).toBe(sourceRowKey("sales", "cn_1", h));
    expect(cnKey(before)).not.toBe(key(before)); // not the cell hash
    expect(cnKey(interview(2, { "Source Id": "cn_1" }))).not.toBe(cnKey(before)); // the sheet is part of the key
    expect(cnKey(sales(2, { "Source Id": "cn_2" }))).not.toBe(cnKey(before));
    // A sheet batch ignores the column: the cell hash, as before.
    expect(rowKeyFor("sales", before.cells, cn(), "sheets", h)).toBe(key(before));
    const decisions = new Map([[`sales:${cnKey(before)}`, dec("approve", null, ["invalid_phone:phone"])]]);
    expect(resolveCn([before], { decisions })["sales 2"]).toMatchObject({ state: "clean", rowKey: cnKey(before) });
    expect(resolveCn([edited], { decisions })["sales 7"]).toMatchObject({ state: "clean", rowKey: cnKey(before) });
    // In a sheet batch the same edit is a new row: the decision no longer applies.
    expect(resolve([edited], { decisions: new Map([[`sales:${key(before)}`, dec("approve", null, ["invalid_phone:phone"])]]) })["sales 7"]!.state)
      .toBe("review");
  });

  it("a missing or unusable source id is a review reason no reviewer can approve", () => {
    const r = resolveCn([sales(2), sales(3, { "Source Id": "  ", Phone: "214-555-0133" }), sales(4, { "Source Id": "has space" }), sales(5, { "Source Id": "x".repeat(201) })]);
    expect(r["sales 2"]).toMatchObject({ state: "review", reasons: ["missing_source_id"] });
    expect(r["sales 3"]!.reasons).toContain("missing_source_id");
    expect(r["sales 4"]!.reasons).toContain("invalid_source_id");
    expect(r["sales 5"]!.reasons).toContain("invalid_source_id");
    const iv = resolveCn([sales(2, { "Source Id": "cn_1" }), interview(2, { "Consultant Id": "cn_1" })]);
    expect(iv["interviews 2"]).toMatchObject({ state: "review", reasons: ["missing_source_id"] });
  });

  it("two rows of one sheet with the same source id both go to review; the same id on another sheet is fine", () => {
    const r = resolveCn([sales(2, { "Source Id": "cn_1" }), sales(3, { "Source Id": "cn_1", Phone: "214-555-0199", "Marketing Email": "" }),
      interview(2, { "Source Id": "iv_1", "Consultant Id": "cn_1" }), interview(3, { "Source Id": "iv_1", "Consultant Id": "cn_1", "Job Title": "Other" }),
      placement(2, { "Source Id": "cn_1", "Consultant Id": "cn_1" })]);
    expect(r["sales 2"]!.state).toBe("review");
    expect(r["sales 2"]!.reasons).toContain("duplicate_source_id");
    expect(r["sales 3"]!.state).toBe("review");
    expect(r["sales 3"]!.reasons).toContain("duplicate_source_id");
    expect(r["interviews 2"]!.reasons).toContain("duplicate_source_id");
    expect(r["interviews 3"]!.reasons).toContain("duplicate_source_id");
    expect(r["placements 2"]!.reasons).not.toContain("duplicate_source_id");
    expect(r["placements 2"]!.state).toBe("held"); // its person cannot load
  });

  it("a shared marketing email never makes two CrewNex consultants one person (the sheet rule would)", () => {
    const a = sales(2, { "Source Id": "cn_a", "Personal Email": "asha@p.example", Phone: "214-555-0101" });
    const b = sales(3, { "Source Id": "cn_b", "First Name": "Bina", "Last Name": "Rao", "Personal Email": "bina@p.example", Phone: "214-555-0102" });
    const r = resolveCn([a, b]); // both carry Marketing Email asha@m.example
    expect(r["sales 2"]).toMatchObject({ state: "clean", personKey: cnKey(a) });
    expect(r["sales 3"]).toMatchObject({ state: "clean", personKey: cnKey(b) });
    const mkt = identityHashes({ emails: ["asha@m.example"], phone: null, nameKey: null, dob: null }, h).emails[0]!;
    expect((r["sales 2"]!.norm as SalesNorm).identities).not.toContain(mkt);
    expect((r["sales 2"]!.norm as SalesNorm).identities).toContain(srcHash("cn_a"));
    expect((r["sales 2"]!.norm as SalesNorm).marketingEmail).toBe("asha@m.example"); // still loaded, just not identity
    // An earlier batch that loaded cn_a: cn_b is not skipped as that person.
    const ledger = emptyLedger();
    for (const x of (r["sales 2"]!.norm as SalesNorm).identities) ledger.identities.set(x, { candidateId: "cand-a", ownerId: "user-r1" });
    ledger.identities.set(mkt, { candidateId: "cand-a", ownerId: "user-r1" }); // even if a sheet batch had recorded it
    expect(resolveCn([b], { ledger })["sales 3"]).toMatchObject({ state: "clean", personKey: cnKey(b) });
    // The sheet rule, for contrast: the shared marketing email is one person.
    const sh = resolve([sales(2, { "Personal Email": "asha@p.example" }),
      sales(3, { "First Name": "Bina", "Last Name": "Rao", "Personal Email": "bina@p.example", Phone: "214-555-0102" })]);
    expect(sh["sales 3"]!.reasons).toEqual(["probable_duplicate"]);
  });

  it("a consultant id already in the ledger is that person: its sales row is skipped and new activity attaches to it", () => {
    const s = sales(2, { "Source Id": "cn_1", Status: "On Hold" });
    const ledger = emptyLedger();
    ledger.identities.set(srcHash("cn_1"), { candidateId: "cand-1", ownerId: "user-r1" });
    const r = resolveCn([s, interview(2, { "Source Id": "iv_9", "Consultant Id": "cn_1", "Candidate Email": "" })], { ledger });
    expect(r["sales 2"]).toMatchObject({ state: "skipped", reasons: ["person_already_imported"], personKey: "ledger:cand-1" });
    expect(r["interviews 2"]).toMatchObject({ state: "clean", personKey: "ledger:cand-1" });
    // The same row (same id, edited cells) loaded before: skipped by its key.
    ledger.links.set(`sales:${cnKey(s)}`, "cand-1");
    expect(resolveCn([sales(4, { "Source Id": "cn_1", Priority: "P3" })], { ledger })["sales 4"])
      .toMatchObject({ state: "skipped", reasons: ["already_imported"], personKey: "ledger:cand-1" });
  });

  it("a consultant id decides the person alone: unknown ids go to review even when the email matches", () => {
    const r = resolveCn([sales(2, { "Source Id": "cn_1" }),
      interview(2, { "Source Id": "iv_1", "Consultant Id": "cn_2" }),
      interview(3, { "Source Id": "iv_2", "Consultant Id": "cn_1", "Candidate Email": "someone@else.example", "Candidate Name": "X Y" }),
      interview(4, { "Source Id": "iv_3", "Consultant Id": "bad id" })]);
    expect(r["interviews 2"]).toMatchObject({ state: "review", reasons: ["unknown_consultant_source_id"], personKey: null });
    expect(r["interviews 3"]).toMatchObject({ state: "clean", personKey: cnKey(sales(2, { "Source Id": "cn_1" })) });
    expect(r["interviews 4"]!.reasons).toContain("invalid_consultant_source_id");
  });
});
