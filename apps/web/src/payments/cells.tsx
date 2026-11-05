import { useId, type MouseEvent } from "react";
import { formatUsd } from "../lib/format";
import "./cells.css";

/**
 * One formatter for the back-office lists (Paperwork, Employees, Payments, Sites, DataHub):
 * calendar days, money and "due" dates, all tabular. Candidate for lib/format.ts (see shared_requests).
 */

/** A calendar day ("2026-11-02" or a timestamp) as "Nov 2, 2026" in the viewer's locale; "—" when empty. */
export const fmtDay = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

/** "$1,234.50"; "—" when empty. Accepts the API's numeric strings. */
export const fmtUsd = (v: number | string | null | undefined) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? formatUsd(n) : "—";
};

/** "+14695550001" → "+1 469 555 0001" (NANP); other numbers as stored. The tel: link keeps the raw value. */
export const fmtPhone = (raw: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(raw.replace(/[\s()-]/g, ""));
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : raw;
};

const localToday = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/** Whole days from today to a calendar day: negative when it is in the past. */
export function daysFromToday(iso: string): number {
  const day = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Math.round((day.getTime() - localToday().getTime()) / 86_400_000);
}

/** A due date: plain when ahead (or `done`); "· 3d overdue" in error red when past; "· in 5d" in warn when within `soonDays`. */
export function DueDate({ on, done = false, soonDays = 0, lateWord = "overdue" }: {
  on: string | null | undefined; done?: boolean; soonDays?: number; lateWord?: string;
}) {
  if (!on) return <span className="muted">—</span>;
  const d = daysFromToday(on);
  const late = !done && d < 0;
  const soon = !done && !late && soonDays > 0 && d <= soonDays;
  return (
    <span className={`duedate${late ? " late" : soon ? " soon" : ""}`}>
      <time dateTime={on.slice(0, 10)}>{fmtDay(on)}</time>
      {late && <span className="dueflag"> · {-d}d {lateWord}</span>}
      {soon && <span className="dueflag"> · {d === 0 ? "today" : `in ${d}d`}</span>}
    </span>
  );
}

/**
 * A filter toggle group (aria-pressed buttons in the segmented style): a filter, not navigation, so it
 * never looks like the underline tabs. Sits in a FilterBar as a labelled field.
 */
export function ToggleGroup<K extends string>({ label, options, value, onChange, className }: {
  label: string; options: readonly (readonly [K, string, number?])[]; value: K; onChange: (v: K) => void; className?: string;
}) {
  const id = useId();
  return (
    <div className={["field inline bo-toggles", className ?? ""].filter(Boolean).join(" ")}>
      <span id={id} className="bo-toggleslabel">{label}</span>
      <div className="tabs seg" role="group" aria-labelledby={id}>
        {options.map(([k, text, n]) => (
          <button key={k} type="button" className="tab" aria-pressed={value === k} onClick={() => onChange(k)}>
            {text}{n !== undefined && <span className="bo-togglecount">{n}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** True when a row click started on a control inside the row (so the row should not open). */
export const fromControl = (e: MouseEvent) => Boolean((e.target as HTMLElement).closest("a, button, input, select, label, textarea"));
