import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meFor, mockApi, problem, wrap, type Handler } from "../pipeline/testkit";
import { visibleNav } from "../nav";
import type { Me } from "../api";
import { TrainingPage } from "./TrainingPage";
import { CoursesPage } from "./CoursesPage";
import { CandidateTraining } from "./CandidateTraining";
import type { BatchCard, BatchDetail, CourseDetail, CourseSummary, Student } from "./trainingApi";

const LOC = { ...meFor("location_ops_admin"), roles: [{ key: "location_ops_admin", label: "Location Ops Admin", locationId: null }] };
const COACH = meFor("interview_coach");

const CARD: BatchCard = {
  id: "b1", name: ".NET 2026", customName: ".NET 2026", status: "planned", cover: { color: "violet", icon: "users" },
  location: { id: "l1", name: "Dallas" }, technology: { id: "t1", name: ".NET" }, trainer: { id: "u-c", name: "Coach One" },
  startMonth: "2026-09", startDate: "2026-09-30", startDateSet: true, endDate: "2027-06-30", batchYear: 2026, sizePlanned: 20,
  students: 1, courses: 1, rowVersion: 3, actions: { manage: true, delete: false, updateProgress: true },
};
const EMPTY: BatchCard = { ...CARD, id: "b2", name: "Java Oct 2026", customName: null, status: "in_training", students: 0, trainer: null,
  actions: { manage: true, delete: true, updateProgress: true } };
const DETAIL: BatchDetail = {
  ...CARD,
  assignedCourses: [{
    id: "c1", title: "Database", description: null, cover: { color: "teal", icon: "database" }, archived: false, totalMinutes: 240,
    modules: [{ id: "m1", title: "SQL basics", durationMinutes: 60, resources: ["https://example.com/sql"] }, { id: "m2", title: "Indexes", durationMinutes: 180, resources: [] }],
  }],
};
const STUDENT: Student = {
  candidateId: "s1", name: "Asha Iyer", technology: ".NET", status: "in_training", percent: 25, completedMinutes: 60, totalMinutes: 240,
  courses: [{ courseId: "c1", percent: 25, completedModules: 1, totalModules: 2 }],
  completions: [{ moduleId: "m1", completedAt: "2026-10-01T10:00:00Z", completedBy: { id: "u-c", name: "Coach One" } }],
};

let api: ReturnType<typeof mockApi>;
const base = (): Record<string, Handler> => ({
  "GET /api/v1/training/batches": () => ({ body: { items: [CARD, EMPTY], nextCursor: null, canCreate: true } }),
  "GET /api/v1/training/batches/b1": () => ({ body: DETAIL }),
  "GET /api/v1/training/batches/b1/students": () => ({ body: { items: [STUDENT], nextCursor: null } }),
  "PUT /api/v1/training/batches/b1/students/s1/modules/m2": (_u, body) => ({ body: { moduleId: "m2", ...(body as object), completedAt: "2026-10-05T10:00:00Z" } }),
  "DELETE /api/v1/training/batches/b2": () => ({ status: 204 }),
  "POST /api/v1/training/batches": () => ({ status: 201, body: { id: "b1" } }),
  "GET /api/v1/training/trainers": () => ({ body: { items: [{ id: "u-c", name: "Coach One" }] } }),
  "GET /api/v1/lookups": () => ({ body: { technologies: [{ id: "t1", name: ".NET" }], locations: [{ id: "l1", name: "Dallas" }], clients: [], vendors: [], implementationPartners: [], coaches: [] } }),
});
beforeEach(() => { api = mockApi(base()); });
afterEach(() => vi.restoreAllMocks());

describe("navigation", () => {
  it("Training Batches for training:read holders; Courses for managers only", () => {
    const keys = (m: Me) => visibleNav(m.capabilities).map((n) => n.key);
    expect(keys(LOC)).toEqual(expect.arrayContaining(["training", "courses"]));
    expect(keys(meFor("recruiter"))).toContain("training");
    expect(keys(meFor("recruiter"))).not.toContain("courses");
    expect(keys(meFor("hr"))).not.toContain("training");
  });
});

