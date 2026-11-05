/**
 * The period presets shared by the insight screens (Dashboard, Performance): one segmented
 * group of toggle buttons ("Last 7 days", "Last 30 days", "Last 90 days"), aria-pressed on the
 * current one. `value` is null when a custom range is in use, so no preset is pressed.
 */
export const PRESET_DAYS = [7, 30, 90] as const;
export type PresetDays = (typeof PRESET_DAYS)[number];

export function PeriodPresets({ value, onChange, label = "Period", className }: {
  value: number | null;
  onChange: (days: PresetDays) => void;
  label?: string;
  className?: string;
}) {
  return (
    <div className={["tabs seg", className ?? ""].filter(Boolean).join(" ")} role="group" aria-label={label}>
      {PRESET_DAYS.map((d) => (
        <button key={d} type="button" className="tab" aria-pressed={value === d} onClick={() => onChange(d)}>Last {d} days</button>
      ))}
    </div>
  );
}
