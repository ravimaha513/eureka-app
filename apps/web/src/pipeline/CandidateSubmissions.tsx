import { useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { SUBMISSION_STATUSES, fmtDateTime, fmtRate, pipelineApi, pipelineKeys } from "./pipelineApi";
import { pipelineError } from "./errors";
import { SubmissionDrawer, useDebounced } from "./SubmissionsPage";
import { PipelineFunnel, PipelineStatus, ReachedFilter, StageTrail, StatusChips, type Reached } from "./ui";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";

const PAGE_SIZE = 25;

/**
 * Submissions tab of a candidate profile: every submission of one candidate,
 * with the funnel (submitted -> interview -> screening/L1/L2/L3+/final -> placed),
 * per-status counts, each submission's interview trail and a job/client search.
 */
export function CandidateSubmissions({ candidateId, onOpenPlacement }: { candidateId: string; onOpenPlacement?: (id: string) => void }) {
  const id = useId();
  const [status, setStatusRaw] = useState("");
  const [reached, setReachedRaw] = useState<Reached>({ interviewed: "", stage: "" });
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput.trim());
  const pager = useCursorPager();
  const { reset } = pager;
  const setStatus = (v: string) => { setStatusRaw(v); reset(); };
  const setReached = (v: Reached) => { setReachedRaw(v); reset(); };
  useEffect(() => { reset(); }, [search, reset]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const summary = useQuery({
    queryKey: [...pipelineKeys.submissions, "summary", { candidateId, search }],
    queryFn: () => pipelineApi.submissionSummary({ candidateId, search }),
    placeholderData: keepPreviousData,
  });
  const filters = { candidateId, status, ...reached, search, cursor: pager.cursor ?? "", limit: PAGE_SIZE };
  const q = useQuery({
    queryKey: [...pipelineKeys.submissions, "list", filters],
    queryFn: () => pipelineApi.submissions(filters),
    placeholderData: keepPreviousData,
  });
  const items = q.data?.items ?? [];
  const showRate = items.some((s) => "rate" in s);
  const open = items.find((s) => s.id === openId) ?? null;
  const hasFilters = Boolean(status || reached.interviewed || reached.stage || search);
  const sum = summary.data;
  const cols = showRate ? 7 : 6;

  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="sr-only">Submissions</h2>
      {sum && <PipelineFunnel summary={sum} value={reached} onPick={setReached} />}

      <form className="filters" role="search" aria-label="Candidate submission filters" onSubmit={(e) => e.preventDefault()}>
        <StatusChips label="Status" statuses={SUBMISSION_STATUSES} value={status} onChange={setStatus}
          counts={sum?.byStatus} total={sum?.total} />
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-q`}>Job or client</label>
            <input id={`${id}-q`} type="search" placeholder="e.g. Java, Meta" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          </div>
          <ReachedFilter value={reached} onChange={setReached} />
          {hasFilters && (
            <button type="button" className="btn" onClick={() => { setStatusRaw(""); setReachedRaw({ interviewed: "", stage: "" }); setSearchInput(""); reset(); }}>Clear filters</button>
          )}
        </div>
      </form>

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <div className="card tablewrap">
        {q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={pipelineError(q.error)} />
        ) : (
          <div className="tablewrap"><table aria-label="Candidate submissions" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th>Job / client</th><th>Status</th><th>Interview rounds</th><th>Submitted</th><th>Recruiter</th>
              {showRate && <th>Rate</th>}
              <th><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.jobTitle}</b><span className="block">{s.client}</span></td>
                  <td><PipelineStatus status={s.status} /></td>
                  <td><StageTrail s={s} /></td>
                  <td>{fmtDateTime(s.submittedAt)}</td>
                  <td>{s.recruiterName ?? "—"}</td>
                  {showRate && <td>{"rate" in s ? fmtRate(s.rate) : <span className="muted">—</span>}</td>}
                  <td className="rowactions">
                    <button type="button" className="btn sm" onClick={() => setOpenId(s.id)}
                      aria-label={`Open submission for ${s.jobTitle} at ${s.client}`}>Open</button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={cols} className="empty">{hasFilters ? "No submissions match these filters." : "No submissions yet. Use Log submission to add one."}</td></tr>
              )}
            </tbody>
          </table></div>
        )}
      </div>
      <div className="listfoot">
        <p className="muted">{q.data ? `${items.length} on page ${pager.page + 1}${q.data.nextCursor ? ", more on the next page" : ""}.` : ""}</p>
        <Pager pager={pager} label="Candidate submission pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>

      {openId && (
        <SubmissionDrawer id={openId} initial={open} onClose={() => setOpenId(null)} onNotice={setNotice} onOpenPlacement={onOpenPlacement} />
      )}
    </section>
  );
}
