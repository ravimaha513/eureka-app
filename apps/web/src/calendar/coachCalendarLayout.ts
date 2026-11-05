import { dayIn, zoneStamp } from "../pipeline/zones";

/** The day `n` days after a YYYY-MM-DD day. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week holding a YYYY-MM-DD day. */
export function mondayOf(day: string): string {
  return addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}

/** Minutes since midnight of an instant's wall clock in `zone`. */
function wallMinutes(iso: string, zone: string): number {
  const s = zoneStamp(iso, zone);
  return Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
}

/** An interview's minutes within one day in `zone`, clipped at midnight when it crosses into the next. */
export function minutesWithinDay(startsAt: string, endsAt: string, day: string, zone: string): { start: number; end: number } {
  return {
    start: dayIn(startsAt, zone) < day ? 0 : wallMinutes(startsAt, zone),
    end: dayIn(endsAt, zone) > day ? 1440 : wallMinutes(endsAt, zone),
  };
}

/** Whole hours the day grid shows: working hours, widened to fit whatever falls outside them. */
export function hourRange(spans: readonly { start: number; end: number }[]): { first: number; last: number } {
  let first = 9;
  let last = 18;
  for (const s of spans) {
    first = Math.min(first, Math.floor(s.start / 60));
    last = Math.max(last, Math.ceil(s.end / 60));
  }
  return { first, last };
}

export interface Lanes<T> { item: T; lane: number; lanes: number; overlaps: boolean }

/**
 * Side-by-side lanes for one coach's day, so double-booked interviews both stay readable.
 * Touching slots (one ends as the next starts) do not overlap.
 */
export function layOutLanes<T>(items: readonly T[], span: (t: T) => { start: number; end: number }): Lanes<T>[] {
  const sorted = [...items].sort((a, b) => span(a).start - span(b).start || span(a).end - span(b).end);
  const out: Lanes<T>[] = [];
  let group: Lanes<T>[] = [];
  let groupEnd = -1;
  let laneEnds: number[] = [];
  const close = () => {
    for (const g of group) { g.lanes = laneEnds.length; g.overlaps = group.length > 1; }
    out.push(...group);
    group = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    const { start, end } = span(item);
    if (start >= groupEnd) { close(); groupEnd = end; }
    groupEnd = Math.max(groupEnd, end);
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(end); } else laneEnds[lane] = end;
    group.push({ item, lane, lanes: 1, overlaps: false });
  }
  close();
  return out;
}
