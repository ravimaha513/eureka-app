import { useEffect, useState } from "react";

/**
 * Time zones for interview times. Interviews are stored as UTC instants; people enter and read
 * them in a zone they choose: their own, or the client's (US Eastern, Central, Pacific) or India.
 */
export const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const NAMED: [string, string][] = [
  ["America/New_York", "US Eastern (New York)"],
  ["America/Chicago", "US Central (Chicago)"],
  ["America/Los_Angeles", "US Pacific (Los Angeles)"],
  ["Asia/Kolkata", "India (Kolkata)"],
];

/** [zone, label] options: the viewer's own zone first, then the firm's usual zones (no duplicates). */
export function zoneOptions(current?: string): [string, string][] {
  const opts: [string, string][] = [[LOCAL_ZONE, `${LOCAL_ZONE} (your time)`], ...NAMED.filter(([z]) => z !== LOCAL_ZONE)];
  if (current && !opts.some(([z]) => z === current)) opts.push([current, current]);
  return opts;
}

/** Minutes the zone is ahead of UTC at `instant` (e.g. -240 for New York in summer). */
function offsetMin(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second")) - instant) / 60_000;
}

/** A wall-clock day (YYYY-MM-DD) and time (HH:MM) in `zone` as an instant, or null when incomplete. */
export function wallToInstant(day: string, time: string, zone: string = LOCAL_ZONE): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  if (zone === LOCAL_ZONE) {
    const d = new Date(`${day}T${time}:00`);
    return Number.isNaN(+d) ? null : d;
  }
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = offsetMin(guess, zone);
  let t = guess - first * 60_000;
  const second = offsetMin(t, zone);
  if (second !== first) t = guess - second * 60_000;
  return new Date(t);
}

/** Midnight of `day` in `zone` (or of the following day) as an ISO instant: inclusive day filters. */
export function zoneDayBoundary(day: string, zone: string, next = false): string {
  let d = day;
  if (next) {
    const x = new Date(`${day}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1);
    d = x.toISOString().slice(0, 10);
  }
  return (wallToInstant(d, "00:00", zone) ?? new Date(`${d}T00:00:00`)).toISOString();
}

/** Today's date (YYYY-MM-DD) in `zone`. */
export function todayIn(zone: string = LOCAL_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** The calendar day (YYYY-MM-DD) of an instant in `zone`. */
export function dayIn(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** Short zone name at that instant: "EST", "CDT", "GMT+5:30". */
export function zoneAbbr(zone: string, at: Date | string = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date(at));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? zone;
}

/** "2:00 PM" in `zone`. */
export const fmtTime = (iso: string, zone: string) =>
  new Date(iso).toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" });

/** "2:00 – 3:00 PM EST" (one slot, one zone mark). */
export function fmtSlot(startsAt: string, endsAt: string, zone: string) {
  return `${fmtTime(startsAt, zone)} – ${fmtTime(endsAt, zone)} ${zoneAbbr(zone, startsAt)}`;
}

/** "Fri, Nov 6, 2026" in `zone`. */
export const fmtDay = (iso: string, zone: string) =>
  new Date(iso).toLocaleDateString(undefined, { timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric" });

const KEY = "eureka.interviewZone";
const EVENT = "eureka:interview-zone";
const read = () => {
  try { return window.localStorage.getItem(KEY) || LOCAL_ZONE; } catch { return LOCAL_ZONE; }
};

/**
 * The zone this viewer reads and enters interview times in, remembered in this browser only
 * (a convenience: it falls back to their own zone). Shared by the Interviews board and every
 * scheduling form, so choosing New York once applies everywhere.
 */
export function useInterviewZone(): [string, (z: string) => void] {
  const [zone, setZone] = useState(read);
  useEffect(() => {
    const on = () => setZone(read());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const set = (z: string) => {
    try { if (z === LOCAL_ZONE) window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, z); } catch { /* private window */ }
    setZone(z);
    window.dispatchEvent(new Event(EVENT));
  };
  return [zone, set];
}
