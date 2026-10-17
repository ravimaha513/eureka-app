/** A failed list or report load: the message, announced, with a Retry that refetches the query. */
export function QueryError({ query, message }: { query: { refetch: () => Promise<unknown> }; message: string }) {
  return (
    <p className="empty error" role="alert">{message} <button type="button" className="btn sm" onClick={() => void query.refetch()}>Retry</button></p>
  );
}
