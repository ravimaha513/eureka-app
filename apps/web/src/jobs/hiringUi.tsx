import { useId, type MouseEvent, type ReactNode } from "react";
import { navigate } from "../lib/router";

/** A click that landed on a control inside a row (link, button, field) must not also open the row. */
export const fromControl = (e: MouseEvent) => Boolean((e.target as HTMLElement).closest("a, button, input, select, label, textarea"));

/**
 * A link to another screen with a query string (e.g. a job's applications, `/applications?jobId=…`).
 * Real <a href> so Ctrl/middle-click open a new tab; a plain left click navigates in-app.
 */
export function ScreenLink({ href, children, label, className }: { href: string; children: ReactNode; label?: string; className?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} className={className ?? "recordlink"} aria-label={label} onClick={onClick}>{children}</a>;
}

/** Outcome of a page action (export): success in the polite live region, failure as an alert. */
export type Notice = { tone: "ok" | "error"; text: string } | null;
export function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <>
      <p role="status" aria-live="polite" className="livemsg hiring-inline">{notice?.tone === "ok" ? notice.text : ""}</p>
      {notice?.tone === "error" && <p role="alert" className="livemsg error hiring-inline">{notice.text}</p>}
    </>
  );
}

/**
 * Several people as a checkbox list (replaces a Ctrl/Cmd multi-select, which touch screens cannot use).
 * Keeps the order of `people`; at most `max` can be chosen.
 */
export function PeoplePicker({ legend, hint, people, value, onChange, max = 10 }: {
  legend: string; hint?: string; people: readonly { id: string; name: string | null }[]; value: string[]; onChange: (ids: string[]) => void; max?: number;
}) {
  const id = useId();
  const full = value.length >= max;
  return (
    <fieldset className="peoplepicker" aria-describedby={hint ? `${id}-h` : undefined}>
      <legend>{legend}{value.length > 0 && <span className="pp-count"> · {value.length} chosen</span>}</legend>
      {hint && <small id={`${id}-h`} className="hint">{hint}</small>}
      {people.length === 0 ? <p className="muted">No people to choose from.</p> : (
        <div className="pp-list">
          {people.map((p) => {
            const on = value.includes(p.id);
            return (
              <label key={p.id} className="check">
                <input type="checkbox" checked={on} disabled={!on && full}
                  onChange={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])} />
                {p.name ?? "Unnamed"}
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

/** "+12125550123" → "+1 212 555 0123" for reading (US/Canada numbers only; masked or other numbers unchanged). */
export function displayPhone(p: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : p;
}
