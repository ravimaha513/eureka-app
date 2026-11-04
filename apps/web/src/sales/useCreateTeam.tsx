import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { salesApi, type InitialStatus } from "./salesApi";
import { Field } from "./ui";

/**
 * Team picker for New candidate (both modes): "Not yet assigned" until the user
 * picks one of the teams in their candidate:create scope. With a single team
 * the picker is hidden and that team is used. `allowNone` adds "No team yet"
 * (created with `teamId: null`, assigned later from the profile; 0410).
 */
export const NO_TEAM = "none";

export function useCreateTeam({ allowNone = false }: { allowNone?: boolean } = {}) {
  const teams = useQuery({ queryKey: ["candidate-create-teams"], queryFn: () => salesApi.createTeams(), staleTime: 300_000 });
  const items = teams.data?.items ?? [];
  const [picked, setPicked] = useState("");
  const teamId = items.length === 1 ? items[0]!.id : picked;
  const noTeams = teams.isSuccess && items.length === 0;
  /** An error message when the team still has to be chosen. */
  const none = allowNone && teamId === NO_TEAM;
  const problem = teams.isSuccess && !none && !items.some((t) => t.id === teamId) ? "Choose a team." : undefined;
  /** The `teamId` part of POST /candidates. */
  const body = (): { teamId?: string | null } => (none ? { teamId: null } : teamId ? { teamId } : {});
  const field = (error?: string) => (
    <>
      {noTeams && (
        <p className="note warn" role="alert">You aren't on a team you can add candidates to. Ask an admin to add you to a team.</p>
      )}
      {items.length > 1 && (
        <Field label="Team" hint={none ? "You can assign the team later from the candidate's profile." : undefined} error={error}>
          {(p) => (
            <select {...p} required value={teamId} onChange={(e) => setPicked(e.target.value)}>
              <option value="">Not yet assigned</option>
              {items.map((t) => <option key={t.id} value={t.id}>{t.lead ? `${t.name} (${t.lead})` : t.name}</option>)}
              {allowNone && <option value={NO_TEAM}>No team yet</option>}
            </select>
          )}
        </Field>
      )}
    </>
  );
  return { teamId, none, problem, body, field };
}

/** Status for New candidate: new candidates start in training, or go straight to Active (marketing). */
export function InitialStatusField({ value, onChange }: { value: InitialStatus; onChange: (s: InitialStatus) => void }) {
  return (
    <Field label="Status" hint={value === "active" ? "Starts marketing now: the candidate shows on the Hot List." : "Moves to Active later from the profile."}>
      {(p) => (
        <select {...p} value={value} onChange={(e) => onChange(e.target.value as InitialStatus)}>
          <option value="in_training">In training</option>
          <option value="active">Active</option>
        </select>
      )}
    </Field>
  );
}
