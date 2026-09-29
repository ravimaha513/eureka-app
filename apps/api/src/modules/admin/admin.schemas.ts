import { z } from "zod";
import { ROLES } from "@eureka/shared";

const uuid = z.string().uuid();

export const UserListQuery = z
  .object({
    search: z.string().max(80).optional(),
    status: z.enum(["active", "inactive"]).optional(),
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
  })
  .strict();
export type CreateUser = z.infer<typeof CreateUser>;

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

export const SetLead = z.object({ leadId: uuid }).strict();
export const AddMember = z.object({ userId: uuid }).strict();

export const MoveMember = z
  .object({ userId: uuid, toTeamId: uuid, reassignTo: uuid.optional() })
  .strict();
export type MoveMember = z.infer<typeof MoveMember>;
