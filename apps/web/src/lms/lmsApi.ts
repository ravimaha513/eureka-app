/** Typed client for the LMS (training) API (docs/lms-api.md). */
import { ApiError, api } from "../api";

export const BATCH_STATUSES = ["not_started", "in_progress", "completed"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export interface CourseSummary {
  id: string; title: string; description: string; moduleCount: number; totalMinutes: number; archivedAt: string | null;
  /** Row version for If-Match, when the server sends it. */
  version?: number;
}
export interface CourseModule { id: string; position: number; title: string; durationMinutes: number }
export interface CourseDetail extends CourseSummary { modules: CourseModule[] }

export interface BatchSummary {
  id: string; name: string; year: number; startDate: string; endDate: string; status: BatchStatus;
  studentCount: number; courseCount: number; createdByName: string | null;
}
export interface BatchCourse { id: string; title: string; moduleCount: number; totalMinutes: number }
export interface BatchDetail extends BatchSummary { courses: BatchCourse[]; archivedAt?: string | null }

export interface ModuleProgress { moduleId: string; title: string; durationMinutes: number; percent: number }
export interface CourseProgress { courseId: string; title: string; percent: number; modules: ModuleProgress[] }
export interface StudentProgress { userId: string; name: string; email: string; percent: number; courses: CourseProgress[] }
export interface LookupUser { userId: string; name: string; email: string }

export interface MyTraining {
  batchId: string; name: string; startDate: string; endDate: string; status: BatchStatus; percent: number; courseCount: number;
}
export interface MyModule { moduleId: string; title: string; durationMinutes: number; percent: number; completedAt: string | null }
export interface MyCourse { id: string; title: string; percent: number; modules: MyModule[] }
export interface MyTrainingDetail extends Omit<MyTraining, "courseCount"> { courses: MyCourse[] }

const BASE = "/api/v1/lms";
const enc = encodeURIComponent;
const qs = (f: object) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};
const body = (b: unknown) => ({ body: JSON.stringify(b) });

export const lmsApi = {
  courses: (f: { q?: string; archived?: boolean } = {}) => api<{ items: CourseSummary[] }>(`${BASE}/courses${qs({ q: f.q, archived: f.archived ? "true" : undefined })}`),
  course: (id: string) => api<CourseDetail>(`${BASE}/courses/${enc(id)}`),
  createCourse: (b: { title: string; description?: string }) => api<CourseSummary>(`${BASE}/courses`, { method: "POST", ...body(b) }),
  updateCourse: (id: string, b: { title?: string; description?: string; archived?: boolean }, version?: number) =>
    api<CourseSummary>(`${BASE}/courses/${enc(id)}`, { method: "PATCH", ...body(b), ...(version !== undefined ? { headers: { "if-match": `"${version}"` } } : {}) }),
  setModules: (id: string, modules: { id?: string; title: string; durationMinutes: number }[]) =>
    api<CourseDetail>(`${BASE}/courses/${enc(id)}/modules`, { method: "PUT", ...body({ modules }) }),

  batches: (f: { status?: string; q?: string } = {}) => api<{ items: BatchSummary[] }>(`${BASE}/batches${qs({ limit: 100, ...f })}`),
  batch: (id: string) => api<BatchDetail>(`${BASE}/batches/${enc(id)}`),
  createBatch: (b: { name: string; startDate: string; endDate: string; year?: number }) => api<BatchSummary>(`${BASE}/batches`, { method: "POST", ...body(b) }),
  updateBatch: (id: string, b: { name?: string; startDate?: string; endDate?: string; archived?: boolean }) =>
    api<BatchDetail>(`${BASE}/batches/${enc(id)}`, { method: "PATCH", ...body(b) }),
  deleteBatch: (id: string) => api<void>(`${BASE}/batches/${enc(id)}`, { method: "DELETE" }),
  setBatchCourses: (id: string, courseIds: string[]) => api<BatchDetail>(`${BASE}/batches/${enc(id)}/courses`, { method: "PUT", ...body({ courseIds }) }),
  students: (id: string, q = "") => api<{ items: StudentProgress[] }>(`${BASE}/batches/${enc(id)}/students${qs({ q, limit: 100 })}`),
  addStudents: (id: string, userIds: string[]) => api<{ added: number }>(`${BASE}/batches/${enc(id)}/students`, { method: "POST", ...body({ userIds }) }),
  removeStudent: (id: string, userId: string) => api<void>(`${BASE}/batches/${enc(id)}/students/${enc(userId)}`, { method: "DELETE" }),
  lookupStudents: (q: string) => api<{ items: LookupUser[] }>(`${BASE}/students/lookup${qs({ q })}`),

  myTrainings: () => api<{ items: MyTraining[] }>(`${BASE}/me/trainings`),
  myTraining: (batchId: string) => api<MyTrainingDetail>(`${BASE}/me/trainings/${enc(batchId)}`),
  setMyProgress: (batchId: string, moduleId: string, percent: number) =>
    api<unknown>(`${BASE}/me/trainings/${enc(batchId)}/progress/${enc(moduleId)}`, { method: "PUT", ...body({ percent }) }),
};

export const lmsKeys = {
  all: ["lms"] as const,
  courses: (f?: object) => ["lms", "courses", f ?? {}] as const,
  batches: (f?: object) => ["lms", "batches", f ?? {}] as const,
  batch: (id: string) => ["lms", "batch", id] as const,
  students: (id: string, q: string) => ["lms", "batch", id, "students", q] as const,
  mine: ["lms", "me"] as const,
  myBatch: (id: string) => ["lms", "me", id] as const,
};

export const statusLabel = (s: string) => ({ not_started: "Not started", in_progress: "In progress", completed: "Completed" })[s] ?? s;

export const fmtMinutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);

const ERRORS: Record<string, string> = {
  batch_has_progress: "This batch already has student progress, so it can't be deleted. Archive it instead.",
  student_not_found: "One of those people isn't an active user any more.",
  course_not_in_batch: "That course isn't part of this batch.",
  course_archived: "An archived course can't be added to a batch.",
};

export function lmsError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && ERRORS[e.detail]) return ERRORS[e.detail]!;
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return "You don't have permission to do that.";
    case 404: return "This record doesn't exist or you can't see it.";
    case 409: return e.detail ?? "That conflicts with the current state. Refresh and try again.";
    case 412: return "Someone else changed this first. Close and reopen it to see the latest.";
    case 400: case 422: return e.errors?.length ? e.errors.map((x) => x.message).join(" ") : "The server rejected this. Check the values and try again.";
    default: return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
  }
}

export const localYear = () => new Date().getFullYear();
