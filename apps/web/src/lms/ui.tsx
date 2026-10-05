import type { ReactNode } from "react";
import { statusLabel } from "./lmsApi";

/** A labelled progress bar (role=progressbar); `label` names it for assistive tech. */
export function ProgressBar({ percent, label, small }: { percent: number; label: string; small?: boolean }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <span className={small ? "lmsbar sm" : "lmsbar"}>
      <span className="lmstrack" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}>
        <span className="lmsfill" style={{ width: `${p}%` }} />
      </span>
      <span className="lmspct" aria-hidden="true">{p}%</span>
    </span>
  );
}

export const BatchStatusChip = ({ status }: { status: string }) => <span className={`badge lms-${status}`}>{statusLabel(status)}</span>;

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <div className="lmsstat"><small>{label}</small><b>{children}</b></div>;
}

export function StatusFilter({ value, onChange, statuses }: { value: string; onChange: (v: string) => void; statuses: readonly string[] }) {
  return (
    <div className="chipfilter">
      <span id="lms-status-label" className="chiplabel">Status</span>
      <div className="tabs wrap" role="group" aria-labelledby="lms-status-label">
        <button type="button" className="tab" aria-pressed={value === ""} onClick={() => onChange("")}>All</button>
        {statuses.map((s) => (
          <button key={s} type="button" className="tab" aria-pressed={value === s} onClick={() => onChange(value === s ? "" : s)}>{statusLabel(s)}</button>
        ))}
      </div>
    </div>
  );
}
