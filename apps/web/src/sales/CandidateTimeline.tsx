import { useInfiniteQuery } from "@tanstack/react-query";
import { salesError } from "./errors";
import { describeEvent, salesApi, salesKeys } from "./salesApi";

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Candidate timeline (GET /api/v1/candidates/:id/timeline, FR-CAN-10), newest
 * first. The server lists only events the user may see: submission, interview
 * and placement events appear only when that record is visible to them.
 */
export function CandidateTimeline({ id }: { id: string }) {
  const q = useInfiniteQuery({
    queryKey: salesKeys.timeline(id),
    queryFn: ({ pageParam }) => salesApi.timeline(id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className="card pad" aria-labelledby="timeline-h">
      <h2 id="timeline-h">Timeline</h2>
      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error" role="alert">{salesError(q.error)}</p>
        : items.length === 0 ? <p className="muted">No activity recorded yet.</p>
        : (
          <ol className="timeline" aria-label="Candidate activity, newest first">
            {items.map((e) => (
              <li key={e.id}>
                <span>{describeEvent(e)}</span>
                <small className="muted">
                  {" "}· <time dateTime={e.at}>{fmt(e.at)}</time>{e.actor?.name ? ` · ${e.actor.name}` : ""}
                </small>
              </li>
            ))}
          </ol>
        )}
      {q.hasNextPage && (
        <button type="button" className="btn sm" disabled={q.isFetchingNextPage} aria-busy={q.isFetchingNextPage || undefined}
          onClick={() => void q.fetchNextPage()}>
          Show older activity
        </button>
      )}
    </section>
  );
}
