import { z } from "zod";
import { ROLES } from "@eureka/shared";

const uuid = z.string().uuid();

export const UserListQuery = z
  .object({
    search: z.string().max(80).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    // A department and its sub-departments, or "none" for users without one.
    departmentId: z.union([uuid, z.literal("none")]).optional(),
    // Members of a team, or "none" for users who neither lead nor belong to a team.
    team: z.union([uuid, z.literal("none")]).optional(),
    role: z.string().max(64).optional(),
    locationId: uuid.optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type UserListQuery = z.infer<typeof UserListQuery>;

export const CreateUser = z
  .object({
    email: z.string().email().max(254),
    displayName: z.string().trim().min(1).max(120),
    designation: z.string().trim().min(1).max(120).optional(),
    primaryLocationId: uuid.optional(),
    // Staging/local password sign-in only: a temporary password the user must change at first sign-in.
    temporaryPassword: z.string().min(10).max(72).optional(),
  })
  .strict();
export type CreateUser = z.infer<typeof CreateUser>;

/** Rows are validated one by one in the service so a bad row is reported, not a rejected request. */
export const BulkCreateUsers = z
  .object({
    dryRun: z.boolean(),
    rows: z
      .array(
        z
          .object({
            email: z.string().max(254),
            displayName: z.string().max(120),
            designation: z.string().max(120).optional(),
            location: z.string().max(120).optional(),
            // Role keys or labels (the template's dropdowns use labels). Location-bound roles use `location`.
            roles: z.array(z.string().max(120)).max(5).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type BulkCreateUsers = z.infer<typeof BulkCreateUsers>;

export const SetManager = z.object({ managerId: uuid.nullable() }).strict();

export const RoleKey = z.enum(ROLES);

export const CreateRoleRequest = z
  .object({ userId: uuid, role: RoleKey, locationId: uuid.optional() })
  .strict();
export type CreateRoleRequest = z.infer<typeof CreateRoleRequest>;

export const RoleRequestListQuery = z
  .object({ status: z.enum(["pending", "approved", "rejected", "expired"]).optional() })
  .strict();

export const RevokeRoleQuery = z.object({ locationId: uuid.optional() }).strict();

export const CreateTeam = z
  .object({ name: z.string().trim().min(1).max(120), leadId: uuid, locationId: uuid.optional() })
  .strict();
export type CreateTeam = z.infer<typeof CreateTeam>;

export const RenameTeam = z.object({ name: z.string().trim().min(1).max(120) }).strict();

const departmentName = z.string().trim().min(1).max(120).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "remove control characters");
/** A department, or a sub-department under a top-level one (parentId). docs/admin-api.md, Departments. */
export const CreateDepartment = z.object({ name: departmentName, parentId: uuid.optional() }).strict();
export type CreateDepartment = z.infer<typeof CreateDepartment>;
export const RenameDepartment = z.object({ name: departmentName }).strict();
export const SetDepartment = z.object({ departmentId: uuid.nullable() }).strict();

export const LOCATION_KINDS = ["training", "gh", "office", "remote"] as const;

export const CreateLocation = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(LOCATION_KINDS),
    state: z.string().trim().min(1).max(60).optional(),
    timezone: z
      .string()
      .trim()
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "invalid_timezone")
      .optional(),
  })
  .strict();
export type CreateLocation = z.infer<typeof CreateLocation>;
export const RenameLocation = z.object({ name: departmentName }).strict();

export const SetLead = z.object({ leadId: uuid }).strict();
export const AddMember = z.object({ userId: uuid }).strict();
/** Bulk add from the team drawer and the Users tab: each user is added on its own, failures are reported per user. */
export const AddMembers = z.object({ userIds: z.array(uuid).min(1).max(100) }).strict();

export const MoveMember = z
  .object({ userId: uuid, toTeamId: uuid, reassignTo: uuid.optional() })
  .strict();
export type MoveMember = z.infer<typeof MoveMember>;

export const SetPassword = z.object({ password: z.string().min(10).max(72) }).strict();

/** A designation (display label, never a role; empty or null clears it). docs/admin-api.md, docs/performance-api.md PF-7. */
export const SetDesignation = z
  .object({
    designation: z.string().trim().max(120).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "remove control characters")
      .nullable().transform((v) => (v ? v : null)),
  })
  .strict();
export type SetDesignation = z.infer<typeof SetDesignation>;
