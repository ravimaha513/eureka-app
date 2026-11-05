import { useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { fmtDate } from "../sales/ui";
import { Person } from "../shell/ui";
import { useSearchParams } from "../lib/router";
import { applicationError, applicationKeys, applicationsApi } from "./applicationsApi";
import { Pager, useCursorPager } from "../ui/Pager";
import { NoticeLine, ScreenLink, displayPhone, type Notice } from "./hiringUi";
import "./jobs.css";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";

/** Applications searched by the applicant's name (the applications search matches names). */
const applicationsOf = (name: string) => `/applications?q=${encodeURIComponent(name)}`;

/** Applicants (applicant:read, HR): portal accounts; phones need applicant.phone:read (masked otherwise). */
export function ApplicantsPage() {
  const id = useId();
  const [params, setParams] = useSearchParams(["q"] as const);
  const search = params.q;
  const [searchText, setSearchText] = useState(search);
  const pager = useCursorPager();
  const { page } = pager;
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    // Only a changed search resets paging; otherwise the mount-time run would undo an early Next.
    if (searchText.trim() === search) return;
    const t = setTimeout(() => { setParams({ q: searchText.trim() }); pager.reset(); }, 300);
    return () => clearTimeout(t);
  }, [searchText, search]);
  const filters = { search, cursor: pager.cursor ?? "", limit: 50 };
  const q = useQuery({ queryKey: [...applicationKeys.applicants, filters], queryFn: () => applicationsApi.applicants(filters), placeholderData: keepPreviousData });
  const items = q.data?.items ?? [];
  const n = items.length;
  const count = q.isLoading || q.error ? "" : `${n}${q.data?.nextCursor ? "+" : ""}`;
  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Applicants{count && <span className="h1count" aria-label={`, ${count} applicants`}>{count}</span>}</h1>
          <p className="sub">People with a careers portal account. Open a person to see their applications.</p>
        </div>
        <div className="pageactions">
          <button type="button" className="btn" onClick={async () => {
            try { const r = await applicationsApi.exportApplicants({ search }); setNotice({ tone: "ok", text: `Exported ${r.rows} applicants${r.truncated ? " (first 5,000 only)" : ""}.` }); }
            catch (e) { setNotice({ tone: "error", text: applicationError(e) }); }
          }}><Download size={16} aria-hidden="true" /> Export</button>
        </div>
      </div>
      {/* One search field only, so no Filters sheet: the Hot List filter row markup without the FilterBar toggles. */}
      <div className="filterbar">
        <form className="fb-row" role="search" aria-label="Applicant filters" onSubmit={(e) => e.preventDefault()}>
          <div className="field inline fb-search">
            <label htmlFor={`${id}-q`}>Name or email</label>
            <input id={`${id}-q`} type="search" placeholder="Search name or email" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
          {search && <button type="button" className="btn ap-clear" onClick={() => { setSearchText(""); setParams({ q: "" }); pager.reset(); }}>Clear</button>}
        </form>
      </div>
      <NoticeLine notice={notice} />
      <div className="card tablewrap listcard">
        {q.isLoading ? <Loading /> : q.error ? <QueryError query={q} message={applicationError(q.error)} /> : (
          <table className="dtable applicantstable" aria-label="Applicants" aria-busy={q.isFetching || undefined}>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th className="num">Applications</th><th>Signed up</th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="c-primary">
                    <Person name={a.name}>{a.name && a.applications > 0
                      ? <ScreenLink href={applicationsOf(a.name)} label={`Applications of ${a.name}`}><b>{a.name}</b></ScreenLink>
                      : <b>{a.name}</b>}</Person>
                  </td>
                  <td data-label="Email">
                    <div><span className="ap-email">{a.email}</span>
                      {!a.emailVerified && <> <span className="badge unverified">Unverified</span></>}</div>
                  </td>
                  <td data-label="Phone">{a.phone ? <span className={a.phoneMasked ? "masked" : undefined}>{a.phoneMasked ? a.phone : displayPhone(a.phone)}</span> : <span className="muted">—</span>}</td>
                  <td className="num" data-label="Applications">
                    {a.name && a.applications > 0
                      ? <ScreenLink href={applicationsOf(a.name)} label={`${a.applications} ${a.applications === 1 ? "application" : "applications"} of ${a.name}`}>{a.applications}</ScreenLink>
                      : <span className="muted">0</span>}
                  </td>
                  <td data-label="Signed up">{fmtDate(a.createdAt)}</td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={5} className="empty">{search ? "No applicants match." : "No applicants yet."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{q.isLoading || q.error ? "" : `${n} ${n === 1 ? "applicant" : "applicants"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`}</p>
        <Pager pager={pager} label="Applicant pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>
    </>
  );
}
