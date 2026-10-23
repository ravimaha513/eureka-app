import { useState } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

/** A failed list or report load: the message, announced, with a Retry that refetches the query. */
export function QueryError({ query, message }: { query: { refetch: () => Promise<unknown> }; message: string }) {
  const [busy, setBusy] = useState(false);
  const retry = () => { setBusy(true); void query.refetch().finally(() => setBusy(false)); };
  return (
    <div className="queryerror" role="alert">
      <span className="queryerror-icon" aria-hidden="true"><TriangleAlert size={18} /></span>
      <p>{message}</p>
      <button type="button" className="btn sm" onClick={retry} disabled={busy} aria-busy={busy || undefined}>
        <RotateCw size={14} aria-hidden="true" className={busy ? "spin" : undefined} />Retry
      </button>
    </div>
  );
}
