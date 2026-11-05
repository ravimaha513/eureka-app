import { useEffect, useState, type ReactNode } from "react";
import { Person } from "../shell/ui";
import type { Permission } from "@eureka/shared";
import type { Candidate, Me } from "../api";
import { salesError } from "./errors";
import { BulkBar, ExportButton, SavedViews } from "./HotListExtras";
import { ListFilters, ListFooter, resultCount } from "./ListControls";
import { useQuery } from "@tanstack/react-query";
import { HOTLIST_STATUS_OPTIONS, hotlistApi, salesKeys } from "./salesApi";
import { Drawer, OpenToAllBadge, SharedBadge, Phone, Priority, StatusBadge, fmtDate } from "./ui";
import { documentsLabel, stayLabel, visaLabel } from "./candidateFields";
import { useCandidateList } from "./useCandidateList";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";

export interface ListPageProps {
  me?: Pick<Me, "id" | "capabilities">;
  /** Opens the full candidate profile. Omitted: rows show no profile link. */
  onOpenProfile?: (id: string) => void;
}

/** Whether this row's profile can be opened by the viewer (UI only; the API decides). */
export const profileOpenable = (c: Candidate, caps: readonly Permission[]) => caps.includes("candidate:read") && c.canOpenProfile !== false;

export function CandidateName({ c, caps, onOpenProfile, plain = false }: {
  c: Candidate; caps: readonly Permission[]; onOpenProfile?: (id: string) => void;
  /** Dense lists: no avatar, the name alone. */
  plain?: boolean;
}) {
  const Wrap = plain ? PlainName : Person;
  if (onOpenProfile && profileOpenable(c, caps)) {
    return (
      <Wrap name={c.name}>
        <button type="button" className="linkbtn" onClick={() => onOpenProfile(c.id)} aria-label={`Open profile of ${c.name}`}>
          <b>{c.name}</b>
        </button>
      </Wrap>
    );
  }
  return (
    <Wrap name={c.name}>
      <b>{c.name}</b>
      {c.canOpenProfile === false && caps.includes("candidate:read") && <small className="block">Profile belongs to another team</small>}
    </Wrap>
  );
}

const PlainName = ({ children }: { name: string; children: ReactNode }) => <span className="persontext">{children}</span>;

/** Clicks on a row open the profile, except on its own controls (checkbox, links, buttons). */
const fromControl = (e: React.MouseEvent) => Boolean((e.target as HTMLElement).closest("a, button, input, select, label, textarea"));

