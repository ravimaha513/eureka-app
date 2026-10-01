import { useId } from "react";
import { pipelineLabel } from "./pipelineApi";

/** Status chip for submissions and placements (colour by status class, text always present). */
export const PipelineStatus = ({ status }: { status: string }) => <span className={`badge st-${status}`}>{pipelineLabel(status)}</span>;

export const FirstPlacementBadge = () => <span className="badge first">First placement</span>;

/** Single-choice status filter as toggle chips ("All" plus each status). */
export function StatusChips({ label, statuses, value, onChange }: {
  label: string; statuses: readonly string[]; value: string; onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="chipfilter">
      <span id={id} className="chiplabel">{label}</span>
      <div className="tabs wrap" role="group" aria-labelledby={id}>
        <button type="button" className="tab" aria-pressed={value === ""} onClick={() => onChange("")}>All</button>
        {statuses.map((s) => (
          <button key={s} type="button" className="tab" aria-pressed={value === s} onClick={() => onChange(value === s ? "" : s)}>
            {pipelineLabel(s)}
          </button>
        ))}
      </div>
    </div>
  );
}
