import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Interview } from "../interviews/InterviewsPage";
import { navigate } from "../lib/router";
import { screenPath } from "../nav";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import { pipelineError } from "./errors";
import { fmtDateTime, pipelineApi, pipelineKeys, pipelineLabel } from "./pipelineApi";
import { PipelineStatus } from "./ui";

const PAGE_SIZE = 50;

/**
 * Placements → Cleared interviews (migration 0360): rounds whose result is
 * "cleared", latest first, in the caller's interview scope (a team lead sees
 * their team; Manager, AD and CEO every team, narrowed by the Team filter).
 */
export function ClearedInterviews({ teamId, onOpenPlacement }: { teamId: string; onOpenPlacement: (id: string) => void }) {
  const pager = useCursorPager();
  const filters = { result: "cleared", sort: "desc", teamId, cursor: pager.cursor ?? "", limit: PAGE_SIZE };
  const q = useQuery({
    queryKey: [...pipelineKeys.placements, "cleared", filters],
    queryFn: () => pipelineApi.clearedInterviews(filters),
    placeholderData: keepPreviousData,
  });
  const items = q.data?.items ?? [];
  const n = items.length;
  const countMsg = q.isLoading || q.error ? ""
    : `${n} cleared ${n === 1 ? "interview" : "interviews"} on page ${pager.page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;

  return (
    <>
      <div className="card tablewrap">
        {q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={pipelineError(q.error)} />
        ) : (
            <div className="tablewrap">
              <table aria-label="Cleared interviews" aria-busy={q.isFetching || undefined}>
                <thead><tr>
                  <th>Candidate</th><th>Client / position</th><th>Round</th><th>Cleared on</th><th>Recruiter / team</th><th>Next step</th>
                </tr></thead>
                <tbody>
                  {items.map((i: Interview) => (
                    <tr key={i.id}>
                      <td><b>{i.candidate.name ?? "Candidate"}</b></td>
                      <td>{i.client?.name ?? "—"}{i.position && <span className="block">{i.position}</span>}</td>
                      <td>{i.round}<span className="block">{fmtDateTime(i.startsAt)}</span></td>
                      <td>{i.resultAt ? fmtDateTime(i.resultAt) : "—"}</td>
                      <td>{i.recruiter.name}<span className="block">{i.team?.name ?? "No team"}</span></td>
                      <td>
                        {i.placement
                          ? <button type="button" className="linkbtn" onClick={() => onOpenPlacement(i.placement!.id)}>Placement: {pipelineLabel(i.placement.status)}</button>
                          : i.submissionStatus ? <>Submission <PipelineStatus status={i.submissionStatus} /></> : "—"}
                        <span className="block">
                          <button type="button" className="linkbtn" onClick={() => navigate(screenPath("interviews", i.id))}>Open interview</button>
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!items.length && <tr><td colSpan={6} className="empty">No cleared interviews yet. Mark a round's result as Cleared on the Interviews board.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <Pager pager={pager} label="Cleared interview pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>
    </>
  );
}
