import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";
import { personRef, placementStatus, splitClient, teamWorkbook, workbookTexts } from "./team-workbook.js";
import type { WorkbookSheet } from "./xlsx.js";

const SUB_H = ["Date", "Candidate Name", "Technology", "Rate", "Vendor", "Client", "Manager", "Team Lead", "Recruiter Name"];
const IV_H = ["Date", "Candidate Name", "Recruiter Name", "Manager", "Team Lead", "Technology", "Support Name", "Interview Type",
  "Feedback From Client", "Feedback From Candidate", "Reason For Rejection"];
// The header typo is as found in real exports.
const PL_H = ["Date", "Canddiate Name", "Technology", "Rate", "Vendor", "Client", "Manager", "Team Lead", "Recruiter Name",
  "BGV Status", "Placement Date", "Joining Date", "Phone Number", "Marketing Company", "Everify Company"];
const src = (tab: string) => ({ spreadsheetId: "1fictional", range: `${tab}!A:O`, tab });

/** Fictional team workbook: two teams, one shared candidate, a pasted (no IMPORTRANGE) tab and a notes tab. */
const SHEETS: WorkbookSheet[] = [
  { name: "Rohit Submissions", headerRow: 1, headers: SUB_H, source: src("Submissions"), rows: [
    ["2026-08-03", "Asha Verma", "Java", "65", "northwind staffing", "Contoso / Northwind Financial", "Mira Shah", "Rohit Das", "Priya Nair"],
    ["08/04/2026", "Asha Verma", "Java", "$70/", "fabrikam", "Woodgrove Bank", "Mira Shah", "Rohit Das", "Priya Nair"],
    ["2026-08-20", "Ben  Cole", "Python", "60hr", "fabrikam", "Proseware - 3/12", "Mira Shah", "Rohit Das", "Sam Lee"],
  ] },
  { name: "Rohit Interviews", headerRow: 1, headers: IV_H, source: src("Interviews"), rows: [
    // Ben was submitted to one client in the 30 days before: inferred.
    ["2026-08-25", "Ben Cole", "Sam Lee", "Mira Shah", "Rohit Das", "Python", "Other Resource", "L1", "Selected", "Good", ""],
    // Asha was submitted to two clients: no client.
    ["2026-08-10", "Asha Verma", "Priya Nair", "Mira Shah", "Rohit Das", "Java", "Jason", "L2", "Hold", "", ""],
    // After the as-of date: scheduled.
    ["2026-10-20", "Ben Cole", "Sam Lee", "Mira Shah", "Rohit Das", "Python", "Self", "Final Round", "", "", ""],
  ] },
  { name: "Anjali Submissions", headerRow: 1, headers: SUB_H, source: src("Submissions"), rows: [
    ["2026-08-05", "ASHA VERMA", "Java", "66", "tailspin", "Fourth Coffee", "Mira Shah", "Anjali Rao", "Kiran Rao"],
  ] },
  { name: "Anjali Placements", headerRow: 1, headers: PL_H, rows: [
    ["2026-09-01", "Asha Verma", "Java", "66", "tailspin", "Fourth Coffee", "Mira Shah", "Anjali Rao", "Kiran Rao",
      "Done", "2026-09-01", "2026-09-15", "214-555-0101", "Fictional Tech LLC", "Fictional Tech LLC"],
    ["2026-09-05", "Cy Dunn", "Java", "60", "tailspin", "Litware", "Mira Shah", "Anjali Rao", "Kiran Rao",
      "Not Cleared", "", "-", "", "", ""],
  ] },
  { name: "Notes", headerRow: 1, headers: ["Week", "Comment"], rows: [["1", "kick-off"]] },
];

describe("team workbook helpers", () => {
  it("splits 'Implementer / End client' only when both sides are names", () => {
    expect(splitClient("Contoso / Tailspin Energy")).toEqual({ partner: "Contoso", client: "Tailspin Energy" });
    expect(splitClient("Fabrikam/Woodgrove Bank")).toEqual({ partner: "Fabrikam", client: "Woodgrove Bank" });
    expect(splitClient("Proseware - 3/12")).toEqual({ partner: "", client: "Proseware - 3/12" });
    expect(splitClient("A / B / C")).toEqual({ partner: "", client: "A / B / C" });
  });

  it("derives the placement status from the BGV status and joining date", () => {
    expect(placementStatus("Done", "2026-09-15", "2026-10-10")).toBe("Joined");
    expect(placementStatus("Cleared", "2026-11-01", "2026-10-10")).toBe("Ready");
    expect(placementStatus("Complete", null, "2026-10-10")).toBe("Ready");
    expect(placementStatus("On Going", null, "2026-10-10")).toBe("BGC");
    expect(placementStatus("Not Cleared", null, "2026-10-10")).toBe("BGC Failed");
    expect(placementStatus("", null, "2026-10-10")).toBe("Confirmed");
  });

  it("keys a person by the letters of the name, whatever the case and spacing", () => {
    expect(personRef("ASHA  Verma")).toBe(personRef("asha verma"));
    expect(personRef(" ")).toBe("");
  });
});

