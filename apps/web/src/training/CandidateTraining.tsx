import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../api";
import { fmtDate } from "../sales/ui";
import { trainingApi, trainingError, trainingKeys } from "./trainingApi";
import { BatchStatusPill, ProgressBar } from "./ui";

/**
 * Training progress on a candidate profile (docs/training-api.md TR-11).
 * Shown to training:read holders whose scope covers the candidate or its batch;
 * the card stays hidden when the server refuses (403/404).
 */
export function CandidateTraining({ candidateId }: { candidateId: string }) {
  const id = useId();
  const q = useQuery({
    queryKey: trainingKeys.candidate(candidateId),
    queryFn: () => trainingApi.candidate(candidateId),
    retry: false,
  });
  if (q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404)) return null;
  return (
    <section className="card pad" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Training</h2>
      {q.isLoading ? <p className="muted">Loading…</p> : q.error ? <p className="muted">{trainingError(q.error)}</p>
        : !q.data?.batch ? <p className="muted">Not in a training batch.</p> : (
          <>
            <p>
              <b>{q.data.batch.name}</b> <BatchStatusPill status={q.data.batch.status} />
              <span className="block muted">{fmtDate(q.data.batch.startDate)}{q.data.batch.endDate ? ` – ${fmtDate(q.data.batch.endDate)}` : ""}</span>
            </p>
            <ProgressBar percent={q.data.percent ?? 0} label="Overall training progress" />
            {(q.data.courses ?? []).length > 0 && (
              <ul className="tr-cardcourses" aria-label="Progress per course">
                {q.data.courses!.map((c) => (
                  <li key={c.id}>
                    <span>{c.title} <small className="muted">{c.completedModules} of {c.totalModules} modules</small></span>
                    <ProgressBar percent={c.percent} label={`${c.title} progress`} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
    </section>
  );
}
