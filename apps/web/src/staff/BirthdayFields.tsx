import { MONTH_NAMES, isValidBirthday, type Birthday } from "@eureka/shared";

/** Month select and day input for a birthday (no year). Controlled through `value`; empty = none. */
export function BirthdayFields({ value, onChange, idPrefix, disabled }: {
  value: Birthday | null; onChange: (b: Birthday | null) => void; idPrefix: string; disabled?: boolean;
}) {
  const month = value?.month ?? 0;
  const day = value?.day ?? 0;
  const set = (m: number, d: number) => onChange(m && d ? { month: m, day: d } : m || d ? { month: m, day: d } : null);
  const invalid = value !== null && !isValidBirthday(value);
  return (
    <div className="rowactions birthdayfields">
      <label className="sr-only" htmlFor={`${idPrefix}-m`}>Birthday month</label>
      <select id={`${idPrefix}-m`} value={month} disabled={disabled} aria-invalid={invalid || undefined} onChange={(e) => set(Number(e.target.value), day)}>
        <option value={0}>Month</option>
        {MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
      </select>
      <label className="sr-only" htmlFor={`${idPrefix}-d`}>Birthday day</label>
      <input id={`${idPrefix}-d`} type="number" min={1} max={31} placeholder="Day" value={day || ""} disabled={disabled} aria-invalid={invalid || undefined}
        style={{ minWidth: 80, width: 80 }} onChange={(e) => set(month, Number(e.target.value) || 0)} />
    </div>
  );
}
