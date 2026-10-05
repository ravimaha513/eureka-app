/** Typed client for training batches, courses and progress (docs/training-api.md, migration 0065). */
import { ApiError, api } from "../api";

export interface Ref { id: string; name: string | null }
export interface Cover { color: string; icon: string }

export const BATCH_STATUSES = ["planned", "in_training", "completed", "cancelled"] as const;
export const BATCH_STATUS_LABELS: Record<string, string> = {
  planned: "Not started", in_training: "In training", completed: "Completed", cancelled: "Cancelled",
};
/** Allowed status changes (mirrors authz.set_batch_status). */
export const NEXT_STATUS: Record<string, { to: string; label: string }[]> = {
  planned: [{ to: "in_training", label: "Start training" }, { to: "cancelled", label: "Cancel batch" }],
  in_training: [{ to: "completed", label: "Mark completed" }, { to: "cancelled", label: "Cancel batch" }],
};
export const COVER_COLORS = ["indigo", "teal", "amber", "rose", "violet", "sky"] as const;
export const COVER_ICONS = ["book", "code", "database", "cloud", "shield", "chart", "users", "cap"] as const;
export const ICON_LABELS: Record<string, string> = {
  book: "Book", code: "Code", database: "Database", cloud: "Cloud", shield: "Shield", chart: "Chart", users: "People", cap: "Graduation cap",
};

export interface BatchCard {
  id: string;
  name: string;
  customName: string | null;
  status: string;
  cover: Cover;
  location: Ref;
  technology: Ref;
  trainer: Ref | null;
  startMonth: string;
  startDate: string;
  startDateSet: boolean;
  endDate: string | null;
  batchYear: number;
  sizePlanned: number | null;
  students: number;
  courses: number;
  rowVersion: number;
  actions: { manage: boolean; delete: boolean; updateProgress: boolean };
}

export interface Module { id: string; title: string; durationMinutes: number; resources: string[] }
export interface AssignedCourse {
  id: string; title: string; description: string | null; cover: Cover; archived: boolean; totalMinutes: number; modules: Module[];
}
export interface BatchDetail extends BatchCard { assignedCourses: AssignedCourse[] }

export interface Completion { moduleId: string; completedAt: string; completedBy: Ref }
export interface Student {
  candidateId: string;
  name: string;
  technology: string;
  status: string;
  percent: number;
  completedMinutes: number;
  totalMinutes: number;
  courses: { courseId: string; percent: number; completedModules: number; totalModules: number }[];
  completions: Completion[];
}
export interface EligibleStudent { candidateId: string; name: string; technology: string; status: string; currentBatch: { id: string; name: string } | null }

export interface CourseSummary {
  id: string; title: string; description: string | null; cover: Cover; archived: boolean; location: Ref;
  modules: number; totalMinutes: number; batches: number; rowVersion: number; canEdit: boolean;
}
export interface CourseModule extends Module { position: number; rowVersion: number }
export interface CourseDetail {
  id: string; title: string; description: string | null; cover: Cover; archived: boolean; location: Ref;
  rowVersion: number; totalMinutes: number; modules: CourseModule[]; canEdit: boolean;
}

export interface CandidateTraining {
  batch: { id: string; name: string; status: string; startDate: string; endDate: string | null } | null;
  percent?: number;
  completedMinutes?: number;
  totalMinutes?: number;
  courses?: { id: string; title: string; percent: number; completedModules: number; totalModules: number }[];
}

export interface NewBatch {
  locationId: string; technologyId: string; startDate: string; endDate?: string | null; name?: string | null;
  trainerId?: string | null; sizePlanned?: number | null; coverColor?: string; coverIcon?: string;
}
export type BatchPatch = Partial<Omit<NewBatch, "locationId" | "technologyId">>;
export interface NewModule { title: string; durationMinutes: number; resources?: string[] }
export interface NewCourse { title: string; description?: string | null; coverColor?: string; coverIcon?: string; locationId?: string; modules?: NewModule[] }

const json = (method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers });
const B = "/api/v1/training/batches";
const C = "/api/v1/training/courses";
const ifMatch = (v: number) => ({ "if-match": `"${v}"` });

export const trainingKeys = {
  all: ["training"] as const,
  batches: (status: string) => ["training", "batches", status] as const,
  batch: (id: string) => ["training", "batch", id] as const,
  students: (id: string, search: string) => ["training", "students", id, search] as const,
  courses: (archived: boolean) => ["training", "courses", archived] as const,
  course: (id: string) => ["training", "course", id] as const,
  candidate: (id: string) => ["training", "candidate", id] as const,
};