describe("teamWorkbook", () => {
  const wb = teamWorkbook(SHEETS, { asOf: "2026-10-10" });

  it("classifies tabs by IMPORTRANGE source, then name; ignores other tabs", () => {
    expect(wb.tabs.map((t) => [t.name, t.kind, t.team, t.by])).toEqual([
      ["Rohit Submissions", "submissions", "Rohit", "source"],
      ["Rohit Interviews", "interviews", "Rohit", "source"],
      ["Anjali Submissions", "submissions", "Anjali", "source"],
      ["Anjali Placements", "placements", "Anjali", "name"],
    ]);
    expect(wb.ignored).toEqual(["Notes"]);
  });

  it("makes one person per name: owner by most submissions, all teams when several teams submit", () => {
    const people = Object.fromEntries(wb.sheets.sales.rows.map((r) => [r[1], r]));
    const asha = people[personRef("Asha Verma")]!;
    expect(asha.slice(0, 7)).toEqual(["Asha Verma", personRef("Asha Verma"), "214-555-0101", "Java", "Priya Nair", "Active/All Teams", "Anjali, Rohit"]);
    expect(people[personRef("Ben Cole")]!.slice(4, 6)).toEqual(["Sam Lee", "Active"]);
    expect(people[personRef("Cy Dunn")]!.slice(4, 6)).toEqual(["Kiran Rao", "Active"]);
    expect(wb.stats).toEqual({ candidates: 3, multiTeamCandidates: 1, interviewsWithInferredClient: 1, interviewsWithoutClient: 2 });
  });

  it("submissions: end client, job title from technology, source tab and row", () => {
    expect(wb.sheets.submissions.rows[0]).toEqual(["2026-08-03", "Asha Verma", personRef("Asha Verma"), "Java", "Java", "65",
      "northwind staffing", "Northwind Financial", "Contoso / Northwind Financial", "Priya Nair", "Rohit Das", "Mira Shah", "Rohit Submissions", "2"]);
  });

  it("interviews: client inferred only from a single recent client, scheduled after the as-of date", () => {
    const [ben, asha, later] = wb.sheets.interviews.rows;
    const col = (h: string) => wb.sheets.interviews.headers.indexOf(h);
    expect([ben![col("Client")], ben![col("Vendor")], ben![col("Call Status")]]).toEqual(["Proseware - 3/12", "fabrikam", "Completed"]);
    expect(ben![col("Client Inferred")]).toMatch(/only this client/);
    expect([asha![col("Client")], asha![col("Client Inferred")]]).toEqual(["", ""]);
    expect(later![col("Call Status")]).toBe("Scheduled");
  });

  it("placements: split client, joined status, a dash is no joining date", () => {
    const col = (h: string) => wb.sheets.placements.headers.indexOf(h);
    const [asha, cy] = wb.sheets.placements.rows;
    expect([asha![col("Client")], asha![col("Implementation Partner")], asha![col("Status")], asha![col("Tentative Start")]])
      .toEqual(["Fourth Coffee", "", "Joined", "2026-09-15"]);
    expect([cy![col("Status")], cy![col("Tentative Start")]]).toEqual(["BGC Failed", ""]);
  });

  it("produces staging CSV per sheet with the tabs it came from", () => {
    const t = workbookTexts(wb, "team.xlsx", "2026-10-10");
    expect(Object.keys(t)).toEqual(["sales", "submissions", "interviews", "placements"]);
    expect(parseCsv(t.submissions!.text).rows).toHaveLength(4);
    expect(t.placements!.source).toEqual({ adapter: "team-workbook", asOf: "2026-10-10",
      tabs: [{ tab: "Anjali Placements", team: "Anjali", rows: 2, by: "name" }] });
  });
});