export function HotListPage({ me, onOpenProfile }: ListPageProps) {
  const caps = me?.capabilities ?? [];
  const s = useCandidateList("hotlist");
  const options = useQuery({ queryKey: [...salesKeys.hotlist, "filter-options"], queryFn: hotlistApi.filterOptions, staleTime: 5 * 60_000 });
  const [preview, setPreview] = useState<Candidate | null>(null);
  const items = s.q.data?.items ?? [];
  const canStatus = caps.includes("candidate:update");
  const canVisibility = caps.includes("candidate.visibility:update");
  const canBulk = canStatus || canVisibility;
  const canExport = caps.includes("report:export");
  // Selection survives paging (bulk changes often span pages) but a new filter starts it empty.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const filterKey = JSON.stringify(s.applied);
  useEffect(() => setSelected(new Set()), [filterKey]);
  /** Rows the viewer cannot act on (profile in another team) are not selectable; the server would refuse them. */
  const selectable = items.filter((c) => c.canOpenProfile !== false);
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.id));
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const cols = canBulk ? 14 : 13;
  const yesNo = (v: boolean | null | undefined) => (v === true ? "Yes" : v === false ? "No" : "—");

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Hot List{resultCount(s) && <span className="h1count" aria-label={`, ${resultCount(s)} candidates`}>{resultCount(s)}</span>}</h1>
          <p className="sub">Your team's candidates and every candidate open to all teams. Phones show only for candidates in your scope.</p>
        </div>
        <div className="pageactions">
          <SavedViews s={s} />
          {canExport && <ExportButton s={s} />}
        </div>
      </div>
      <ListFilters s={s} label="Hot List" statuses={HOTLIST_STATUS_OPTIONS} options={options.data} selecting={canBulk && selected.size > 0}
        selection={canBulk && (
          <BulkBar selected={selected} items={items} canStatus={canStatus} canVisibility={canVisibility}
            onDone={() => setSelected(new Set())} />
        )} />
      <div className="card tablewrap listcard">
        {s.q.isLoading ? <Loading /> : s.q.error ? <QueryError query={s.q} message={salesError(s.q.error)} /> : (
          <table className="cardtable hotlist" aria-label="Hot List" aria-busy={s.q.isFetching || undefined}>
            <thead><tr>
              {canBulk && (
                <th className="c-sel">
                  <input type="checkbox" aria-label="Select all candidates on this page" checked={allSelected}
                    disabled={selectable.length === 0}
                    onChange={() => setSelected((prev) => {
                      const next = new Set(prev);
                      for (const c of selectable) { if (allSelected) next.delete(c.id); else next.add(c.id); }
                      return next;
                    })} />
                </th>
              )}
              <th>Candidate</th><th>Technology</th><th>Status</th><th>Pri</th><th>Team</th><th className="p3">Lead</th><th>Recruiter</th>
              <th className="p2">Location</th><th className="p2">Visa</th><th className="p3">Stay</th><th className="p3">In person</th>
              <th>Phone</th><th className="num">Days</th><th className="c-act"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((c) => {
                const openable = Boolean(onOpenProfile) && profileOpenable(c, caps);
                return (
                <tr key={c.id} aria-selected={canBulk ? selected.has(c.id) : undefined} className={openable ? "rowopen" : undefined}
                  onClick={openable ? (e) => { if (!fromControl(e)) onOpenProfile!(c.id); } : undefined}>
                  {canBulk && (
                    <td className="c-sel">
                      <input type="checkbox" aria-label={`Select ${c.name}`} checked={selected.has(c.id)}
                        disabled={c.canOpenProfile === false} onChange={() => toggle(c.id)} />
                    </td>
                  )}
                  <td className="c-name">
                    <CandidateName c={c} caps={caps} onOpenProfile={onOpenProfile} plain />
                  </td>
                  <td className="c-tech">{c.technology}</td>
                  <td className="c-status">
                    <span className="badges"><StatusBadge status={c.status} />
                      {c.visibility === "all_teams" && <OpenToAllBadge />}{c.visibility === "selected_teams" && <SharedBadge />}</span>
                    {c.statusLabel && c.statusLabel.includes("/") && !/\/all teams$/i.test(c.statusLabel) && <small className="block">{c.statusLabel}</small>}
                  </td>
                  <td className="c-pri"><Priority p={c.priority} /></td>
                  <td className="c-team" title={c.team.lead ? `Lead: ${c.team.lead}` : undefined}>{c.team.name}{c.team.lead && <span className="leadnote">, lead {c.team.lead}</span>}</td>
                  <td className="p3">{c.team.lead ?? "—"}</td>
                  <td className="c-rec">{c.recruiter?.name ?? <span className="muted">Unassigned</span>}</td>
                  <td className="p2">{c.location.name}</td>
                  <td className="p2">{c.visaCategory ? visaLabel(c.visaCategory) : "—"}</td>
                  <td className="p3">{c.stay ? stayLabel(c) : "—"}</td>
                  <td className="p3">{yesNo(c.inPersonOk)}</td>
                  <td className={`c-phone${c.phoneMasked ? " masked" : ""}`}><Phone c={c} /></td>
                  <td className="c-days num">{c.daysInMarket != null ? <>{c.daysInMarket}<span className="cardonly"> days</span></> : "—"}</td>
                  <td className="c-act">
                    <button type="button" className="btn sm" aria-label={`Quick view of ${c.name}`} onClick={() => setPreview(c)}>View</button>
                  </td>
                </tr>
                );
              })}
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
            <dt>Status</dt><dd><StatusBadge status={preview.status} />{preview.statusLabel && <> {preview.statusLabel}</>}</dd>
            <dt>Visibility</dt><dd>{preview.visibility === "all_teams" ? <OpenToAllBadge /> : preview.visibility === "selected_teams" ? <SharedBadge /> : "Team only"}</dd>
            <dt>Priority</dt><dd><Priority p={preview.priority} /></dd>
            <dt>Team</dt><dd>{preview.team.name}</dd>
            <dt>Lead</dt><dd>{preview.team.lead ?? "—"}</dd>
            <dt>Recruiter</dt><dd>{preview.recruiter?.name ?? "Unassigned"}</dd>
            <dt>Location</dt><dd>{preview.location.name}</dd>
            <dt>Stay</dt><dd>{stayLabel(preview)}</dd>
            <dt>In person</dt><dd>{yesNo(preview.inPersonOk)}</dd>
            <dt>Visa</dt><dd>{visaLabel(preview.visaCategory)}</dd>
            <dt>Documents</dt><dd>{documentsLabel(preview.documentsStatus)}</dd>
            {preview.hasResume !== undefined && <><dt>Resume</dt><dd>{preview.hasResume ? "On file" : "None"}</dd></>}
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
