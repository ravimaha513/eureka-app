/** Typed client for the admin and team API (docs/admin-api.md). */
import { api } from "../api";

export interface Ref { id: string; displayName: string }
export interface Place { id: string; name: string }

export interface RoleMeta { key: string; label: string; restricted: boolean; locationBound: boolean }
export interface AdminMeta { roles: RoleMeta[]; locations: Place[] }

export interface UserRole { key: string; label: string; locationId: string | null; locationName: string | null }
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  designation: string | null;
  /** Present only when the caller holds staff.contact:read (Settings profile phone). */
  phone?: string | null;
  status: "active" | "inactive";
  primaryLocation: Place | null;
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

export interface BulkRowResult { row: number; email: string; displayName: string; status: "ok" | "error"; error?: string; id?: string }
export interface BulkReport { dryRun: boolean; committed: boolean; created: number; failed: number; rows: BulkRowResult[] }

export interface Team { id: string; name: string; location: Place | null; lead: Ref; members: Ref[] }
export interface MoveResult { movedCandidates: number; reassignedTo: Ref }

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const adminApi = {
  meta: () => api<AdminMeta>("/api/v1/admin/meta"),

  users: (p: { search?: string; status?: "active" | "inactive"; cursor?: string | null; limit?: number }) => {
    const q = new URLSearchParams();
    if (p.search) q.set("search", p.search);
    if (p.status) q.set("status", p.status);
    if (p.cursor) q.set("cursor", p.cursor);
    q.set("limit", String(p.limit ?? 50));
    return api<UserPage>(`/api/v1/admin/users?${q}`);
  },
  userSummary: () => api<UserSummary>("/api/v1/admin/users/summary"),
  createUser: (b: { email: string; displayName: string; designation?: string; primaryLocationId?: string }) =>
    api<{ id: string }>("/api/v1/admin/users", { method: "POST", ...json(b) }),
  bulkCreateUsers: (b: { dryRun: boolean; rows: { email: string; displayName: string; designation?: string; location?: string }[] }) =>
    api<BulkReport>("/api/v1/admin/users/bulk", { method: "POST", ...json(b) }),
  deactivate: (id: string) => api<void>(`/api/v1/admin/users/${enc(id)}/deactivate`, { method: "POST" }),
  reactivate: (id: string) => api<void>(`/api/v1/admin/users/${enc(id)}/reactivate`, { method: "POST" }),
  setManager: (id: string, managerId: string | null) =>
    api<void>(`/api/v1/admin/users/${enc(id)}/manager`, { method: "PUT", ...json({ managerId }) }),

  requestRole: (b: { userId: string; role: string; locationId?: string }) =>
    api<{ id: string; status: "applied" | "pending_approval" }>("/api/v1/admin/role-requests", { method: "POST", ...json(b) }),
  roleRequests: (status: RequestStatus = "pending") =>
    api<{ items: RoleRequest[] }>(`/api/v1/admin/role-requests?status=${status}`),
  approve: (id: string) => api<{ status: "approved" }>(`/api/v1/admin/role-requests/${enc(id)}/approve`, { method: "POST" }),
  reject: (id: string) => api<{ status: "rejected" }>(`/api/v1/admin/role-requests/${enc(id)}/reject`, { method: "POST" }),
  revokeRole: (userId: string, role: string, locationId: string | null) =>
    api<void>(`/api/v1/admin/users/${enc(userId)}/roles/${enc(role)}${locationId ? `?locationId=${enc(locationId)}` : ""}`, { method: "DELETE" }),

  teams: () => api<{ items: Team[] }>("/api/v1/admin/teams"),
  createTeam: (b: { name: string; leadId: string; locationId?: string }) =>
    api<{ id: string }>("/api/v1/admin/teams", { method: "POST", ...json(b) }),
  setLead: (teamId: string, leadId: string) =>
    api<void>(`/api/v1/admin/teams/${enc(teamId)}/lead`, { method: "PUT", ...json({ leadId }) }),
  addMember: (teamId: string, userId: string) =>
    api<void>(`/api/v1/admin/teams/${enc(teamId)}/members`, { method: "POST", ...json({ userId }) }),
  moveMember: (fromTeamId: string, b: { userId: string; toTeamId: string; reassignTo?: string }) =>
    api<MoveResult>(`/api/v1/teams/${enc(fromTeamId)}/move-member`, { method: "POST", ...json(b) }),
};
