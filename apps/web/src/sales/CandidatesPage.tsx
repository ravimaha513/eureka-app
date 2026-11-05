import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { salesError } from "./errors";
import { navigate } from "../lib/router";
import { screenPath } from "../nav";
import { CreateCandidateDialog } from "./CreateCandidateDialog";
import { CandidateName, profileOpenable, type ListPageProps } from "./HotListPage";
import { ListFilters, ListFooter, resultCount } from "./ListControls";
import { STATUSES, salesApi, salesKeys } from "./salesApi";
import { OpenToAllBadge, SharedBadge, Phone, Priority, StatusBadge } from "./ui";
import { useCandidateList } from "./useCandidateList";
import { NewBatchDialog } from "../training/NewBatchDialog";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";

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
        <div><h1 tabIndex={-1}>Candidates{resultCount(s) && <span className="h1count" aria-label={`, ${resultCount(s)} candidates`}>{resultCount(s)}</span>}</h1><p className="sub">Candidates in your scope: your own, your team's, and those you manage.</p></div>
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
      <div className="card tablewrap listcard">
        {s.q.isLoading ? <Loading /> : s.q.error ? <QueryError query={s.q} message={salesError(s.q.error)} /> : (
          <table className="cardtable" aria-label="Candidates" aria-busy={s.q.isFetching || undefined}>
            <thead><tr>
              <th>Candidate</th><th>Technology</th><th>Status</th><th>Pri</th><th>Team</th><th>Recruiter</th>
              <th className="p2">Location</th><th>Phone</th><th className="num">Rating</th>
            </tr></thead>
            <tbody>
              {items.map((c) => {
                const openable = Boolean(onOpenProfile) && profileOpenable(c, caps);
                return (
                <tr key={c.id} className={openable ? "rowopen" : undefined}
                  onClick={openable ? (e) => { if (!(e.target as HTMLElement).closest("a, button, input, select, label")) onOpenProfile!(c.id); } : undefined}>
                  <td className="c-name"><CandidateName c={c} caps={caps} onOpenProfile={onOpenProfile} plain /></td>
                  <td className="c-tech">{c.technology}</td>
                  <td className="c-status"><span className="badges"><StatusBadge status={c.status} />{c.visibility === "all_teams" && <OpenToAllBadge />}{c.visibility === "selected_teams" && <SharedBadge />}</span></td>
                  <td className="c-pri"><Priority p={c.priority} /></td>
                  <td className="c-team">{c.team.name}</td>
                  <td className="c-rec">{c.recruiter?.name ?? <span className="muted">Unassigned</span>}</td>
                  <td className="p2">{c.location.name}</td>
                  <td className={`c-phone${c.phoneMasked ? " masked" : ""}`}><Phone c={c} /></td>
                  <td className="c-days num">{c.technicalRating ? <>{c.technicalRating}/5<span className="cardonly"> rating</span></> : "—"}</td>
                </tr>
                );
              })}
              {items.length === 0 && <tr><td colSpan={9} className="empty">{s.hasFilters ? "No candidates match these filters." : "No candidates in your scope yet."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <ListFooter s={s} label="Candidates" />
      {creating === "candidate" && (
        <CreateCandidateDialog
          locations={uniqueLocations(items)}
          canAddTechnology={caps.includes("technology:create")}
          onClose={() => setCreating(null)}
          onOpenProfile={onOpenProfile && ((id) => { setCreating(null); onOpenProfile(id); })}
          onCreated={(id) => {
            setCreating(null);
            void qc.invalidateQueries({ queryKey: salesKeys.candidates });
            void qc.invalidateQueries({ queryKey: salesKeys.hotlist });
            void qc.invalidateQueries({ queryKey: salesKeys.batches });
            onOpenProfile?.(id);
          }}
          onCreatedMany={(n, done) => {
            if (done) setCreating(null);
            setMessage(`${n} ${n === 1 ? "candidate" : "candidates"} added.`);
            void qc.invalidateQueries({ queryKey: salesKeys.candidates });
            void qc.invalidateQueries({ queryKey: salesKeys.hotlist });
            void qc.invalidateQueries({ queryKey: salesKeys.batches });
          }}
        />
      )}
      {creating === "batch" && (
        <NewBatchDialog
          me={me}
          onClose={() => setCreating(null)}
          onDone={(id, name, added) => {
            setCreating(null);
            setMessage(added > 0 ? `Batch ${name} created with ${added} candidate${added === 1 ? "" : "s"}.` : "Batch created.");
            void qc.invalidateQueries({ queryKey: salesKeys.batches });
            if (added > 0) void qc.invalidateQueries({ queryKey: salesKeys.candidates });
            // Straight to the new batch, where students are added.
            if (caps.includes("training:read")) navigate(screenPath("training", id));
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
