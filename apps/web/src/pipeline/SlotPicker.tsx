import { useId } from "react";
import { INTERVIEW_DURATIONS } from "@eureka/shared";
import { LOCAL_ZONE, todayIn, wallToInstant, zoneAbbr, zoneOptions } from "./zones";

/** A slot as the picker holds it: day (YYYY-MM-DD) and time (HH:MM) in the picker's zone, and length. */
export interface Slot { day: string; time: string; durationMin: number }

/** Lengths offered (minutes); the API accepts 15..240. */
export const DURATIONS = INTERVIEW_DURATIONS;
const DAY_CHIPS = 5;

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The slot's start as an instant (its day and time read in `zone`), or null while day or time is missing. */
export function slotStart(s: Slot, zone: string = LOCAL_ZONE): Date | null {
  if (!s.day || !s.time) return null;
  return wallToInstant(s.day, s.time, zone);
}

export const durationLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} hr` : `${Math.floor(m / 60)} hr ${m % 60} min`);
const timeLabel = (hhmm: string) => new Date(`2000-01-03T${hhmm}:00`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const inZone = (d: Date, zone: string, o: Intl.DateTimeFormatOptions) => d.toLocaleString(undefined, { timeZone: zone, ...o });

/** The next `n` working days (Mon–Fri) from `today` (YYYY-MM-DD), today included when it is one. */
function workingDays(today: string, n: number): Date[] {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const out: Date[] = [];
  for (let i = 0; out.length < n && i < 14; i++) {
    const day = new Date(y, m - 1, d + i);
    if (day.getDay() !== 0 && day.getDay() !== 6) out.push(day);
  }
  return out;
}

/** "Today", "Tomorrow", then "Wed 4". */
function dayLabel(d: Date, today: string) {
  const t = new Date(`${today}T00:00:00`);
  const diff = Math.round((+new Date(d.getFullYear(), d.getMonth(), d.getDate()) - +t) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
}

/**
 * Interview slot, the one form used everywhere an interview is booked: the time zone first (the
 * times below are read in it), day chips for the next five working days plus any other date, a
 * 15-minute start list, the length, then the resulting window spelled out, with the viewer's own
 * time when the zone is another one.
 */
export function SlotPicker({ value, onChange, zone, onZoneChange, errors = {} }: {
  value: Slot; onChange: (s: Slot) => void;
  /** Zone the day and time are entered in. */
  zone: string;
  /** Lets the user change the zone (the select is shown first); without it the zone is only named. */
  onZoneChange?: (zone: string) => void;
  errors?: Partial<Record<"day" | "time", string>>;
}) {
  const id = useId();
  const today = todayIn(zone);
  const days = workingDays(today, DAY_CHIPS);
  const chipDays = days.map(isoDay);
  const otherDay = value.day && !chipDays.includes(value.day) ? value.day : "";
  const set = (patch: Partial<Slot>) => onChange({ ...value, ...patch });

  const times: string[] = [];
  for (let m = 0; m < 24 * 60; m += 15) times.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  const durations: number[] = (DURATIONS as readonly number[]).includes(value.durationMin) ? [...DURATIONS] : [...DURATIONS, value.durationMin].sort((a, b) => a - b);

  const start = slotStart(value, zone);
  const end = start && new Date(+start + value.durationMin * 60_000);
  const abbr = zoneAbbr(zone, start ?? new Date());

  return (
    <fieldset className="slotpicker">
      <legend className="sr-only">Interview slot</legend>
      {onZoneChange ? (
        <div className="field slot-zone">
          <label htmlFor={`${id}-zone`}>Time zone</label>
          <select id={`${id}-zone`} value={zone} onChange={(e) => onZoneChange(e.target.value)}>
            {zoneOptions(zone).map(([z, l]) => <option key={z} value={z}>{l}</option>)}
          </select>
        </div>
      ) : (
        <p className="hint slot-zonenote">Times in {zone} ({abbr}).</p>
      )}
      <div className="field">
        <span className="slot-label" id={`${id}-day`}>Day</span>
        <div className="slotchips" role="group" aria-labelledby={`${id}-day`} aria-describedby={errors.day ? `${id}-day-err` : undefined}>
          {days.map((d, i) => (
            <button key={chipDays[i]} type="button" className="slotchip" aria-pressed={value.day === chipDays[i]}
              aria-label={d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
              onClick={() => set({ day: chipDays[i]! })}>
              {dayLabel(d, today)}
            </button>
          ))}
          <label className={`slotchip slotdate${otherDay ? " on" : ""}`}>
            <span className="sr-only">Other date</span>
            <input type="date" value={otherDay} aria-label="Other date"
              onChange={(e) => e.target.value && set({ day: e.target.value })} />
          </label>
        </div>
        {errors.day && <small id={`${id}-day-err`} className="error fielderr">{errors.day}</small>}
      </div>

      <div className="slot-row">
        <div className="field">
          <label htmlFor={`${id}-time`}>Start time</label>
          <select id={`${id}-time`} value={value.time} onChange={(e) => set({ time: e.target.value })}
            aria-invalid={errors.time ? true : undefined} aria-describedby={errors.time ? `${id}-time-err` : `${id}-tz`}>
            <option value="" disabled>Choose…</option>
            {times.map((t) => <option key={t} value={t}>{timeLabel(t)}</option>)}
          </select>
          {errors.time ? <small id={`${id}-time-err`} className="error fielderr">{errors.time}</small>
            : <small id={`${id}-tz`} className="hint">{abbr}</small>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-dur`}>Duration</label>
          <select id={`${id}-dur`} value={value.durationMin} onChange={(e) => set({ durationMin: Number(e.target.value) })}>
            {durations.map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}
          </select>
        </div>
      </div>

      <p className="slot-summary" aria-live="polite">
        {start && end ? (
          <>
            <b>{inZone(start, zone, { weekday: "long", day: "numeric", month: "long" })}</b> · {inZone(start, zone, { hour: "numeric", minute: "2-digit" })} – {inZone(end, zone, { hour: "numeric", minute: "2-digit" })} <span className="muted">{abbr} ({zone})</span>
            {zone !== LOCAL_ZONE && (
              <span className="block muted">Your time: {inZone(start, LOCAL_ZONE, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} – {inZone(end, LOCAL_ZONE, { hour: "numeric", minute: "2-digit" })} {zoneAbbr(LOCAL_ZONE, start)}</span>
            )}
          </>
        ) : <span className="muted">Pick a day and a start time ({abbr}).</span>}
      </p>
    </fieldset>
  );
}
