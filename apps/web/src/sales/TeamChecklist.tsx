/** Team picker for "Selected teams" visibility (0240), shared by the profile and Hot List bulk bar. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { salesApi } from "./salesApi";
import { Loading } from "../ui/Loading";

export function TeamChecklist({ picked, onChange, excludeTeamId, disabled, describedBy }: {
  picked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** The candidate's own team: it always sees the candidate, so it is not offered. */
  excludeTeamId?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  const teams = useQuery({ queryKey: ["candidate-share-teams"], queryFn: () => salesApi.shareTeams(), staleTime: 300_000 });
  const [filter, setFilter] = useState("");
  if (teams.isPending) return <Loading />;
  if (teams.isError) return <p className="error" role="alert">Couldn't load teams.</p>;
  const needle = filter.trim().toLowerCase();
  const shown = teams.data.items
    .filter((t) => t.id !== excludeTeamId)
    .filter((t) => `${t.name} ${t.lead ?? ""}`.toLowerCase().includes(needle));
  return (
    <>
      <label className="field">
        <span>Find a team</span>
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} aria-describedby={describedBy} />
      </label>
      <fieldset className="radios sharelist">
        <legend>Teams</legend>
        {shown.length === 0 && <p className="muted">No teams match.</p>}
        {shown.map((t) => (
          <label key={t.id}>
            <input type="checkbox" checked={picked.has(t.id)} disabled={disabled}
              onChange={(e) => {
                const n = new Set(picked);
                if (e.target.checked) n.add(t.id); else n.delete(t.id);
                onChange(n);
              }} />
            {t.name}{t.lead ? <span className="muted"> · {t.lead}</span> : null}
          </label>
        ))}
      </fieldset>
      <p className="muted">{picked.size === 0 ? "Not shared with other teams." : picked.size === 1 ? "1 team picked." : `${picked.size} teams picked.`}</p>
    </>
  );
}
