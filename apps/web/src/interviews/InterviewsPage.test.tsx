import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewsPage, dateBoundary, type Interview } from "./InterviewsPage";
import type { Me } from "../api";
const me: Me = { id: "u", email: "a@example.com", displayName: "Recruiter", roles: [], capabilities: ["interview:read", "interview:create"], csrfToken: "t" };
const row: Interview = { id: "i1", submissionId: "s1", candidate: { id: "c", name: "Alex Doe" }, recruiter: { id: "u", name: "Recruiter" }, team: null, location: null, client: null, round: "Technical", startsAt: "2026-10-01T14:00:00Z", endsAt: "2026-10-01T15:00:00Z", coach: null, inviteReceived: false, callStatus: "scheduled", cleared: false, consentCaptured: false, otterUrl: "https://example.com/secret", recordingUrl: null, systemName: null, editableFields: ["cleared", "consentCaptured", "systemName", "callStatus"], feedbackKinds: ["location"] };
const json = (value: unknown) => new Response(JSON.stringify(value));
const lookups = (locations: { id: string; name: string }[]) => ({ technologies: [], clients: [], vendors: [], implementationPartners: [], roles: [], coaches: [], locations });
function setup(item = row, capabilities = me.capabilities, locations = [{ id: "dal", name: "Dallas" }], feedbackItems: unknown[] = [], busy: { startsAt: string; endsAt: string }[] = [], block: unknown = null) {
 const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
   const path = String(url);
   if (path.includes("/lookups")) return json(lookups(locations));
   if (path.includes("/calendar/support/busy")) return json({ connected: true, available: true, busy });
   if (path.includes("/calendar-block")) return json({ block, canBlock: block !== null, connected: true });
   if (path.includes("/feedback")) return json({ items: feedbackItems });
   if (path.includes("/coaches")) return json({ items: [{ id: "coach", name: "Coach One" }] });
   if (path.includes("/panel-options")) return json({ items: [{ id: "p1", name: "Ajith Trainer" }, { id: "p2", name: "Pawan Incharge" }] });
   if (path === "/api/v1/interviews/i1") return json({ ...item, panel: [{ id: "p1", name: "Ajith Trainer", lead: true }], lead: { id: "p1", name: "Ajith Trainer" } });
   if (path.includes("/submissions")) return json({ items: [{ id: "s1", candidateName: "Alex Doe", client: "Acme", jobTitle: "Engineer", status: "submitted" }, { id: "closed", candidateName: "Closed Candidate", status: "rejected" }], nextCursor: null });
   if (init?.method) return json({ id: "i1" });
   return json({ items: [item], nextCursor: null });
 });
 render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InterviewsPage me={{ ...me, capabilities }} /></QueryClientProvider>);
 return fetch;
}
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
/** Row actions other than the primary one sit in the row's "More actions" menu. */
const openRowAction = (item: string, name = "Alex Doe") => {
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${name}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};
/** The one booking form: pick a day (any date), a start time and a length. */
const pickSlot = (dlg: HTMLElement, stamp: string, duration?: number) => {
  fireEvent.change(within(dlg).getByLabelText("Other date"), { target: { value: stamp.slice(0, 10) } });
  fireEvent.change(within(dlg).getByLabelText("Start time"), { target: { value: stamp.slice(11, 16) } });
  if (duration) fireEvent.change(within(dlg).getByRole("combobox", { name: "Duration" }), { target: { value: String(duration) } });
};
describe("interview board", () => {
 it("uses local midnight and the following local midnight for inclusive date filters", () => {
   expect(dateBoundary("2026-10-01")).toBe(new Date(2026, 9, 1).toISOString());
   expect(dateBoundary("2026-10-01", true)).toBe(new Date(2026, 9, 2).toISOString());
 });
 it("only offers location fields, sends changed fields, and never exposes links without consent", async () => {
   const fetch = setup(); await screen.findByText("Alex Doe");
   expect(screen.queryByRole("link", { name: "Otter" })).not.toBeInTheDocument();
   openRowAction("Edit interview");
   const dialog = screen.getByRole("dialog");
   expect(within(dialog).queryByRole("group", { name: "Panel list" })).not.toBeInTheDocument();
   expect(within(dialog).queryByLabelText("Meeting link")).not.toBeInTheDocument();
   expect(within(dialog).queryByLabelText("Round")).not.toBeInTheDocument();
   expect(within(dialog).queryByLabelText("Recording URL")).not.toBeInTheDocument();
   fireEvent.click(within(dialog).getByLabelText("Cleared for interview (readiness)"));
   fireEvent.click(within(dialog).getByRole("button", { name: "Save interview" }));
   await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/interviews/i1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ cleared: true }) })));
 });
 it("coach can add only coached feedback and has no edit or schedule actions", async () => {
   const fetch = setup({ ...row, editableFields: [], feedbackKinds: ["coach"] }, ["interview:read"]);
   await screen.findByText("Alex Doe");
   expect(screen.queryByRole("button", { name: "Schedule interview" })).not.toBeInTheDocument();
   expect(screen.queryByRole("button", { name: "Edit interview" })).not.toBeInTheDocument();
   fireEvent.click(screen.getByRole("button", { name: "More actions for Alex Doe" }));
   expect(screen.queryByRole("menuitem", { name: "Edit interview" })).not.toBeInTheDocument();
   fireEvent.click(screen.getByRole("menuitem", { name: "Feedback" }));
   expect(within(screen.getByLabelText("Feedback kind")).getAllByRole("option")).toHaveLength(1);
   fireEvent.change(screen.getByLabelText("Rating"), { target: { value: "4" } });
   fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Clear technical examples" } });
   fireEvent.click(screen.getByRole("button", { name: "Add feedback" }));
   await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/interviews/i1/feedback", expect.objectContaining({ method: "POST", body: JSON.stringify({ kind: "coach", rating: 4, notes: "Clear technical examples" }) })));
   expect(await screen.findByText("Feedback added.")).toBeInTheDocument();
 });
 it("schedules from an open scoped submission with active coach and UTC instants", async () => {
   const fetch = setup(); fireEvent.click(screen.getByRole("button", { name: "Schedule interview" }));
   await screen.findByRole("option", { name: "Alex Doe · Acme · Engineer" });
   expect(screen.queryByRole("option", { name: /Closed Candidate/ })).not.toBeInTheDocument();
   const dlg = screen.getByRole("dialog", { name: "Schedule interview" });
   fireEvent.change(screen.getByLabelText("Submission"), { target: { value: "s1" } });
   fireEvent.change(screen.getByLabelText("Round"), { target: { value: "Technical" } });
   // The chosen submission is named under the picker (no read-only echo fields).
   expect(within(dlg).getByText("Alex Doe · Engineer at Acme")).toBeInTheDocument();
   // The time zone comes first; times are read in it.
   expect(within(dlg).getByRole("combobox", { name: "Time zone" })).toBeInTheDocument();
   pickSlot(dlg, "2026-10-01T10:00");
   await screen.findByRole("option", { name: "Coach One" });
   fireEvent.change(screen.getByLabelText("Coach (optional)"), { target: { value: "coach" } });
   fireEvent.click(within(dlg).getByRole("button", { name: "Schedule" }));
   await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/interviews", expect.objectContaining({ method: "POST", body: JSON.stringify({ submissionId: "s1", round: "Technical", startsAt: new Date("2026-10-01T10:00").toISOString(), durationMin: 60, coachId: "coach", inviteReceived: false, interviewType: "video" }) })));
 });
 it("filters the board by interview location when there is more than one", async () => {
   const fetch = setup(row, me.capabilities, [{ id: "dal", name: "Dallas" }, { id: "aus", name: "Austin" }]); await screen.findByText("Alex Doe");
   fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
   const select = await screen.findByRole("combobox", { name: "Location filter" });
   fireEvent.change(select, { target: { value: "aus" } });
   await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).startsWith("/api/v1/interviews?") && new URL(String(u), "http://x").searchParams.get("locationId") === "aus")).toBe(true));
   expect(new URLSearchParams(window.location.search).get("locationId")).toBe("aus");
   fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
   expect(select).toHaveValue("");
 });
 it("searches by candidate across every date unless the user picked dates", async () => {
   const fetch = setup(); await screen.findByText("Alex Doe");
   const last = () => new URL(String(fetch.mock.calls.filter(([u]) => String(u).startsWith("/api/v1/interviews?")).at(-1)![0]), "http://x").searchParams;
   expect(last().has("from")).toBe(true);
   fireEvent.change(screen.getByLabelText("Candidate"), { target: { value: " alex " } });
   await waitFor(() => expect(last().get("candidate")).toBe("alex"));
   expect(last().has("from")).toBe(false);
   expect(new URLSearchParams(window.location.search).get("candidate")).toBe("alex");
   fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-10-01" } });
   fireEvent.change(screen.getByLabelText("Candidate"), { target: { value: "alexa" } });
   await waitFor(() => expect(last().get("candidate")).toBe("alexa"));
   expect(last().has("from")).toBe(true);
   fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
   expect(screen.getByLabelText("Candidate")).toHaveValue("");
   // Clearing returns to the default board: today onward.
   await waitFor(() => expect(last().has("from")).toBe(true));
 });
 it("offers no location filter with a single location", async () => {
   const fetch = setup(); await screen.findByText("Alex Doe");
   await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes("/lookups"))).toBe(true));
   expect(screen.queryByRole("combobox", { name: "Location filter" })).not.toBeInTheDocument();
 });
 it("rejects inverted date filters without sending an invalid query", async () => {
   const fetch = setup(); await screen.findByText("Alex Doe");
   fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-10-02" } });
   fireEvent.change(screen.getByLabelText("Through date"), { target: { value: "2026-10-01" } });
   expect(screen.getByRole("alert")).toHaveTextContent("Through date must be");
   expect(fetch.mock.calls.some(([u]) => String(u).includes("to="))).toBe(false);
 });

 it("creates an interview with type, panel, lead, duration and an https meeting link", async () => {
   const fetch = setup(); fireEvent.click(screen.getByRole("button", { name: "Schedule interview" }));
   await screen.findByRole("option", { name: "Alex Doe · Acme · Engineer" });
   const dlg = screen.getByRole("dialog", { name: "Schedule interview" });
   fireEvent.click(screen.getByRole("radio", { name: "Phone" }));
   fireEvent.change(screen.getByLabelText("Submission"), { target: { value: "s1" } });
   fireEvent.change(screen.getByLabelText("Round"), { target: { value: "Initial Screening" } });
   fireEvent.change(await screen.findByLabelText("Find panel member"), { target: { value: "ajith" } });
   fireEvent.click(await screen.findByRole("button", { name: "Add Ajith Trainer" }));
   fireEvent.change(screen.getByLabelText("Find panel member"), { target: { value: "pawan" } });
   fireEvent.click(await screen.findByRole("button", { name: "Add Pawan Incharge" }));
   fireEvent.change(screen.getByRole("combobox", { name: "Lead user" }), { target: { value: "p2" } });
   pickSlot(dlg, "2026-10-15T16:00", 30);
   fireEvent.change(screen.getByLabelText("Meeting link (optional)"), { target: { value: "http://meet.example.com/x" } });
   fireEvent.click(within(dlg).getByRole("button", { name: "Schedule" }));
   expect(await within(dlg).findByText(/must start with https:\/\//)).toBeInTheDocument();
   expect(screen.getByLabelText("Meeting link (optional)")).toHaveAttribute("aria-invalid", "true");
   fireEvent.change(screen.getByLabelText("Meeting link (optional)"), { target: { value: "https://meet.example.com/x" } });
   fireEvent.click(within(dlg).getByRole("button", { name: "Schedule" }));
   await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/interviews", expect.objectContaining({ method: "POST" })));
   const post = fetch.mock.calls.find(([u, i]) => u === "/api/v1/interviews" && i?.method === "POST")!;
   expect(JSON.parse(String(post[1]!.body))).toEqual({ submissionId: "s1", round: "Initial Screening", startsAt: new Date("2026-10-15T16:00").toISOString(),
     durationMin: 30, inviteReceived: false, interviewType: "phone", meetingUrl: "https://meet.example.com/x", panelIds: ["p1", "p2"], leadId: "p2" });
 });
 it("details drawer shows the info grid, the calendar file and read-only stars as text", async () => {
   const scored = [{ id: "f1", kind: "coach", rating: 4, notes: "Strong answers", author: { id: "p1", name: "Ajith Trainer" }, round: "Technical",
     scorecard: { technicalSkills: 4, communication: 5, problemSolving: 3, attitude: 4 } }];
   setup({ ...row, interviewType: "video", meetingUrl: "https://meet.example.com/abc", durationMin: 60, position: "Engineer" }, me.capabilities, undefined, scored);
   await screen.findByText("Alex Doe");
   fireEvent.click(screen.getByRole("button", { name: "Details of the interview with Alex Doe" }));
   const drawer = await screen.findByRole("dialog", { name: "Interview details" });
   // The drawer leads with the status and the actions (no need to close it to edit or add feedback).
   expect(within(drawer).getByRole("button", { name: "Feedback" })).toBeInTheDocument();
   expect(within(drawer).getByRole("button", { name: "Edit interview" })).toBeInTheDocument();
   expect(within(drawer).getByText("Scheduled", { selector: ".badge" })).toBeInTheDocument();
   expect(await within(drawer).findAllByText("Ajith Trainer", { selector: "dd" })).toHaveLength(2); // panel list and lead
   expect(within(drawer).getByRole("link", { name: "https://meet.example.com/abc" })).toHaveAttribute("rel", "noopener noreferrer");
   expect(within(drawer).getByRole("link", { name: /Add to calendar/ })).toHaveAttribute("href", "/api/v1/interviews/i1/calendar.ics");
   const card = await within(drawer).findByRole("article", { name: "Reviewer: Ajith Trainer" });
   expect(within(card).getByRole("img", { name: "Technical skills: 4 out of 5" })).toBeInTheDocument();
   expect(within(card).getByRole("img", { name: "Communication: 5 out of 5" })).toBeInTheDocument();
   expect(within(card).getByRole("img", { name: "Overall rating: 4 out of 5" })).toBeInTheDocument();
   expect(within(card).getByText("Interview coach")).toBeInTheDocument();
 });
 it("sends a scorecard with coach feedback only when all four criteria are rated", async () => {
   const fetch = setup({ ...row, editableFields: [], feedbackKinds: ["coach"] }, ["interview:read"]);
   await screen.findByText("Alex Doe");
   openRowAction("Feedback");
   const dialog = screen.getByRole("dialog");
   fireEvent.change(within(dialog).getByLabelText("Technical skills"), { target: { value: "4" } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Add feedback" }));
   expect(await within(dialog).findByRole("alert")).toHaveTextContent("Rate all four");
   fireEvent.change(within(dialog).getByLabelText("Communication"), { target: { value: "5" } });
   fireEvent.change(within(dialog).getByLabelText("Problem solving"), { target: { value: "3" } });
   fireEvent.change(within(dialog).getByLabelText("Attitude"), { target: { value: "4" } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Add feedback" }));
   await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/interviews/i1/feedback", expect.objectContaining({ method: "POST",
     body: JSON.stringify({ kind: "coach", scorecard: { technicalSkills: 4, communication: 5, problemSolving: 3, attitude: 4 } }) })));
 });
 it("shows the support calendar's busy periods under the slot and never blocks the save (CA-7)", async () => {
   const fetch = setup(row, me.capabilities, undefined, [], [{ startsAt: new Date("2026-10-01T10:30").toISOString(), endsAt: new Date("2026-10-01T11:00").toISOString() }]);
   fireEvent.click(screen.getByRole("button", { name: "Schedule interview" }));
   await screen.findByRole("option", { name: "Alex Doe · Acme · Engineer" });
   const dlg = screen.getByRole("dialog", { name: "Schedule interview" });
   expect(fetch.mock.calls.some(([u]) => String(u).includes("/calendar/support/busy"))).toBe(false);
   pickSlot(dlg, "2026-10-01T10:00");
   expect(await screen.findByText(/Support calendar is busy/)).toBeInTheDocument();
   // The day holding the slot is queried: local midnight to the next.
   const req = fetch.mock.calls.find(([u]) => String(u).includes("/calendar/support/busy"))!;
   const params = new URL(String(req[0]), "http://x").searchParams;
   expect(params.get("from")).toBe(new Date(2026, 9, 1).toISOString());
   expect(params.get("to")).toBe(new Date(2026, 9, 2).toISOString());
   // A later slot on the same day is free without another request.
   pickSlot(dlg, "2026-10-01T14:00");
   expect(await screen.findByText("Support calendar is free for this slot.")).toBeInTheDocument();
   expect(fetch.mock.calls.filter(([u]) => String(u).includes("/calendar/support/busy"))).toHaveLength(1);
   // Busy or not, the interview can be created.
   pickSlot(dlg, "2026-10-01T10:00");
   fireEvent.change(screen.getByLabelText("Submission"), { target: { value: "s1" } });
   fireEvent.change(screen.getByLabelText("Round"), { target: { value: "Technical" } });
   fireEvent.click(within(dlg).getByRole("button", { name: "Schedule" }));
   await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/interviews", expect.objectContaining({ method: "POST" })));
 });
 it("the edit dialog leaves the interview's own block out of the busy line", async () => {
   const own = { startsAt: "2026-10-01T14:00:00Z", endsAt: "2026-10-01T15:00:00Z" };
   setup({ ...row, editableFields: ["startsAt", "durationMin"], durationMin: 60 }, me.capabilities, undefined, [], [own],
     { id: "b", calendarId: "support@x", ...own, createdAt: "2026-09-30T00:00:00Z", createdBy: { id: "u", name: "Lead" } });
   await screen.findByText("Alex Doe");
   openRowAction("Edit interview");
   const dialog = screen.getByRole("dialog");
   expect(await within(dialog).findByText("No other bookings on the support calendar during this slot.")).toBeInTheDocument();
   fireEvent.change(within(dialog).getByLabelText("Interview slot"), { target: { value: "2026-10-01T09:00" } });
   expect(await within(dialog).findByText("Support calendar is free for this slot.")).toBeInTheDocument();
 });
 it("any held round can become a placement: Clear and place clears it, selects the submission, then creates the placement", async () => {
   const sales = { ...row, client: { id: "cl", name: "Intuit" }, position: "Java FSD", round: "L1", result: "pending" as const, submissionStatus: "submitted", placement: null, editableFields: ["result", "round", "callStatus"] };
   const fetch = setup(sales, ["interview:read", "placement:create"]);
   await screen.findByText("Alex Doe");
   fireEvent.click(screen.getByRole("button", { name: "Clear and place from L1 for Alex Doe" }));
   const dlg = screen.getByRole("dialog", { name: "Clear L1 and create placement · Alex Doe" });
   expect(within(dlg).getByText(/Java FSD at Intuit/)).toBeInTheDocument();
   fireEvent.change(within(dlg).getByLabelText("Placement type"), { target: { value: "w2" } });
   fireEvent.change(within(dlg).getByLabelText("Work mode"), { target: { value: "remote" } });
   fireEvent.change(within(dlg).getByLabelText("Tentative start date"), { target: { value: "2026-12-01" } });
   fireEvent.click(within(dlg).getByRole("button", { name: "Clear and create placement" }));
   await waitFor(() => expect(screen.getByText("Placement created for Alex Doe from L1.")).toBeInTheDocument());
   const writes = fetch.mock.calls.filter(([, init]) => init?.method).map(([url]) => String(url));
   expect(writes).toEqual(["/api/v1/interviews/i1/clear-and-select", "/api/v1/placements"]);
 });
 it("no placement action without placement:create, on rejected rounds, or once placed", async () => {
   const sales = { ...row, result: "cleared" as const, submissionStatus: "selected", placement: null, editableFields: ["result"] };
   setup(sales, ["interview:read"]); await screen.findByText("Alex Doe");
   expect(screen.queryByRole("button", { name: /placement|Clear and place/ })).not.toBeInTheDocument();
   vi.restoreAllMocks(); document.body.innerHTML = "";
   setup({ ...sales, result: "rejected" }, ["interview:read", "placement:create"]); await screen.findByText("Alex Doe");
   expect(screen.queryByRole("button", { name: /placement|Clear and place/ })).not.toBeInTheDocument();
   vi.restoreAllMocks(); document.body.innerHTML = "";
   setup({ ...sales, placement: { id: "p1", status: "confirmed" } }, ["interview:read", "placement:create"]); await screen.findByText("Alex Doe");
   expect(screen.queryByRole("button", { name: /^Create placement/ })).not.toBeInTheDocument();
   vi.restoreAllMocks(); document.body.innerHTML = "";
   setup(sales, ["interview:read", "placement:create"]); await screen.findByText("Alex Doe");
   expect(screen.getByRole("button", { name: "Create placement from Technical for Alex Doe" })).toBeInTheDocument();
 });
 it("offers no scorecard for location feedback", async () => {
   setup();
   await screen.findByText("Alex Doe");
   openRowAction("Feedback");
   expect(within(screen.getByRole("dialog")).queryByLabelText("Technical skills")).not.toBeInTheDocument();
 });
});
