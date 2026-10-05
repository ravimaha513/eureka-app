import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, problem, wrap, type Handler } from "../pipeline/testkit";
import { CoursesPage } from "./CoursesPage";
import { MyTrainingPage } from "./MyTrainingPage";
import { TrainingsPage } from "./TrainingsPage";
import type { BatchDetail, BatchSummary, CourseDetail, StudentProgress } from "./lmsApi";

const B1: BatchSummary = { id: "b1", name: "Java Bootcamp 2026", year: 2026, startDate: "2026-09-01", endDate: "2026-12-15", status: "in_progress", studentCount: 2, courseCount: 1, createdByName: "HR One" };
const B2: BatchSummary = { id: "b2", name: "Sales Onboarding", year: 2026, startDate: "2027-01-05", endDate: "2027-02-05", status: "not_started", studentCount: 0, courseCount: 0, createdByName: null };
const C1 = { id: "c1", title: "Spring Basics", moduleCount: 2, totalMinutes: 90 };
const C2 = { id: "c2", title: "SQL Fundamentals", moduleCount: 1, totalMinutes: 45 };
const detail: BatchDetail = { ...B1, courses: [C1] };
const STUDENT: StudentProgress = {
  userId: "u1", name: "Asha Iyer", email: "asha@eureka.example", percent: 40,
  courses: [{ courseId: "c1", title: "Spring Basics", percent: 40, modules: [
    { moduleId: "m1", title: "Beans", durationMinutes: 60, percent: 60 }, { moduleId: "m2", title: "AOP", durationMinutes: 30, percent: 0 },
  ] }],
};
const course = (id: string, title: string): CourseDetail => ({
  id, title, description: "Intro", moduleCount: 2, totalMinutes: 90, archivedAt: null, version: 4,
  modules: [{ id: "m1", position: 0, title: "Beans", durationMinutes: 60 }, { id: "m2", position: 1, title: "AOP", durationMinutes: 30 }],
});

let api: ReturnType<typeof mockApi>;
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-03T12:00:00") }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const setup = (extra: Record<string, Handler> = {}) => {
  api = mockApi({
    "GET /api/v1/lms/batches": (url) => ({ body: { items: [B1, B2].filter((b) => !url.searchParams.get("status") || b.status === url.searchParams.get("status")) } }),
    "GET /api/v1/lms/batches/b1": () => ({ body: detail }),
    "GET /api/v1/lms/batches/b1/students": () => ({ body: { items: [STUDENT] } }),
    "GET /api/v1/lms/courses": () => ({ body: { items: [{ ...course("c1", "Spring Basics") }, { ...course("c2", "SQL Fundamentals"), moduleCount: 1, totalMinutes: 45 }] } }),
    "GET /api/v1/lms/courses/c1": () => ({ body: course("c1", "Spring Basics") }),
    ...extra,
  });
};

