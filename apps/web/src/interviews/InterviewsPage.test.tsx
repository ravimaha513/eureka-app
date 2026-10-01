import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewsPage, dateBoundary, type Interview } from "./InterviewsPage";
import type { Me } from "../api";
const me: Me = { id: "u", email: "a@example.com", displayName: "Recruiter", roles: [], capabilities: ["interview:read", "interview:create"], csrfToken: "t" };
const row: Interview = { id: "i1", submissionId: "s1", candidate: { id: "c", name: "Alex Doe" }, recruiter: { id: "u", name: "Recruiter" }, team: null, location: null, client: null, round: "Technical", startsAt: "2026-10-01T14:00:00Z", endsAt: "2026-10-01T15:00:00Z", coach: null, inviteReceived: false, callStatus: "scheduled", cleared: false, consentCaptured: false, otterUrl: "https://example.com/secret", recordingUrl: null, systemName: null, editableFields: ["cleared", "consentCaptured", "systemName", "callStatus"], feedbackKinds: ["location"] };
const json = (value: unknown) => new Response(JSON.stringify(value));
const lookups = (locations: { id: string; name: string }[]) => ({ technologies: [], clients: [], vendors: [], implementationPartners: [], coaches: [], locations });
function setup(item = row, capabilities = me.capabilities, locations = [{ id: "dal", name: "Dallas" }]) {
 const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
   const path = String(url);
   if (path.includes("/lookups")) return json(lookups(locations));
   if (path.includes("/feedback")) return json({ items: [] });
   if (path.includes("/coaches")) return json({ items: [{ id: "coach", name: "Coach One" }] });
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
   fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-10-01T10:00" } });
   fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-10-01T11:00" } });
   await screen.findByRole("option", { name: "Coach One" });
   fireEvent.change(screen.getByLabelText("Coach"), { target: { value: "coach" } });
   fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
   await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/interviews", expect.objectContaining({ method: "POST", body: JSON.stringify({ submissionId: "s1", round: "Technical", startsAt: new Date("2026-10-01T10:00").toISOString(), endsAt: new Date("2026-10-01T11:00").toISOString(), coachId: "coach", inviteReceived: false }) })));
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
});