describe("Training Batches", () => {
  it("shows cards with status, trainer, counts and dates; filters by status", async () => {
    wrap(<TrainingPage me={LOC} />);
    const list = await screen.findByRole("list", { name: "Training batches" });
    const card = within(list).getByRole("heading", { name: ".NET 2026" }).closest("li")!;
    expect(within(card).getByText("Not started")).toHaveClass("badge", "tr-planned");
    expect(within(card).getByText("by Coach One")).toBeInTheDocument();
    expect(within(card).getByText("Students").previousSibling).toHaveTextContent("1");
    expect(within(card).queryByRole("button", { name: "Delete .NET 2026" })).not.toBeInTheDocument();
    const other = within(list).getByRole("heading", { name: "Java Oct 2026" }).closest("li")!;
    expect(within(other).getByText("No trainer yet")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "completed" } });
    await waitFor(() => expect(api.gets("/api/v1/training/batches").at(-1)!.url.searchParams.get("status")).toBe("completed"));
  });

  it("deletes an empty batch after confirmation", async () => {
    wrap(<TrainingPage me={LOC} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Java Oct 2026" }));
    const dlg = screen.getByRole("dialog", { name: "Delete Java Oct 2026?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Delete batch" }));
    await waitFor(() => expect(api.writes().map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /api/v1/training/batches/b2"]));
    expect(await screen.findByText("Java Oct 2026 deleted.")).toBeInTheDocument();
  });

  it("hides Add for readers; validates and creates a batch for managers", async () => {
    api.routes["GET /api/v1/training/batches"] = () => ({ body: { items: [], nextCursor: null, canCreate: false } });
    const { unmount } = wrap(<TrainingPage me={COACH} />);
    await screen.findByText("No training batches to show yet.");
    expect(screen.queryByRole("button", { name: "Add training batch" })).not.toBeInTheDocument();
    unmount();
    api.routes["GET /api/v1/training/batches"] = () => ({ body: { items: [], nextCursor: null, canCreate: true } });
    wrap(<TrainingPage me={LOC} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add training batch" }));
    const dlg = screen.getByRole("dialog", { name: "Add training batch" });
    await within(dlg).findByRole("option", { name: "Coach One" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create batch" }));
    expect(await within(dlg).findByText("Choose the first day of training.")).toBeInTheDocument();
    expect(api.writes()).toEqual([]);
    fireEvent.change(within(dlg).getByRole("textbox", { name: /Batch name/ }), { target: { value: ".NET 2026" } });
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Location" }), { target: { value: "l1" } });
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Technology" }), { target: { value: "t1" } });
    fireEvent.change(within(dlg).getByLabelText("Start date"), { target: { value: "2026-09-30" } });
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Trainer" }), { target: { value: "u-c" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create batch" }));
    await waitFor(() => expect(api.writes()[0]?.body).toEqual({
      name: ".NET 2026", locationId: "l1", technologyId: "t1", startDate: "2026-09-30", endDate: null, trainerId: "u-c",
      sizePlanned: null, coverColor: "indigo", coverIcon: "users",
    }));
    // Opens the new batch.
    expect(await screen.findByRole("heading", { level: 1, name: ".NET 2026" })).toBeInTheDocument();
  });
});

