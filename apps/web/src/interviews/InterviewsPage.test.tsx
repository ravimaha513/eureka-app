import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewsPage, dateBoundary, type Interview } from "./InterviewsPage";
import type { Me } from "../api";
const me: Me = { id: "u", email: "a@example.com", displayName: "Recruiter", roles: [], capabilities: ["interview:read", "interview:create"], csrfToken: "t" };
const row: Interview = { id: "i1", submissionId: "s1", candidate: { id: "c", name: "Alex Doe" }, recruiter: { id: "u", name: "Recruiter" }, team: null, location: null, client: null, round: "Technical", startsAt: "2026-10-01T14:00:00Z", endsAt: "2026-10-01T15:00:00Z", coach: null, inviteReceived: false, callStatus: "scheduled", cleared: false, consentCaptured: false, otterUrl: "https://example.com/secret", recordingUrl: null, systemName: null, editableFields: ["cleared", "consentCaptured", "systemName", "callStatus"], feedbackKinds: ["location"] };
const json = (value: unknown) => new Response(JSON.stringify(value));
const lookups = (locations: { id: string; name: string }[]) => ({ technologies: [], clients: [], vendors: [], implementationPartners: [], coaches: [], locations });
function setup(item = row, capabilities = me.capabilities, locations = [{ id: "dal", name: "Dallas" }], feedbackItems: unknown[] = []) {
 const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
   const path = String(url);
   if (path.includes("/lookups")) return json(lookups(locations));
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
afterEach(() => vi.restoreAllMocks());
describe("interview board", () => {
 it("uses local midnight and the following local midnight for inclusive date filters", () => {
   expect(dateBoundary("2026-10-01")).toBe(new Date(2026, 9, 1).toISOString());
   expect(dateBoundary("2026-10-01", true)).toBe(new Date(2026, 9, 2).toISOString());
 });
 it("only offers location fields, sends changed fields, and never exposes links without consent", async () => {
   const fetch = setup(); await screen.findByText("Alex Doe");
   expect(screen.queryByRole("link", { name: "Otter" })).not.toBeInTheDocument();
   fireEvent.click(screen.getByRole("button", { name: "Edit interview" }));
   const dialog = screen.getByRole("dialog");
   expect(within(dialog).queryByRole("group", { name: "Panel list" })).not.toBeInTheDocument();
   expect(within(dialog).queryByLabelText("Meeting link")).not.toBeInTheDocument();
   expect(within(dialog).queryByLabelText("Round")).not.toBeInTheDocument();
   expect(within(dialog).queryByLabelText("Recording URL")).not.toBeInTheDocument();
   fireEvent.click(within(dialog).getByLabelText("Cleared"));
   fireEvent.click(within(dialog).getByRole("button", { name: "Save interview" }));
   await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/interviews/i1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ cleared: true }) })));
 });
 it("coach can add only coached feedback and has no edit or schedule actions", async () => {
   const fetch = setup({ ...row, editableFields: [], feedbackKinds: ["coach"] }, ["interview:read"]);
   await screen.findByText("Alex Doe");
   expect(screen.queryByRole("button", { name: "Schedule interview" })).not.toBeInTheDocument();
   expect(screen.queryByRole("button", { name: "Edit interview" })).not.toBeInTheDocument();
   fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
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
   fireEvent.change(screen.getByLabelText("Submission"), { target: { value: "s1" } });
   fireEvent.change(screen.getByLabelText("Round"), { target: { value: "Technical" } });
   expect(screen.getByLabelText("Position")).toHaveValue("Engineer");
   expect(screen.getByLabelText("Candidate name")).toHaveValue("Alex Doe");
   fireEvent.change(screen.getByLabelText("Interview slot"), { target: { value: "2026-10-01T10:00" } });
   await screen.findByRole("option", { name: "Coach One" });
   fireEvent.change(screen.getByLabelText("Coach"), { target: { value: "coach" } });
   fireEvent.click(screen.getByRole("button", { name: "Create interview" }));
   await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/interviews", expect.objectContaining({ method: "POST", body: JSON.stringify({ submissionId: "s1", round: "Technical", startsAt: new Date("2026-10-01T10:00").toISOString(), durationMin: 60, coachId: "coach", inviteReceived: false, interviewType: "video" }) })));
 });
 it("filters the board by interview location when there is more than one", async () => {
   const fetch = setup(row, me.capabilities, [{ id: "dal", name: "Dallas" }, { id: "aus", name: "Austin" }]); await screen.findByText("Alex Doe");
   const select = await screen.findByRole("combobox", { name: "Location filter" });
   fireEvent.change(select, { target: { value: "aus" } });
   await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).startsWith("/api/v1/interviews?") && new URL(String(u), "http://x").searchParams.get("locationId") === "aus")).toBe(true));
   fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
   expect(select).toHaveValue("");
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
   fireEvent.click(screen.getByRole("radio", { name: "Phone" }));
   fireEvent.change(screen.getByLabelText("Submission"), { target: { value: "s1" } });
   fireEvent.change(screen.getByLabelText("Round"), { target: { value: "Initial Screening" } });
   fireEvent.change(await screen.findByLabelText("Find panel member"), { target: { value: "ajith" } });
   fireEvent.click(await screen.findByRole("button", { name: "Add Ajith Trainer" }));
   fireEvent.change(screen.getByLabelText("Find panel member"), { target: { value: "pawan" } });
   fireEvent.click(await screen.findByRole("button", { name: "Add Pawan Incharge" }));
   fireEvent.change(screen.getByRole("combobox", { name: "Lead user" }), { target: { value: "p2" } });
   fireEvent.change(screen.getByLabelText("Interview slot"), { target: { value: "2026-10-15T16:00" } });
   fireEvent.change(screen.getByRole("combobox", { name: "Duration (minutes)" }), { target: { value: "30" } });
   fireEvent.change(screen.getByLabelText("Meeting link"), { target: { value: "http://meet.example.com/x" } });
   fireEvent.click(screen.getByRole("button", { name: "Create interview" }));
   expect(await screen.findByRole("alert")).toHaveTextContent("must start with https://");
   fireEvent.change(screen.getByLabelText("Meeting link"), { target: { value: "https://meet.example.com/x" } });
   fireEvent.click(screen.getByRole("button", { name: "Create interview" }));
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
   fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
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
 it("offers no scorecard for location feedback", async () => {
   setup();
   await screen.findByText("Alex Doe");
   fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
   expect(within(screen.getByRole("dialog")).queryByLabelText("Technical skills")).not.toBeInTheDocument();
 });
});
