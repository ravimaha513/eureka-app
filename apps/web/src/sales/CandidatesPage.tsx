import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { salesError } from "./errors";
import { CreateCandidateDialog } from "./CreateCandidateDialog";
import { CandidateName, type ListPageProps } from "./HotListPage";
import { ListFilters, ListFooter } from "./ListControls";
import { STATUSES, salesKeys } from "./salesApi";
import { OpenToAllBadge, Phone, Priority, StatusBadge } from "./ui";
import { useCandidateList } from "./useCandidateList";

/** Candidates in the user's scope (candidate:read), with "New candidate" for candidate:create holders. */
export function CandidatesPage({ me, onOpenProfile }: ListPageProps) {
  const caps = me?.capabilities ?? [];
  const qc = useQueryClient();
  const s = useCandidateList("candidates");
  const [creating, setCreating] = useState(false);
  const items = s.q.data?.items ?? [];

  return (
    <>
      <div className="pagehead">
        <div><h1 tabIndex={-1}>Candidates</h1><p className="sub">Candidates in your scope: your own, your team's, and those you manage.</p></div>
        {caps.includes("candidate:create") && (
          <button type="button" className="btn primary push" onClick={() => setCreating(true)}>New candidate</button>
        )}
      </div>
      <ListFilters s={s} label="Candidates" statuses={STATUSES} />
      <div className="card tablewrap">
        {s.q.isLoading ? <p className="empty">Loading…</p> : s.q.error ? <p className="empty error" role="alert">{salesError(s.q.error)}</p> : (
          <table aria-label="Candidates" aria-busy={s.q.isFetching || undefined}>
            <thead><tr><th>Candidate</th><th>Technology</th><th>Status</th><th>Pri</th><th>Team</th><th>Recruiter</th><th>Location</th><th>Phone</th><th>Rating</th></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td><CandidateName c={c} caps={caps} onOpenProfile={onOpenProfile} /></td>
                  <td>{c.technology}</td>
                  <td><StatusBadge status={c.status} />{" "}{c.visibility === "all_teams" && <OpenToAllBadge />}</td>
                  <td><Priority p={c.priority} /></td>
                  <td>{c.team.name}</td>
                  <td>{c.recruiter?.name ?? "Unassigned"}</td>
                  <td>{c.location.name}</td>
                  <td className={c.phoneMasked ? "masked" : ""}><Phone c={c} /></td>
                  <td>{c.technicalRating ? `${c.technicalRating}/5` : "—"}</td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={9} className="empty">{s.hasFilters ? "No candidates match these filters." : "No candidates in your scope yet."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <ListFooter s={s} label="Candidates" />
      {creating && (
        <CreateCandidateDialog
          locations={uniqueLocations(items)}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: salesKeys.candidates });
            void qc.invalidateQueries({ queryKey: salesKeys.hotlist });
            onOpenProfile?.(id);
          }}
        />
      )}
    </>
  );
}

function uniqueLocations(items: { location: { id: string; name: string } }[]) {
  const m = new Map<string, string>();
  for (const c of items) m.set(c.location.id, c.location.name);
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
