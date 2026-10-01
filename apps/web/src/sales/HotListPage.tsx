import { useEffect, useState } from "react";
import type { Candidate, Me } from "../api";
import { salesError } from "./errors";
import { BulkBar, ExportButton, SavedViews } from "./HotListExtras";
import { ListFilters, ListFooter } from "./ListControls";
import { HOTLIST_STATUS_OPTIONS } from "./salesApi";
import { Drawer, OpenToAllBadge, Phone, Priority, StatusBadge, fmtDate } from "./ui";
import { useCandidateList } from "./useCandidateList";

export interface ListPageProps {
  me?: Pick<Me, "id" | "capabilities">;
  /** Opens the full candidate profile. Omitted: rows show no profile link. */
  onOpenProfile?: (id: string) => void;
}

/** Whether this row's profile can be opened by the viewer (UI only; the API decides). */
export const profileOpenable = (c: Candidate, caps: readonly string[]) => caps.includes("candidate:read") && c.canOpenProfile !== false;

export function CandidateName({ c, caps, onOpenProfile }: { c: Candidate; caps: readonly string[]; onOpenProfile?: (id: string) => void }) {
  if (onOpenProfile && profileOpenable(c, caps)) {
    return (
      <button type="button" className="linkbtn" onClick={() => onOpenProfile(c.id)} aria-label={`Open profile of ${c.name}`}>
        <b>{c.name}</b>
      </button>
    );
  }
  return (
    <>
      <b>{c.name}</b>
      {c.canOpenProfile === false && caps.includes("candidate:read") && <small className="block">Profile belongs to another team</small>}
    </>
  );
}

export function HotListPage({ me, onOpenProfile }: ListPageProps) {
  const caps = me?.capabilities ?? [];
  const s = useCandidateList("hotlist");
  const [preview, setPreview] = useState<Candidate | null>(null);
  const items = s.q.data?.items ?? [];
  const canStatus = caps.includes("candidate:update");
  const canVisibility = caps.includes("candidate.visibility:update");
  const canBulk = canStatus || canVisibility;
  const canExport = caps.includes("report:export");
  // Selection covers the rows on this page; a new page or filter starts empty.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const data = s.q.data;
  useEffect(() => setSelected(new Set()), [data]);
  /** Rows the viewer cannot act on (profile in another team) are not selectable; the server would refuse them. */
  const selectable = items.filter((c) => c.canOpenProfile !== false);
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.id));
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const cols = canBulk ? 11 : 10;

  return (
    <>
      <div>
        <h1 tabIndex={-1}>Hot List</h1>
        <p className="sub">Candidates ready for marketing. Phones are shown only for candidates in your scope; others are masked.</p>
      </div>
      <SavedViews s={s} />
      <ListFilters s={s} label="Hot List" statuses={HOTLIST_STATUS_OPTIONS} />
      {canExport && <ExportButton s={s} />}
      {canBulk && (
        <BulkBar selected={selected} items={items} canStatus={canStatus} canVisibility={canVisibility}
          onDone={() => setSelected(new Set())} />
      )}
      <div className="card tablewrap">
        {s.q.isLoading ? <p className="empty">Loading…</p> : s.q.error ? <p className="empty error" role="alert">{salesError(s.q.error)}</p> : (
          <table aria-label="Hot List" aria-busy={s.q.isFetching || undefined}>
            <thead><tr>
              {canBulk && (
                <th>
                  <input type="checkbox" aria-label="Select all candidates on this page" checked={allSelected}
                    disabled={selectable.length === 0}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((c) => c.id)))} />
                </th>
              )}
              <th>Candidate</th><th>Technology</th><th>Status</th><th>Pri</th><th>Team</th><th>Recruiter</th><th>Location</th><th>Phone</th>
              <th>Days</th><th><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  {canBulk && (
                    <td>
                      <input type="checkbox" aria-label={`Select ${c.name}`} checked={selected.has(c.id)}
                        disabled={c.canOpenProfile === false} onChange={() => toggle(c.id)} />
                    </td>
                  )}
                  <td><CandidateName c={c} caps={caps} onOpenProfile={onOpenProfile} /></td>
                  <td>{c.technology}</td>
                  <td><StatusBadge status={c.status} />{" "}{c.visibility === "all_teams" && <OpenToAllBadge />}</td>
                  <td><Priority p={c.priority} /></td>
                  <td>{c.team.name}</td>
                  <td>{c.recruiter?.name ?? "Unassigned"}</td>
                  <td>{c.location.name}</td>
                  <td className={c.phoneMasked ? "masked" : ""}><Phone c={c} /></td>
                  <td>{c.daysInMarket ?? "—"}</td>
                  <td className="rowactions">
                    <button type="button" className="btn sm" aria-label={`Quick view of ${c.name}`} onClick={() => setPreview(c)}>Quick view</button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={cols} className="empty">{s.hasFilters ? "No candidates match these filters." : "No candidates on the Hot List."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <ListFooter s={s} label="Hot List" />

      {preview && (
        <Drawer title={preview.name} onClose={() => setPreview(null)}>
          <dl className="facts">
            <dt>Technology</dt><dd>{preview.technology}</dd>
            <dt>Status</dt><dd><StatusBadge status={preview.status} /></dd>
            <dt>Visibility</dt><dd>{preview.visibility === "all_teams" ? <OpenToAllBadge /> : "Team only"}</dd>
            <dt>Priority</dt><dd><Priority p={preview.priority} /></dd>
            <dt>Team</dt><dd>{preview.team.name}</dd>
            <dt>Recruiter</dt><dd>{preview.recruiter?.name ?? "Unassigned"}</dd>
            <dt>Location</dt><dd>{preview.location.name}</dd>
            <dt>Phone</dt><dd><Phone c={preview} /></dd>
            <dt>Marketing since</dt><dd>{fmtDate(preview.marketingStartDate)}</dd>
            <dt>Days in market</dt><dd>{preview.daysInMarket ?? "—"}</dd>
            <dt>Technical rating</dt><dd>{preview.technicalRating ? `${preview.technicalRating} / 5` : "Not rated"}</dd>
          </dl>
          {onOpenProfile && profileOpenable(preview, caps) ? (
            <button type="button" className="btn primary" data-autofocus onClick={() => { const id = preview.id; setPreview(null); onOpenProfile(id); }}>
              Open full profile
            </button>
          ) : preview.canOpenProfile === false && caps.includes("candidate:read") ? (
            <p className="note">Profile belongs to another team. Only list details are shown here.</p>
          ) : null}
        </Drawer>
      )}
    </>
  );
}