describe("batch detail", () => {
  const open = async () => {
    wrap(<TrainingPage me={LOC} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open .NET 2026" }));
    return screen.findByRole("heading", { level: 1, name: ".NET 2026" });
  };

  it("shows the header stats and the course accordion with modules", async () => {
    await open();
    const stats = screen.getByRole("list", { name: "Batch figures" });
    expect(within(stats).getByText("Batch year").previousSibling).toHaveTextContent("2026");
    expect(screen.getByRole("tab", { name: /View Courses/ })).toHaveAttribute("aria-selected", "true");
    const toggle = screen.getByRole("button", { name: /^Database/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(toggle).getByText("2 modules · 4h")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("SQL basics")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Resource 1 for SQL basics/ })).toHaveAttribute("href", "https://example.com/sql");
  });

  it("lists students with progress; a trainer ticks a module", async () => {
    await open();
    fireEvent.click(screen.getByRole("tab", { name: /View Students/ }));
    const bar = await screen.findByRole("progressbar", { name: "Overall progress of Asha Iyer" });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    fireEvent.click(screen.getByRole("button", { name: /^Asha Iyer/ }));
    expect(screen.getByRole("progressbar", { name: "Database progress of Asha Iyer" })).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByRole("checkbox", { name: /SQL basics/ })).toBeChecked();
    expect(screen.getByText(/Completed .* by Coach One/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Indexes/ }));
    await waitFor(() => expect(api.writes().map((c) => [c.path, c.body])).toEqual([
      ["/api/v1/training/batches/b1/students/s1/modules/m2", { completed: true }],
    ]));
    expect(await screen.findByText("Indexes marked complete for Asha Iyer.")).toBeInTheDocument();
  });

  it("explains a refused change in plain language", async () => {
    api.routes["PUT /api/v1/training/batches/b1/students/s1/modules/m2"] = () => problem(422, { detail: "batch_closed" });
    await open();
    fireEvent.click(screen.getByRole("tab", { name: /View Students/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Asha Iyer/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Indexes/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This batch is completed or cancelled; it can't be changed.");
  });
});

describe("course library", () => {
  const SUMMARY: CourseSummary = {
    id: "c1", title: "Database", description: null, cover: { color: "teal", icon: "database" }, archived: false,
    location: { id: "l1", name: "Dallas" }, modules: 2, totalMinutes: 240, batches: 1, rowVersion: 1, canEdit: true,
  };
  const COURSE: CourseDetail = {
    ...SUMMARY, totalMinutes: 240,
    modules: [
      { id: "m1", position: 1, title: "SQL basics", durationMinutes: 60, resources: [], rowVersion: 1 },
      { id: "m2", position: 2, title: "Indexes", durationMinutes: 180, resources: [], rowVersion: 1 },
    ],
  };
  beforeEach(() => {
    api.routes["GET /api/v1/training/courses"] = () => ({ body: { items: [SUMMARY], nextCursor: null, canCreate: true } });
    api.routes["GET /api/v1/training/courses/c1"] = () => ({ body: COURSE });
    api.routes["PUT /api/v1/training/courses/c1/modules/order"] = () => ({ body: {} });
    api.routes["POST /api/v1/training/courses/c1/modules"] = () => ({ status: 201, body: { id: "m3" } });
  });

  it("opens a course, reorders modules and validates new modules", async () => {
    wrap(<CoursesPage me={LOC} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open course Database" }));
    const drawer = await screen.findByRole("dialog", { name: "Database" });
    fireEvent.click(await within(drawer).findByRole("button", { name: "Move Indexes up" }));
    await waitFor(() => expect(api.writes()[0]?.body).toEqual({ moduleIds: ["m2", "m1"] }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Add module" }));
    const dlg = screen.getByRole("dialog", { name: "Add module" });
    fireEvent.change(within(dlg).getByRole("textbox", { name: "Module title" }), { target: { value: "Joins" } });
    fireEvent.change(within(dlg).getByRole("spinbutton", { name: "Duration (minutes)" }), { target: { value: "90" } });
    fireEvent.change(within(dlg).getByRole("textbox", { name: /Resource links/ }), { target: { value: "http://example.com" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add module" }));
    expect(await within(dlg).findByText("Each link must start with https://.")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByRole("textbox", { name: /Resource links/ }), { target: { value: "https://example.com/joins" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add module" }));
    await waitFor(() => expect(api.writes().at(-1)?.body).toEqual({ title: "Joins", durationMinutes: 90, resources: ["https://example.com/joins"] }));
  });
});

describe("profile card", () => {
  it("shows overall and per-course progress", async () => {
    api.routes["GET /api/v1/candidates/c9/training"] = () => ({ body: {
      batch: { id: "b1", name: ".NET 2026", status: "in_training", startDate: "2026-09-30", endDate: null },
      percent: 40, completedMinutes: 96, totalMinutes: 240, courses: [{ id: "c1", title: "Database", percent: 40, completedModules: 1, totalModules: 2 }],
    } });
    wrap(<CandidateTraining candidateId="c9" />);
    expect(await screen.findByRole("progressbar", { name: "Overall training progress" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("In training")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Database progress" })).toHaveAttribute("aria-valuenow", "40");
  });

  it("stays hidden when the caller's scope does not cover the candidate", async () => {
    api.routes["GET /api/v1/candidates/c9/training"] = () => problem(403, { detail: "Not permitted" });
    const { container } = wrap(<CandidateTraining candidateId="c9" />);
    await waitFor(() => expect(api.gets("/api/v1/candidates/c9/training").length).toBe(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
