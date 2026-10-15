/** Typed client for contracts on a placement (docs/alerts-calendar-birthdays.md CT-1..CT-6). */
import type { ContractKind } from "@eureka/shared";
import { ApiError, api } from "../api";

export interface Contract {
  id: string; placementId: string; kind: ContractKind; title: string; reference: string | null;
  startsOn: string | null; endsOn: string | null; notes: string | null; createdAt: string;
  createdBy: { id: string; name: string | null };
}
export interface ContractList { items: Contract[]; canAdd: boolean }
export interface CreateContract {
  kind: ContractKind; title: string; reference?: string | null; startsOn?: string | null; endsOn?: string | null; notes?: string | null;
}

const enc = encodeURIComponent;
export const contractsApi = {
  list: (placementId: string) => api<ContractList>(`/api/v1/placements/${enc(placementId)}/contracts`),
  create: (placementId: string, b: CreateContract) =>
    api<Contract>(`/api/v1/placements/${enc(placementId)}/contracts`, { method: "POST", body: JSON.stringify(b) }),
};
export const contractKeys = { list: (placementId: string) => ["contracts", placementId] as const };

const ERRORS: Record<string, string> = {
  placement_closed: "Contracts cannot be added to a backed-out or BGC-failed placement.",
  invalid_contract: "Check the contract details and try again.",
};
export function contractError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && ERRORS[e.detail]) return ERRORS[e.detail]!;
  if (e.status === 422 && e.errors?.length) return e.errors.map((x) => x.message).join(" ");
  if (e.status === 403) return "You are not allowed to add contracts to this placement.";
  if (e.status === 404) return "The placement is no longer available.";
  return e.detail ?? e.title ?? e.message;
}
