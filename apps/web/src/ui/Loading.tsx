/**
 * A list, report or screen that is still loading: a spinner with "Loading…", announced politely.
 * `page` fills the viewport (app boot, lazy screen chunks) instead of sitting inside a card.
 */
export function Loading({ label = "Loading…", page = false }: { label?: string; page?: boolean }) {
  return (
    <p className={page ? "loading page" : "loading"} role="status">
      <span className="spinner" aria-hidden="true" />{label}
    </p>
  );
}
