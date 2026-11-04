import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogActions } from "../ui/Dialog";
import { salesError } from "./errors";
import { salesApi } from "./salesApi";
import { Field, useFocusAfterFailure } from "./ui";

/** Gives a candidate created with "No team yet" their team (PUT /candidates/:id/team), from the New candidate dialog's teams. */
export function AssignTeamDialog({ candidateId, onClose, onAssigned }: {
  candidateId: string; onClose: () => void; onAssigned: (teamName: string) => void;
}) {
  const teams = useQuery({ queryKey: ["candidate-create-teams"], queryFn: () => salesApi.createTeams(), staleTime: 300_000 });
  const items = teams.data?.items ?? [];
  const [teamId, setTeamId] = useState("");
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const team = items.find((t) => t.id === teamId);
    setError(team ? "" : "Choose a team."); setFormError("");
    if (!team) { failed(); return; }
    setBusy(true);
    try {
      await salesApi.assignTeam(candidateId, team.id);
      onAssigned(team.name);
    } catch (err) {
      setFormError(salesError(err));
      failed();
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="Assign team" onClose={onClose}>
      <form ref={formRef} onSubmit={submit} noValidate>
        <Field label="Team" error={error}>
          {(p) => (
            <select {...p} required value={teamId} onChange={(e) => setTeamId(e.target.value)} data-autofocus>
              <option value="">Choose a team</option>
              {items.map((t) => <option key={t.id} value={t.id}>{t.lead ? `${t.name} (${t.lead})` : t.name}</option>)}
            </select>
          )}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Assign team" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
