import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meFor, mockApi, problem, wrap } from "../pipeline/testkit";
import { LogSubmissionDialog } from "../sales/LogSubmissionDialog";
import { JobsPage } from "./JobsPage";
import { RichTextView, domToRich, richToDom } from "./RichText";
import type { Job } from "./jobsApi";

const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id, kind: "client_requirement", title: "Java Developer", category: "engineering", experienceLevel: "senior",
  employmentType: "contract", workMode: "hybrid", status: "open", deadline: "2026-12-30", workHours: 40,
  pay: null, payHidden: true, client: { id: "cl1", name: "Northwind Financial" }, company: null, location: "Dallas, TX",
  skills: ["Java"], requirements: { blocks: [{ type: "p", runs: [{ text: "Five years of Java" }] }] }, description: null,
  hiringManager: { id: "u2", name: "Smith Jason" }, publishedToPortal: false, owner: { id: "u1", name: "Lead" }, team: null,
  applicants: 2, createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z", postedAt: "2026-10-01T10:00:00Z",
  rowVersion: 3, actions: { edit: true }, ...extra,
});
const J1 = job("j1");
const J2 = job("j2", { kind: "internal_opening", title: "HR Generalist", client: null, publishedToPortal: true, actions: { edit: false }, applicants: 0 });

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/v1/jobs": () => ({ body: { items: [J1, J2], nextCursor: null } }),
    "GET /api/v1/jobs/j1": () => ({ body: J1 }),
    "GET /api/v1/jobs/options": () => ({ body: { kinds: ["client_requirement"], clients: [{ id: "cl1", name: "Northwind Financial" }], companies: [], staff: [{ id: "u2", name: "Smith Jason" }] } }),
    "POST /api/v1/jobs": () => ({ status: 201, body: { id: "j9", rowVersion: 1 } }),
    "PATCH /api/v1/jobs/j1": () => ({ body: { ...J1, rowVersion: 4 } }),
  });
});
afterEach(() => vi.restoreAllMocks());

const rowOf = async (title: string) => (await screen.findByText(title, { selector: "b" })).closest("tr")!;