export const trainingApi = {
  batches: (status: string) =>
    api<{ items: BatchCard[]; nextCursor: string | null; canCreate: boolean }>(`${B}?limit=100${status ? `&status=${status}` : ""}`),
  batch: (id: string) => api<BatchDetail>(`${B}/${id}`),
  createBatch: (b: NewBatch) => api<{ id: string }>(B, json("POST", b)),
  updateBatch: (id: string, version: number, b: BatchPatch) => api<{ id: string; rowVersion: number }>(`${B}/${id}`, json("PATCH", b, ifMatch(version))),
  setStatus: (id: string, to: string) => api<{ status: string }>(`${B}/${id}/status`, json("PUT", { to })),
  deleteBatch: (id: string) => api<void>(`${B}/${id}`, json("DELETE")),
  addCourse: (id: string, courseId: string) => api(`${B}/${id}/courses`, json("POST", { courseId })),
  removeCourse: (id: string, courseId: string) => api<void>(`${B}/${id}/courses/${courseId}`, json("DELETE")),
  reorderCourses: (id: string, courseIds: string[]) => api(`${B}/${id}/courses/order`, json("PUT", { courseIds })),
  students: (id: string, search: string) =>
    api<{ items: Student[] }>(`${B}/${id}/students${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  eligible: (id: string, search: string) =>
    api<{ items: EligibleStudent[] }>(`${B}/${id}/eligible-students${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  addStudent: (id: string, candidateId: string) => api(`${B}/${id}/students`, json("POST", { candidateId })),
  removeStudent: (id: string, candidateId: string) => api<void>(`${B}/${id}/students/${candidateId}`, json("DELETE")),
  setModule: (id: string, candidateId: string, moduleId: string, completed: boolean) =>
    api<{ completed: boolean; completedAt: string | null }>(`${B}/${id}/students/${candidateId}/modules/${moduleId}`, json("PUT", { completed })),
  trainers: () => api<{ items: { id: string; name: string }[] }>("/api/v1/training/trainers"),
  courses: (includeArchived: boolean) =>
    api<{ items: CourseSummary[]; canCreate: boolean }>(`${C}${includeArchived ? "?includeArchived=true" : ""}`),
  course: (id: string) => api<CourseDetail>(`${C}/${id}`),
  createCourse: (c: NewCourse) => api<{ id: string }>(C, json("POST", c)),
  updateCourse: (id: string, version: number, c: Partial<NewCourse> & { archived?: boolean }) =>
    api<{ rowVersion: number }>(`${C}/${id}`, json("PATCH", c, ifMatch(version))),
  deleteCourse: (id: string) => api<void>(`${C}/${id}`, json("DELETE")),
  addModule: (id: string, m: NewModule) => api<{ id: string }>(`${C}/${id}/modules`, json("POST", m)),
  updateModule: (id: string, moduleId: string, version: number, m: Partial<NewModule>) =>
    api<{ rowVersion: number }>(`${C}/${id}/modules/${moduleId}`, json("PATCH", m, ifMatch(version))),
  deleteModule: (id: string, moduleId: string) => api<void>(`${C}/${id}/modules/${moduleId}`, json("DELETE")),
  reorderModules: (id: string, moduleIds: string[]) => api(`${C}/${id}/modules/order`, json("PUT", { moduleIds })),
  candidate: (id: string) => api<CandidateTraining>(`/api/v1/candidates/${id}/training`),
};

const MESSAGES: Record<string, string> = {
  batch_exists: "A batch for this location, technology and month already exists.",
  batch_has_students: "This batch has students, so it can't be deleted. Cancel it instead.",
  location_not_in_scope: "You can manage training only at your own location.",
  invalid_trainer: "Choose a trainer who can record training progress.",
  invalid_dates: "The end date must not be before the start date.",
  invalid_batch: "Check the batch details.",
  batch_closed: "This batch is completed or cancelled; it can't be changed.",
  course_archived: "That course is archived. Restore it in the course library first.",
  course_already_assigned: "That course is already assigned to this batch.",
  invalid_course: "That course no longer exists.",
  candidate_not_eligible: "Only candidates at the batch's location can join it.",
  not_in_batch: "That candidate is no longer in this batch.",
  module_not_in_batch: "That module is not part of this batch's courses any more.",
  course_in_use: "This course is assigned to a batch or has recorded progress. Archive it instead.",
  module_in_use: "Students have completed this module, so it can't be deleted.",
  invalid_order: "The list changed meanwhile. Refresh and try again.",
  invalid_transition: "That status change isn't allowed from the batch's current status.",
  location_required: "Choose the location that owns the course.",
};

/** Plain-language text for a failed training call. */
export function trainingError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && MESSAGES[e.detail]) return MESSAGES[e.detail]!;
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return "You don't have permission to do this.";
    case 404: return "This record doesn't exist or isn't visible to you.";
    case 412: return "Someone else changed this meanwhile. Close and open it again to see the latest version.";
    case 422: return e.errors?.length ? "Some fields need attention. Check the highlighted fields." : "The server rejected this change.";
    default: return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
  }
}

/** "2h 30m", "45m", "0m". */
export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}
