import { useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { fmtDate } from "../sales/ui";
import { Person } from "../shell/ui";
import { applicationError, applicationKeys, applicationsApi } from "./applicationsApi";
import "./jobs.css";

/** Applicants (applicant:read, HR): portal accounts; phones need applicant.phone:read (masked otherwise). */
export function ApplicantsPage() {
  const id = useId();
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [notice, setNotice] = useState("");
  const page = cursors.length - 1;
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchText.trim()); setCursors([null]); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);
  const filters = { search, cursor: cursors[page] ?? "", limit: 50 };
  const q = useQuery({ queryKey: [...applicationKeys.applicants, filters], queryFn: () => applicationsApi.applicants(filters), placeholderData: keepPreviousData });
  const items = q.data?.items ?? [];
  return (
    <>
      <div className="pagehead">
        <div style={{ flex: 1 }}>
          <h1 tabIndex={-1}>Applicants</h1>
          <p className="sub">People with a careers portal account.</p>
        </div>
        <button type="button" className="btn" onClick={async () => {
          try { const r = await applicationsApi.exportApplicants({ search }); setNotice(`Exported ${r.rows} applicants${r.truncated ? " (first 5,000 only)" : ""}.`); }
          catch (e) { setNotice(applicationError(e)); }
        }}><Download size={16} aria-hidden="true" /> Export</button>
      </div>
      <form className="filters" role="search" aria-label="Applicant filters" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-q`}>Name or email</label>
            <input id={`${id}-q`} type="search" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
        </div>
      </form>
      <p role="status" aria-live="polite" className="livemsg">{notice}</p>
      <div className="card tablewrap">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="empty error" role="alert">{applicationError(q.error)}</p> : (
          <div className="tablewrap"><table aria-label="Applicants">
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Email verified</th><th>Applications</th><th>Signed up</th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td><Person name={a.name}><b>{a.name}</b></Person></td>
                  <td>{a.email}</td>
                  <td>{a.phone ? <span className={a.phoneMasked ? "masked" : undefined}>{a.phone}</span> : <span className="muted">—</span>}</td>
                  <td>{a.emailVerified ? "Yes" : "No"}</td>
                  <td>{a.applications}</td>
                  <td>{fmtDate(a.createdAt)}</td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={6} className="empty">{search ? "No applicants match." : "No applicants yet."}</td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
      <div className="listfoot">
        <span />
        <nav className="pager" aria-label="Applicant pages">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="btn sm" disabled={!q.data?.nextCursor || q.isPlaceholderData}
            onClick={() => { const nx = q.data?.nextCursor; if (nx) setCursors((c) => [...c, nx]); }}>Next</button>
        </nav>
      </div>
    </>
  );
}