describe("Jobs page", () => {
  it("lists jobs with employer, hiring manager, applicants and status; edit only where allowed", async () => {
    wrap(<JobsPage me={meFor("lead")} />);
    const r1 = await rowOf("Java Developer");
    expect(within(r1).getByText("Northwind Financial")).toBeInTheDocument();
    expect(within(r1).getByText("Smith Jason")).toBeInTheDocument();
    expect(within(r1).getByText("Open")).toHaveClass("badge", "job-open");
    expect(within(r1).getByRole("button", { name: "Edit job Java Developer" })).toBeInTheDocument();
    const r2 = await rowOf("HR Generalist");
    expect(within(r2).getByText(/on careers portal/)).toBeInTheDocument();
    expect(within(r2).queryByRole("button", { name: /Edit job/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Add job/ })).toBeInTheDocument();
  });

  it("hides Add job without job:manage and filters by type and status", async () => {
    wrap(<JobsPage me={meFor("recruiter")} />);
    await rowOf("Java Developer");
    expect(screen.queryByRole("button", { name: /Add job/ })).toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Closed" }));
    await waitFor(() => expect(api.gets("/api/v1/jobs").at(-1)!.url.searchParams.get("status")).toBe("closed"));
    fireEvent.click(within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Internal opening" }));
    await waitFor(() => expect(api.gets("/api/v1/jobs").at(-1)!.url.searchParams.get("kind")).toBe("internal_opening"));
  });

  it("creates a client requirement with an idempotency key and validates first", async () => {
    wrap(<JobsPage me={meFor("lead")} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add job/ }));
    const dlg = await screen.findByRole("dialog", { name: "Create job" });
    const client = within(dlg).getByRole("combobox", { name: "Client" });
    await waitFor(() => expect(client).not.toBeDisabled());
    fireEvent.click(within(dlg).getByRole("button", { name: "Create job" }));
    expect(await within(dlg).findByText("Enter the job title.")).toBeInTheDocument();
    expect(within(dlg).getByText("Choose the client.")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Job title"), { target: { value: "  Spring Developer " } });
    fireEvent.change(client, { target: { value: "cl1" } });
    const skills = within(dlg).getByLabelText("Skills");
    fireEvent.change(skills, { target: { value: "Spring" } });
    fireEvent.keyDown(skills, { key: "Enter" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create job" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    const w = api.writes()[0]!;
    expect(w.body).toMatchObject({ kind: "client_requirement", title: "Spring Developer", clientId: "cl1", skills: ["Spring"], publishedToPortal: false, companyId: null });
    expect(w.headers["idempotency-key"]).toMatch(/^job-/);
    expect(await screen.findByText("Job created.")).toBeInTheDocument();
  });

  it("edits with If-Match and explains a stale version", async () => {
    api.routes["PATCH /api/v1/jobs/j1"] = () => problem(412, { detail: "stale" });
    wrap(<JobsPage me={meFor("lead")} />);
    fireEvent.click(within(await rowOf("Java Developer")).getByRole("button", { name: "Edit job Java Developer" }));
    const dlg = await screen.findByRole("dialog", { name: /Edit job/ });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save changes" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/Someone else changed this job/);
    expect(api.writes()[0]!.headers["if-match"]).toBe('"3"');
  });

  it("shows details with requirements rendered as text", async () => {
    wrap(<JobsPage me={meFor("lead")} />);
    fireEvent.click(within(await rowOf("Java Developer")).getByRole("button", { name: "View job Java Developer" }));
    const d = await screen.findByRole("dialog", { name: "Java Developer" });
    expect(within(d).getByText("Five years of Java")).toBeInTheDocument();
    expect(within(d).getByText("Hidden (rate)")).toBeInTheDocument();
  });
});

describe("rich text", () => {
  it("keeps only the allow-list when reading the editor's DOM", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>Hello <b>bold</b> <span style="color:red">x</span><script>alert(1)</script></p>`
      + `<ul><li><i>one</i></li><li><a href="javascript:alert(1)">bad</a> <a href="https://ok.example/">good</a></li></ul>`
      + `<img src=x onerror=alert(1)>loose`;
    expect(domToRich(root)).toEqual({ blocks: [
      { type: "p", runs: [{ text: "Hello " }, { text: "bold", marks: ["b"] }, { text: " x" }] },
      { type: "ul", items: [[{ text: "one", marks: ["i"] }], [{ text: "bad " }, { text: "good", href: "https://ok.example/" }]] },
      { type: "p", runs: [{ text: "loose" }] },
    ] });
  });

  it("round-trips through the editor DOM without HTML parsing", () => {
    const doc = { blocks: [{ type: "p" as const, runs: [{ text: "<b>not bold</b>", marks: ["u" as const] }] }, { type: "ol" as const, items: [[{ text: "a" }]] }] };
    const root = document.createElement("div");
    richToDom(doc, root);
    expect(root.querySelector("b")).toBeNull();
    expect(domToRich(root)).toEqual(doc);
  });

  it("renders text as text and drops non-https links", () => {
    const { container } = render(<RichTextView doc={{ blocks: [{ type: "p", runs: [
      { text: "<img src=x onerror=alert(1)>" }, { text: "site", href: "http://insecure.example" }, { text: "ok", href: "https://ok.example" },
    ] }] }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "ok" })).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });
});

describe("Log submission job picker", () => {
  it("fills title and client from an open client requirement and sends jobId", async () => {
    const CL = "11111111-1111-4111-8111-111111111111";
    api.routes["GET /api/v1/jobs"] = () => ({ body: { items: [job("j1", { client: { id: CL, name: "Northwind Financial" } })], nextCursor: null } });
    api.routes["GET /api/v1/lookups"] = () => ({ body: { technologies: [], clients: [{ id: CL, name: "Northwind Financial" }], vendors: [], implementationPartners: [], locations: [], coaches: [] } });
    api.routes["POST /api/v1/submissions"] = () => ({ status: 201, body: { id: "s1", duplicateWarning: false } });
    const onLogged = vi.fn();
    wrap(<LogSubmissionDialog candidate={{ id: "c1", name: "Asha" }} onClose={() => undefined} onLogged={onLogged} />);
    const picker = await screen.findByRole("combobox", { name: "Job (optional)" });
    fireEvent.change(picker, { target: { value: "j1" } });
    expect(screen.getByLabelText("Job title")).toHaveValue("Java Developer");
    fireEvent.click(screen.getByRole("button", { name: "Log submission" }));
    await waitFor(() => expect(onLogged).toHaveBeenCalled());
    expect(api.writes()[0]!.body).toMatchObject({ candidateId: "c1", clientId: CL, jobTitle: "Java Developer", jobId: "j1" });
  });
});
