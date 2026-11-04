import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { salesApi } from "./salesApi";
import { Field } from "./ui";

/**
 * Team picker for New candidate (both modes): "Not yet assigned" until the user
 * picks one of the teams in their candidate:create scope. With a single team
 * the picker is hidden and that team is used.
 */
export function useCreateTeam() {
  const teams = useQuery({ queryKey: ["candidate-create-teams"], queryFn: () => salesApi.createTeams(), staleTime: 300_000 });
  const items = teams.data?.items ?? [];
  const [picked, setPicked] = useState("");
  const teamId = items.length === 1 ? items[0]!.id : picked;
  const noTeams = teams.isSuccess && items.length === 0;
  /** An error message when the team still has to be chosen. */
  const problem = teams.isSuccess && !items.some((t) => t.id === teamId) ? "Choose a team." : undefined;
  const field = (error?: string) => (
    <>
      {noTeams && (
        <p className="note warn" role="alert">You aren't on a team you can add candidates to. Ask an admin to add you to a team.</p>
      )}
      {items.length > 1 && (
        <Field label="Team" error={error}>
          {(p) => (
            <select {...p} required value={teamId} onChange={(e) => setPicked(e.target.value)}>
              <option value="">Not yet assigned</option>
              {items.map((t) => <option key={t.id} value={t.id}>{t.lead ? `${t.name} (${t.lead})` : t.name}</option>)}
            </select>
          )}
        </Field>
      )}
    </>
  );
  return { teamId, problem, field };
}
