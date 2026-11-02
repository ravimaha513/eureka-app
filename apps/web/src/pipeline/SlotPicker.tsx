import { useId } from "react";

/** A slot as the picker holds it: local day (YYYY-MM-DD), local time (HH:MM) and length. */
export interface Slot { day: string; time: string; durationMin: number }

export const DURATIONS = [30, 45, 60, 90] as const;
const DAY_CHIPS = 5;
const FIRST_SLOT = 6 * 60;
const LAST_SLOT = 22 * 60 + 45;

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const at = (day: string, time: string) => new Date(`${day}T${time}:00`);

/** The slot's start as an instant, or null while day or time is missing. */
export function slotStart(s: Slot): Date | null {
  if (!s.day || !s.time) return null;
  const d = at(s.day, s.time);
  return Number.isNaN(+d) ? null : d;
}

const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "Today", "Tomorrow", then "Wed 4". */
function dayLabel(d: Date, i: number) {
  if (i === 0) return "Today";
  if (i === 1) return "Tomorrow";
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
}

/**
 * Interview slot: day chips for the coming week (plus any other date), a
 * 15-minute start list and duration chips, with the resulting window spelled
 * out underneath. Replaces two native datetime pickers.
 */
export function SlotPicker({ value, onChange, zone, errors = {} }: {
  value: Slot; onChange: (s: Slot) => void; zone: string;
  errors?: Partial<Record<"day" | "time", string>>;
}) {
  const id = useId();
  const today = new Date();
  const days = Array.from({ length: DAY_CHIPS }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
  const chipDays = days.map(isoDay);
  const otherDay = value.day && !chipDays.includes(value.day) ? value.day : "";
  const set = (patch: Partial<Slot>) => onChange({ ...value, ...patch });

  const times: string[] = [];
  for (let m = FIRST_SLOT; m <= LAST_SLOT; m += 15) times.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);

  const start = slotStart(value);
  const end = start && new Date(+start + value.durationMin * 60_000);

  return (
    <div className="slotpicker">
      <div className="field">
        <span className="slot-label" id={`${id}-day`}>Day</span>
        <div className="slotchips" role="group" aria-labelledby={`${id}-day`} aria-describedby={errors.day ? `${id}-day-err` : undefined}>
          {days.map((d, i) => (
            <button key={chipDays[i]} type="button" className="slotchip" aria-pressed={value.day === chipDays[i]}
              aria-label={d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
              onClick={() => set({ day: chipDays[i]! })}>
              {dayLabel(d, i)}
            </button>
          ))}
          <label className={`slotchip slotdate${otherDay ? " on" : ""}`}>
            <span className="sr-only">Other date</span>
            <input type="date" min={chipDays[0]} value={otherDay} aria-label="Other date"
              onChange={(e) => e.target.value && set({ day: e.target.value })} />
          </label>
        </div>
        {errors.day && <small id={`${id}-day-err`} className="error fielderr">{errors.day}</small>}
      </div>

      <div className="slot-row">
        <div className="field">
          <label htmlFor={`${id}-time`}>Start time</label>
          <select id={`${id}-time`} value={value.time} onChange={(e) => set({ time: e.target.value })}
            aria-invalid={errors.time ? true : undefined} aria-describedby={errors.time ? `${id}-time-err` : undefined}>
            <option value="" disabled>Choose…</option>
            {times.map((t) => (
              <option key={t} value={t}>{timeLabel(at("2000-01-03", t))}</option>
            ))}
          </select>
          {errors.time && <small id={`${id}-time-err`} className="error fielderr">{errors.time}</small>}
        </div>
        <div className="field">
          <span className="slot-label" id={`${id}-dur`}>Duration</span>
          <div className="slotchips" role="group" aria-labelledby={`${id}-dur`}>
            {DURATIONS.map((m) => (
              <button key={m} type="button" className="slotchip" aria-pressed={value.durationMin === m} onClick={() => set({ durationMin: m })}>
                {m < 60 ? `${m} min` : m === 60 ? "1 hr" : `${m / 60} hr`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="slot-summary" aria-live="polite">
        {start && end
          ? <><b>{start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</b> · {timeLabel(start)} – {timeLabel(end)} <span className="muted">({zone})</span></>
          : <span className="muted">Pick a day and a start time.</span>}
      </p>
    </div>
  );
}
