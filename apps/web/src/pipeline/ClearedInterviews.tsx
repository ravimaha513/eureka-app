import { useEffect } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Interview } from "../interviews/InterviewsPage";
import { navigate } from "../lib/router";
import { screenPath } from "../nav";
import { Pager, useCursorPager } from "../ui/Pager";
import { RecordLink } from "../ui/RecordLink";
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
export function ClearedInterviews({ teamId, candidate, batchId, onOpenPlacement, canOpenCandidate = false }: {
  teamId: string; candidate: string; batchId: string; onOpenPlacement: (id: string) => void;
  /** Link candidate names to their profile (candidate:read). */
  canOpenCandidate?: boolean;
}) {
  const pager = useCursorPager();
  const { reset } = pager;
  useEffect(() => { reset(); }, [teamId, candidate, batchId, reset]);
  const filters = { result: "cleared", sort: "desc", teamId, candidate, batchId, cursor: pager.cursor ?? "", limit: PAGE_SIZE };
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
      <div className="card tablewrap listcard">
        {q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={pipelineError(q.error)} />
        ) : (
          <table className="dtable" aria-label="Cleared interviews" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th>Candidate</th><th>Client / position</th><th>Round</th><th>Cleared on</th><th className="p2">Recruiter / team</th><th>Next step</th>
              <th className="c-act"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((i: Interview) => (
                <tr key={i.id}>
                  <td className="c-primary"><RecordLink kind="candidate" id={i.candidate.id} allowed={canOpenCandidate}><b>{i.candidate.name ?? "Candidate"}</b></RecordLink></td>
                  <td data-label="Client"><span>{i.client?.name ?? "—"}{i.position && <small className="block muted">{i.position}</small>}</span></td>
                  <td data-label="Round"><span>{i.round}<small className="block muted">{fmtDateTime(i.startsAt)}</small></span></td>
                  <td data-label="Cleared on">{i.resultAt ? fmtDateTime(i.resultAt) : "—"}</td>
                  <td className="p2" data-label="Recruiter"><span>{i.recruiter.name}<small className="block muted">{i.team?.name ?? "No team"}</small></span></td>
                  <td data-label="Next step">
                    {i.placement
                      ? <RecordLink kind="placement" id={i.placement.id} onOpen={onOpenPlacement}>Placement: {pipelineLabel(i.placement.status)}</RecordLink>
                      : i.submissionStatus ? <span>Submission <PipelineStatus status={i.submissionStatus} /></span> : "—"}
                  </td>
                  <td className="c-act">
                    <a className="btn sm" href={screenPath("interviews", i.id)} aria-label={`Open the ${i.round} interview of ${i.candidate.name ?? "the candidate"}`}
                      onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(screenPath("interviews", i.id)); } }}>Open interview</a>
                  </td>
                </tr>
              ))}
              {!items.length && <tr><td colSpan={7} className="empty">{teamId || candidate || batchId ? "No cleared interviews match these filters." : "No cleared interviews yet. Mark a round's result as Cleared on the Interviews board."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <Pager pager={pager} label="Cleared interview pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>
    </>
  );
}