describe("Trainings", () => {
  it("lists batches as cards and filters by status", async () => {
    setup();
    wrap(<TrainingsPage />);
    const grid = await screen.findByRole("list", { name: "Training batches" });
    expect(within(grid).getAllByRole("listitem")).toHaveLength(2);
    expect(within(grid).getByText("In progress")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Not started" }));
    await waitFor(() => expect(api.gets("/api/v1/lms/batches").at(-1)!.url.searchParams.get("status")).toBe("not_started"));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Training batches" })).getAllByRole("listitem")).toHaveLength(1));
  });

  it("validates and creates a batch", async () => {
    setup({ "POST /api/v1/lms/batches": () => ({ status: 201, body: { ...B2, id: "b3", name: "New Batch" } }) });
    wrap(<TrainingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Training Batch" }));
    const dlg = await screen.findByRole("dialog", { name: "Add Training Batch" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add batch" }));
    expect(await within(dlg).findByText("Enter a batch name.")).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getByLabelText("Batch name")).toHaveFocus());
    fireEvent.change(within(dlg).getByLabelText("Batch name"), { target: { value: "New Batch" } });
    fireEvent.change(within(dlg).getByLabelText("Start date"), { target: { value: "2026-11-01" } });
    fireEvent.change(within(dlg).getByLabelText("End date"), { target: { value: "2026-10-01" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add batch" }));
    expect(await within(dlg).findByText(/can't be before the start/)).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("End date"), { target: { value: "2026-12-01" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add batch" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ name: "New Batch", startDate: "2026-11-01", endDate: "2026-12-01", year: 2026 });
    expect(await screen.findByText("Batch New Batch created.")).toBeInTheDocument();
  });
});

describe("Batch detail", () => {
  const open = async () => {
    wrap(<TrainingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Open batch Java Bootcamp 2026" }));
    await screen.findByRole("heading", { name: "Java Bootcamp 2026" });
  };

  it("shows header stats and expands a course's modules", async () => {
    setup();
    await open();
    expect(screen.getByText("Batch year").nextSibling).toHaveTextContent("2026");
    fireEvent.click(screen.getByRole("button", { name: /^Spring Basics/ }));
    expect(await screen.findByText("Beans")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "View Courses" })).toHaveAttribute("aria-selected", "true");
  });

  it("adds a course from the picker and removes one", async () => {
    setup({
      "PUT /api/v1/lms/batches/b1/courses": () => ({ body: detail }),
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add Course" }));
    const dlg = await screen.findByRole("dialog", { name: "Add Course" });
    expect(within(dlg).queryByLabelText(/Spring Basics/)).not.toBeInTheDocument();
    fireEvent.click(await within(dlg).findByLabelText(/SQL Fundamentals/));
    fireEvent.click(within(dlg).getByRole("button", { name: "Add courses" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ courseIds: ["c1", "c2"] });
    fireEvent.click(await screen.findByRole("button", { name: "Remove course Spring Basics" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove course" }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]!.body).toEqual({ courseIds: [] });
  });

  it("shows student progress per course and module, and removes a student", async () => {
    setup({ "DELETE /api/v1/lms/batches/b1/students/u1": () => ({ status: 204 }) });
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "View Students" }));
    expect(await screen.findByRole("progressbar", { name: "Asha Iyer overall progress" })).toHaveAttribute("aria-valuenow", "40");
    fireEvent.click(screen.getByRole("button", { name: /^Asha Iyer/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Spring Basics/ }));
    expect(await screen.findByRole("progressbar", { name: "Asha Iyer, Beans progress" })).toHaveAttribute("aria-valuenow", "60");
    fireEvent.click(screen.getByRole("button", { name: "Remove student Asha Iyer" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove student" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ method: "DELETE", path: "/api/v1/lms/batches/b1/students/u1" });
  });

  it("looks up people and adds the chosen students", async () => {
    setup({
      "GET /api/v1/lms/students/lookup": () => ({ body: { items: [{ userId: "u9", name: "Divya Menon", email: "divya@eureka.example" }] } }),
      "POST /api/v1/lms/batches/b1/students": () => ({ body: { added: 1 } }),
    });
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "View Students" }));
    await screen.findByText("Asha Iyer");
    fireEvent.click(screen.getByRole("button", { name: "Add Student" }));
    const dlg = await screen.findByRole("dialog", { name: "Add Student" });
    fireEvent.click(within(dlg).getByRole("button", { name: /^Add/ }));
    expect(await within(dlg).findByText("Choose at least one student.")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Find people by name or email"), { target: { value: "div" } });
    fireEvent.click(await within(dlg).findByLabelText(/Divya Menon/));
    fireEvent.click(within(dlg).getByRole("button", { name: "Add 1 student" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.gets("/api/v1/lms/students/lookup").at(-1)!.url.searchParams.get("q")).toBe("div");
    expect(api.writes()[0]!.body).toEqual({ userIds: ["u9"] });
    expect(await screen.findByText("1 student added.")).toBeInTheDocument();
  });

  it("explains a refused delete", async () => {
    setup({ "DELETE /api/v1/lms/batches/b1": () => problem(409, { detail: "batch_has_progress" }) });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete batch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Archive it instead");
  });
});

describe("Courses", () => {
  it("lists courses and creates one with ordered modules", async () => {
    setup({
      "POST /api/v1/lms/courses": () => ({ status: 201, body: { id: "c9", title: "Git", description: "", moduleCount: 0, totalMinutes: 0, archivedAt: null } }),
      "PUT /api/v1/lms/courses/c9/modules": () => ({ body: course("c9", "Git") }),
    });
    wrap(<CoursesPage />);
    const table = await screen.findByRole("table", { name: "Courses" });
    expect(within(table).getByText("SQL Fundamentals")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Course" }));
    const dlg = await screen.findByRole("dialog", { name: "Add course" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save course" }));
    expect(await within(dlg).findByText("Enter a course title.")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Title"), { target: { value: "Git" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add module" }));
    fireEvent.change(within(dlg).getByLabelText("Module 1 title"), { target: { value: "Branching" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add module" }));
    fireEvent.change(within(dlg).getByLabelText("Module 2 title"), { target: { value: "Rebasing" } });
    fireEvent.change(within(dlg).getByLabelText("Module 2 minutes"), { target: { value: "45" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Move module 2 up" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save course" }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[0]!.body).toEqual({ title: "Git" });
    expect(api.writes()[1]!.body).toEqual({ modules: [{ title: "Rebasing", durationMinutes: 45 }, { title: "Branching", durationMinutes: 30 }] });
    expect(await screen.findByText("Course Git created.")).toBeInTheDocument();
  });

  it("edits a course: title with If-Match, then the full module list keeping ids", async () => {
    setup({
      "PATCH /api/v1/lms/courses/c1": () => ({ body: course("c1", "Spring Core") }),
      "PUT /api/v1/lms/courses/c1/modules": () => ({ body: course("c1", "Spring Core") }),
    });
    wrap(<CoursesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit course Spring Basics" }));
    const dlg = await screen.findByRole("dialog", { name: "Edit course" });
    await waitFor(() => expect(within(dlg).getByLabelText("Module 2 title")).toHaveValue("AOP"));
    fireEvent.change(within(dlg).getByLabelText("Title"), { target: { value: "Spring Core" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove module 1" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save course" }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[0]!.headers["if-match"]).toBe('"4"');
    expect(api.writes()[1]!.body).toEqual({ modules: [{ id: "m2", title: "AOP", durationMinutes: 30 }] });
  });
});

describe("My Training", () => {
  const mine = { batchId: "b1", name: "Java Bootcamp 2026", startDate: "2026-09-01", endDate: "2026-12-15", status: "in_progress", percent: 30 };
  const myDetail = { ...mine, courses: [{ id: "c1", title: "Spring Basics", percent: 30, modules: [
    { moduleId: "m1", title: "Beans", durationMinutes: 60, percent: 50, completedAt: null },
    { moduleId: "m2", title: "AOP", durationMinutes: 30, percent: 100, completedAt: "2026-09-20T10:00:00Z" },
  ] }] };
  const routes = (): Record<string, Handler> => ({
    "GET /api/v1/lms/me/trainings": () => ({ body: { items: [{ ...mine, courseCount: 1 }] } }),
    "GET /api/v1/lms/me/trainings/b1": () => ({ body: myDetail }),
    "PUT /api/v1/lms/me/trainings/b1/progress/m1": (_u, b) => ({ body: b }),
  });

  it("lists own batches and sets a module's progress", async () => {
    api = mockApi(routes());
    wrap(<MyTrainingPage />);
    expect(await screen.findByRole("progressbar", { name: "Java Bootcamp 2026 progress" })).toHaveAttribute("aria-valuenow", "30");
    fireEvent.click(screen.getByRole("button", { name: "Open Java Bootcamp 2026" }));
    const input = await screen.findByLabelText("Percent complete for Beans");
    fireEvent.change(input, { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: "Set progress for Beans" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ percent: 75 });
    expect(await screen.findByText("Saved 75%.")).toBeInTheDocument();
  });

  it("marks a module complete; a finished module has the button disabled; bad input is refused", async () => {
    api = mockApi(routes());
    wrap(<MyTrainingPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Java Bootcamp 2026" }));
    expect(await screen.findByRole("button", { name: "Mark AOP complete" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Percent complete for Beans"), { target: { value: "140" } });
    fireEvent.click(screen.getByRole("button", { name: "Set progress for Beans" }));
    expect(await screen.findByText("Enter a whole number from 0 to 100.")).toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Mark Beans complete" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ percent: 100 });
  });

  it("explains a failed load", async () => {
    api = mockApi({ "GET /api/v1/lms/me/trainings": () => problem(403) });
    wrap(<MyTrainingPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("permission");
  });
});
