import { z } from "zod";
import { ASSIGNMENT_END_REASONS, EMPLOYEE_EXIT_REASONS, EMPLOYEE_STATUSES } from "@eureka/shared";

/** docs/employees-api.md. Every body is strict: unknown and server-managed fields are refused (422). */
const uuid = z.string().uuid();
const day = z.string().date().refine((d) => d >= "2000-01-01" && d <= "2100-12-31", "out of range");

/** Keyset cursor "<YYYY-MM-DD>.<uuid>" (status_since, person id). */
export const EmployeeCursor = z.string().regex(/^\d{4}-\d{2}-\d{2}\.[0-9a-f-]{36}$/i, "invalid cursor");

export const EmployeeListQuery = z
  .object({
    status: z.enum(EMPLOYEE_STATUSES).optional(),
    locationId: uuid.optional(),
    /** 0150: matches any readable assignment (current or past) unless clientMatch=current. */
    clientId: uuid.optional(),
    clientMatch: z.enum(["any", "current"]).optional(),
    /** 0150: any readable assignment's placement vendor / payroll company. */
    vendorId: uuid.optional(),
    payrollCompanyId: uuid.optional(),
    /** Open assignments whose planned end date is within this many days (overdue included). */
    endingWithinDays: z.coerce.number().int().min(1).max(365).optional(),
    search: z.string().trim().min(1).max(80).optional(),
    cursor: EmployeeCursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type EmployeeListQuery = z.infer<typeof EmployeeListQuery>;

/** POST /employees/export (EM-X1): the list filters without paging. */
export const EmployeeExportQuery = EmployeeListQuery.omit({ cursor: true, limit: true }).strict();
export type EmployeeExportQuery = z.infer<typeof EmployeeExportQuery>;

/** POST /assignments/:id/end — project exit. */
export const EndAssignment = z.object({ endDate: day, reason: z.enum(ASSIGNMENT_END_REASONS) }).strict();
export type EndAssignment = z.infer<typeof EndAssignment>;

/** PUT /assignments/:id/planned-end-date — set or extend. */
export const PlannedEndDate = z.object({ plannedEndDate: day }).strict();
export type PlannedEndDate = z.infer<typeof PlannedEndDate>;

/** POST /employees/:id/exit. */
export const ExitEmployee = z.object({ exitDate: day, reason: z.enum(EMPLOYEE_EXIT_REASONS) }).strict();
export type ExitEmployee = z.infer<typeof ExitEmployee>;

/** POST /employees/:id/return-to-market takes no fields. */
export const ReturnToMarket = z.object({}).strict();

/** Joinings/exits report period (inclusive days, at most two years). */
export const ReportPeriod = z
  .object({ from: z.string().date(), to: z.string().date() })
  .strict()
  .refine((p) => p.from <= p.to, { message: "from must be on or before to", path: ["to"] })
  .refine((p) => (Date.parse(p.to) - Date.parse(p.from)) / 86_400_000 <= 731, { message: "the period can span at most two years", path: ["to"] });
export type ReportPeriod = z.infer<typeof ReportPeriod>;

/**
 * PATCH /assignments/:id/employment (0150): HR-owned employment facts. Every
 * key is optional (at least one); null clears it. payRate needs rate:read over
 * the placement's actor snapshot as well.
 */
export const AssignmentEmployment = z
  .object({
    payrollCompanyId: uuid.nullable().optional(),
    everifyDate: day.nullable().optional(),
    onboardedDate: day.nullable().optional(),
    payRate: z.number().positive().max(1000).multipleOf(0.01).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "send at least one field" });
export type AssignmentEmployment = z.infer<typeof AssignmentEmployment>;

/** POST /employees/:id/assign-team (0150, leaving a project). */
export const AssignTeam = z.object({ teamId: uuid }).strict();
export type AssignTeam = z.infer<typeof AssignTeam>;

/** GET /reports/active-employees (0150): a calendar month, optionally one client. */
export const ActiveEmployeesQuery = z
  .object({ month: z.string().regex(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/, "use YYYY-MM"), clientId: uuid.optional() })
  .strict();
export type ActiveEmployeesQuery = z.infer<typeof ActiveEmployeesQuery>;
