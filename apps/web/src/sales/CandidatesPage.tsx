import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { salesError } from "./errors";
import { CreateBatchDialog } from "./CreateBatchDialog";
import { CreateCandidateDialog } from "./CreateCandidateDialog";
import { CandidateName, type ListPageProps } from "./HotListPage";
import { ListFilters, ListFooter } from "./ListControls";
import { STATUSES, salesApi, salesKeys } from "./salesApi";
import { OpenToAllBadge, Phone, Priority, StatusBadge } from "./ui";
import { useCandidateList } from "./useCandidateList";

/**
 * Candidates in the user's scope (candidate:read), with "New candidate" for
 * candidate:create holders and "New batch" when the batch list says the user
 * may plan batches. The batch filter lists every batch (FR-CAN-02).
 */
export function CandidatesPage({ me, onOpenProfile }: ListPageProps) {
  const caps = me?.capabilities ?? [];
  const qc = useQueryClient();
  const s = useCandidateList("candidates");
  const [creating, setCreating] = useState<"candidate" | "batch" | null>(null);
  const [message, setMessage] = useState("");
  const items = s.q.data?.items ?? [];
  const batches = useQuery({ queryKey: salesKeys.batches, queryFn: () => salesApi.batches(), staleTime: 60_000 });

  return (
    <>
      <div className="pagehead">
        <div><h1 tabIndex={-1}>Candidates</h1><p className="sub">Candidates in your scope: your own, your team's, and those you manage.</p></div>
        <div className="rowactions push">
          {batches.data?.canCreate && (
            <button type="button" className="btn" onClick={() => setCreating("batch")}>New batch</button>
          )}
          {caps.includes("candidate:create") && (
            <button type="button" className="btn primary" onClick={() => setCreating("candidate")}>New candidate</button>
          )}
        </div>
      </div>
      {message && <p role="status" aria-live="polite" className="livemsg">{message}</p>}
      <ListFilters s={s} label="Candidates" statuses={STATUSES} batches={batches.data?.items ?? []} />
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
      {creating === "candidate" && (
        <CreateCandidateDialog
          locations={uniqueLocations(items)}
          onClose={() => setCreating(null)}
          onOpenProfile={onOpenProfile && ((id) => { setCreating(null); onOpenProfile(id); })}
          onCreated={(id) => {
            setCreating(null);
            void qc.invalidateQueries({ queryKey: salesKeys.candidates });
            void qc.invalidateQueries({ queryKey: salesKeys.hotlist });
            void qc.invalidateQueries({ queryKey: salesKeys.batches });
            onOpenProfile?.(id);
          }}
        />
      )}
      {creating === "batch" && (
        <CreateBatchDialog
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            setMessage("Batch created.");
            void qc.invalidateQueries({ queryKey: salesKeys.batches });
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
