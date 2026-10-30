/** Typed client for the admin and team API (docs/admin-api.md). */
import { api, apiFetch } from "../api";
import type { Coach } from "../team/coachApi";

export interface Ref { id: string; displayName: string }
export interface Place { id: string; name: string }

export interface RoleMeta {
  key: string; label: string; restricted: boolean; locationBound: boolean;
  isSystem: boolean; track: string; level: number; recruiter: boolean; department: Place | null;
}

// ---- org chart (docs/roles-api.md, "Org chart") ---------------------------------------------------
export interface OrgPerson {
  id: string; displayName: string; designation: string | null; managerId: string | null;
  roles: { key: string; label: string; track: string; level: number }[];
  team: { id: string; name: string; asLead: boolean } | null;
  canMove: boolean;
}
export interface OrgChart { people: OrgPerson[]; teams: { id: string; name: string; leadId: string }[] }
export interface OrgPreview { loses: Ref[]; gains: Ref[]; warnings: string[] }

// ---- role definitions (docs/roles-api.md) -----------------------------------------------------
export interface RoleTraits { sales: boolean; locationBound: boolean; admin: boolean; recruiter: boolean; coach: boolean }
export interface RoleDef {
  key: string; label: string; description: string | null; isSystem: boolean; restricted: boolean;
  traits: RoleTraits; track: string; level: number; department: Place | null; clonedFrom: string | null;
  holders: number; archivedAt: string | null; grants: Record<string, string>;
}
export interface PermissionDef { key: string; area: string; description: string; restricted: boolean; orgSensitive: boolean }
export interface PermissionCatalog { scopes: string[]; items: PermissionDef[] }
export const SCOPE_LABELS: Record<string, string> = {
  own: "Own records", team: "Own team", coached: "Coached teams", coached_hierarchy: "Coached teams + below",
  hierarchy: "Reporting hierarchy", location: "Their location", org: "Whole organisation",
};
export const TRAIT_LABELS: Record<keyof RoleTraits, { label: string; hint: string }> = {
  sales: { label: "Sales", hint: "Sees candidates marked open to all teams; client requirements; counted in performance." },
  locationBound: { label: "Location-bound", hint: "Each grant is tied to one location." },
  admin: { label: "Administrator", hint: "Users & Access admin. Never held together with a business role; always restricted." },
  recruiter: { label: "Recruiter", hint: "Owns the candidates they add; can be added to a team as a member." },
  coach: { label: "Interview coach", hint: "Can be assigned to coach sales teams and train batches." },
};
/** "interview_prep" → "Interview prep". */
export const trackLabel = (t: string) => t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
export const LOCATION_KINDS = ["training", "gh", "office", "remote"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export interface AdminMeta { roles: RoleMeta[]; locations: Place[]; singleAdminMode?: boolean }

/** Descriptive only (docs/admin-api.md AD-11): never grants access. */
export interface Department { id: string; name: string; parentId: string | null; userCount: number }
export interface UserDepartment { id: string; name: string; parent: { id: string; name: string } | null }
/** "Sales › Interview Prep" for a sub-department, "Sales" for a top-level one. */
export const departmentLabel = (d: UserDepartment) => (d.parent ? `${d.parent.name} › ${d.name}` : d.name);

export interface UserRole { key: string; label: string; locationId: string | null; locationName: string | null }
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  designation: string | null;
  /** Present only when the caller holds staff.contact:read (Settings profile phone). */
  phone?: string | null;
  status: "active" | "inactive";
  /** Inactive users only: earliest time the daily purge deletes them (docs/admin-api.md AD-13). */
  deletesAt?: string;
  primaryLocation: Place | null;
  department: UserDepartment | null;
  manager: Ref | null;
  roles: UserRole[];
  teams: { id: string; name: string; asLead: boolean }[];
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface UserPage extends Page<AdminUser> { contactVisible?: boolean }
export interface UserSummary { active: number; inactive: number; roles: { key: string; label: string; count: number }[] }

export type RequestStatus = "pending" | "approved" | "rejected" | "expired";
export interface RoleRequest {
  id: string;
  user: { id: string; displayName: string; email: string };
  role: string;
  roleLabel: string;
  locationId: string | null;
  requestedBy: Ref;
  requestedAt: string;
  status: RequestStatus;
  decidedBy: Ref | null;
  decidedAt: string | null;
}

export interface BulkRoleResult { role: string; label: string; status: "applied" | "pending_approval" }
export interface BulkRowResult {
  row: number; email: string; displayName: string; status: "ok" | "error"; error?: string; id?: string; roles: BulkRoleResult[];
}
export interface BulkReport { dryRun: boolean; committed: boolean; created: number; failed: number; rows: BulkRowResult[] }

export interface Team { id: string; name: string; location: Place | null; lead: Ref; /** The lead's department. */ department: UserDepartment | null; members: Ref[]; coaches: Ref[] }
export interface MoveResult { movedCandidates: number; reassignedTo: Ref }
/** Bulk add: each person is added on its own; `failed` carries the contract error code per person. */
export interface AddMembersResult { added: string[]; failed: { userId: string; error: string }[] }

/** Users list filters (GET /admin/users). `team`: a team id, or "none" for people who neither lead nor belong to a team. */
export interface UserFilters {
  search?: string; status?: "active" | "inactive"; departmentId?: string; team?: string; role?: string; locationId?: string;
  cursor?: string | null; limit?: number;
}

export interface LocationSummary {
  id: string; name: string; kind: LocationKind; state: string | null; timezone: string;
  peopleCount: number; teamCount: number;
  roleHolders: { userId: string; displayName: string; role: string; label: string }[];
}
export interface LocationPerson {
  id: string;
  displayName: string;
  designation: string | null;
  primaryLocation: Place | null;
  /** May point at someone in outsideManagers (based at another location). */
  managerId: string | null;
  roles: UserRole[];
  teams: { id: string; name: string; asLead: boolean }[];
}
export interface LocationDetail {
  location: { id: string; name: string; kind: LocationKind; state: string | null; timezone: string };
  people: LocationPerson[];
  outsideManagers: { id: string; displayName: string; locationName: string | null }[];
  teams: { id: string; name: string; lead: Ref; memberIds: string[]; coaches: Ref[] }[];
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const adminApi = {
  meta: () => api<AdminMeta>("/api/v1/admin/meta"),

  users: (p: UserFilters) => {
    const q = new URLSearchParams();
    if (p.search) q.set("search", p.search);
    if (p.status) q.set("status", p.status);
    if (p.departmentId) q.set("departmentId", p.departmentId);
    if (p.team) q.set("team", p.team);
    if (p.role) q.set("role", p.role);
    if (p.locationId) q.set("locationId", p.locationId);
    if (p.cursor) q.set("cursor", p.cursor);
    q.set("limit", String(p.limit ?? 50));
    return api<UserPage>(`/api/v1/admin/users?${q}`);
  },
  userSummary: () => api<UserSummary>("/api/v1/admin/users/summary"),
  createUser: (b: { email: string; displayName: string; designation?: string; primaryLocationId?: string; temporaryPassword?: string; sendPasswordInvite?: boolean }) =>
    api<{ id: string; invite?: "sent" | "failed" }>("/api/v1/admin/users", { method: "POST", ...json(b) }),
  bulkCreateUsers: (b: { dryRun: boolean; rows: { email: string; displayName: string; designation?: string; location?: string; roles?: string[] }[] }) =>
    api<BulkReport>("/api/v1/admin/users/bulk", { method: "POST", ...json(b) }),
  /** The .xlsx template with role and location dropdowns. */
  bulkTemplate: async () => (await apiFetch("/api/v1/admin/users/bulk/template")).blob(),
  /** Staging/local: a temporary password the user must change at first sign-in (not for restricted-role users). */
  setPassword: (id: string, password: string) =>
    api<void>(`/api/v1/admin/users/${enc(id)}/password`, { method: "POST", ...json({ password }) }),
  /** Staging/local: emails a one-time link to set their own password (replaces any open link). */
  sendPasswordInvite: (id: string) => api<void>(`/api/v1/admin/users/${enc(id)}/password-invite`, { method: "POST" }),
  deactivate: (id: string) => api<void>(`/api/v1/admin/users/${enc(id)}/deactivate`, { method: "POST" }),
  reactivate: (id: string) => api<void>(`/api/v1/admin/users/${enc(id)}/reactivate`, { method: "POST" }),
  deleteUser: (id: string) => api<void>(`/api/v1/admin/users/${enc(id)}`, { method: "DELETE" }),
  setManager: (id: string, managerId: string | null) =>
    api<void>(`/api/v1/admin/users/${enc(id)}/manager`, { method: "PUT", ...json({ managerId }) }),
  setDepartment: (id: string, departmentId: string | null) =>
    api<void>(`/api/v1/admin/users/${enc(id)}/department`, { method: "PUT", ...json({ departmentId }) }),

  departments: () => api<{ items: Department[] }>("/api/v1/admin/departments"),
  createDepartment: (b: { name: string; parentId?: string }) =>
    api<{ id: string }>("/api/v1/admin/departments", { method: "POST", ...json(b) }),
  renameDepartment: (id: string, name: string) =>
    api<void>(`/api/v1/admin/departments/${enc(id)}`, { method: "PATCH", ...json({ name }) }),

  requestRole: (b: { userId: string; role: string; locationId?: string }) =>
    api<{ id: string; status: "applied" | "pending_approval" }>("/api/v1/admin/role-requests", { method: "POST", ...json(b) }),
  roleRequests: (status: RequestStatus = "pending") =>
    api<{ items: RoleRequest[] }>(`/api/v1/admin/role-requests?status=${status}`),
  approve: (id: string) => api<{ status: "approved" }>(`/api/v1/admin/role-requests/${enc(id)}/approve`, { method: "POST" }),
  reject: (id: string) => api<{ status: "rejected" }>(`/api/v1/admin/role-requests/${enc(id)}/reject`, { method: "POST" }),
  revokeRole: (userId: string, role: string, locationId: string | null) =>
    api<void>(`/api/v1/admin/users/${enc(userId)}/roles/${enc(role)}${locationId ? `?locationId=${enc(locationId)}` : ""}`, { method: "DELETE" }),

  orgChart: () => api<OrgChart>("/api/v1/admin/org-chart"),
  orgChartPreview: (userId: string, managerId: string | null) =>
    api<OrgPreview>(`/api/v1/admin/org-chart/preview?userId=${enc(userId)}&managerId=${enc(managerId ?? "")}`),
  orgChartApply: (b: { moves: { userId: string; managerId: string | null }[]; teamAdds: { userId: string; teamId: string }[] }) =>
    api<{ applied: number; warnings: { userId: string; code: string }[] }>("/api/v1/admin/org-chart/apply", { method: "POST", ...json(b) }),

  roles: (includeArchived = false) => api<{ items: RoleDef[] }>(`/api/v1/admin/roles${includeArchived ? "?includeArchived=true" : ""}`),
  permissions: () => api<PermissionCatalog>("/api/v1/admin/permissions"),
  createRole: (b: { label: string; cloneFrom: string; description?: string; departmentId?: string; track?: string; level?: number }) =>
    api<{ key: string }>("/api/v1/admin/roles", { method: "POST", ...json(b) }),
  updateRole: (key: string, b: { label?: string; description?: string | null; track?: string; level?: number; departmentId?: string | null; traits?: Partial<RoleTraits> }) =>
    api<void>(`/api/v1/admin/roles/${enc(key)}`, { method: "PATCH", ...json(b) }),
  setRoleGrants: (key: string, grants: Record<string, string | null>) =>
    api<void>(`/api/v1/admin/roles/${enc(key)}/grants`, { method: "PUT", ...json({ grants }) }),
  archiveRole: (key: string) => api<void>(`/api/v1/admin/roles/${enc(key)}/archive`, { method: "POST" }),
  restoreRole: (key: string) => api<void>(`/api/v1/admin/roles/${enc(key)}/restore`, { method: "POST" }),

  locations: () => api<{ items: LocationSummary[] }>("/api/v1/admin/locations"),
  location: (id: string) => api<LocationDetail>(`/api/v1/admin/locations/${enc(id)}`),
  createLocation: (b:{ name: string; kind: LocationKind; state?: string; timezone?: string }) =>
    api<{ id: string }>("/api/v1/admin/locations", { method: "POST", ...json(b) }),
  renameLocation: (id: string, name: string) =>
    api<void>(`/api/v1/admin/locations/${enc(id)}`, { method: "PATCH", ...json({ name }) }),

  /** `coaches`: active holders of a coach role, who can be assigned to teams (AD-11). */
  /** `unassignedCount`: active people who neither lead nor belong to a team. */
  teams: () => api<{ items: Team[]; coaches: Coach[]; unassignedCount: number }>("/api/v1/admin/teams"),
  createTeam: (b: { name: string; leadId: string; locationId?: string }) =>
    api<{ id: string }>("/api/v1/admin/teams", { method: "POST", ...json(b) }),
  renameTeam: (teamId: string, name: string) =>
    api<void>(`/api/v1/admin/teams/${enc(teamId)}`, { method: "PATCH", ...json({ name }) }),
  setLead: (teamId: string, leadId: string) =>
    api<void>(`/api/v1/admin/teams/${enc(teamId)}/lead`, { method: "PUT", ...json({ leadId }) }),
  addMember: (teamId: string, userId: string) =>
    api<void>(`/api/v1/admin/teams/${enc(teamId)}/members`, { method: "POST", ...json({ userId }) }),
  addMembers: (teamId: string, userIds: string[]) =>
    api<AddMembersResult>(`/api/v1/admin/teams/${enc(teamId)}/members/bulk`, { method: "POST", ...json({ userIds }) }),
  moveMember: (fromTeamId: string, b: { userId: string; toTeamId: string; reassignTo?: string }) =>
    api<MoveResult>(`/api/v1/teams/${enc(fromTeamId)}/move-member`, { method: "POST", ...json(b) }),
};
