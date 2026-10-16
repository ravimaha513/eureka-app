import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck } from "lucide-react";
import { ApiError } from "../api";
import { type BusyInterval, calendarApi, calendarError, calendarKeys } from "./calendarApi";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The support calendar connection (docs/alerts-calendar-birthdays.md CA-1..CA-3),
 * shown on the Interviews page to calendar:block holders: connect the support
 * team's Google Calendar (a top-level Google sign-in) or disconnect it. A
 * connection made before the free/busy scope (CA-7) is offered a reconnect.
 */
export function SupportCalendarCard() {
  const qc = useQueryClient();
  const id = useId();
  const q = useQuery({ queryKey: calendarKeys.status, queryFn: calendarApi.status });
  const [calendarId, setCalendarId] = useState("primary");
  const disconnect = useMutation({ mutationFn: calendarApi.disconnect, onSuccess: (s) => qc.setQueryData(calendarKeys.status, s) });
  const s = q.data;
  if (q.isLoading || !s || s.mode === "disabled") return null;
  return (
    <section className="card pad supportcal" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="sectiontitle"><CalendarCheck size={16} aria-hidden="true" /> Support calendar</h2>
      {s.connected ? (
        <>
          <p>Connected: <b>{s.calendarId}</b> (Google account {s.accountEmail}), connected by {s.connectedBy?.name ?? "a colleague"}{s.connectedAt ? ` on ${when(s.connectedAt)}` : ""}.
            {" "}Block a slot from any interview's details.
            {" "}<button type="button" className="btn sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</button></p>
          {!s.freeBusy && (
            <p className="hint" role="status">The free/busy check in scheduling needs one more Google permission (see availability).
              {" "}<button type="button" className="btn sm" onClick={() => window.location.assign(calendarApi.connectUrl(s.calendarId ?? "primary"))}>Reconnect Google Calendar</button></p>
          )}
        </>
      ) : (
        <form className="rowactions" onSubmit={(e) => { e.preventDefault(); window.location.assign(calendarApi.connectUrl(calendarId.trim() || "primary")); }}>
          <label htmlFor={`${id}-cal`}>Calendar id</label>
          <input id={`${id}-cal`} value={calendarId} onChange={(e) => setCalendarId(e.target.value)} placeholder="support@company.com or primary" style={{ minWidth: 260 }} />
          <button type="submit" className="btn sm primary">Connect Google Calendar</button>
          <span className="hint">Sign in with the Google account that owns the support calendar (or may write to it).{s.mode === "dev" ? " Development: an in-memory calendar stands in for Google." : ""}</span>
        </form>
      )}
      {disconnect.error && <p className="error" role="alert">{calendarError(disconnect.error)}</p>}
    </section>
  );
}

/** Local midnight of the day holding `d` and the next local midnight, as instants. */
export function dayWindow(d: Date): { from: string; to: string } {
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The busy periods overlapping [startsAt, endsAt), the interview's own block (same instants) left out. */
export function overlapping(busy: BusyInterval[], startsAt: Date, endsAt: Date, own?: { startsAt: string; endsAt: string } | null): BusyInterval[] {
  return busy.filter((b) => {
    const s = Date.parse(b.startsAt); const e = Date.parse(b.endsAt);
    if (Number.isNaN(s) || Number.isNaN(e) || s >= +endsAt || e <= +startsAt) return false;
    return !(own && s === Date.parse(own.startsAt) && e === Date.parse(own.endsAt));
  });
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const timeOf = (iso: string, day: Date) => {
  const d = new Date(iso);
  return sameDay(d, day) ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
};

/**
 * CA-7: whether the support calendar is busy for a slot, under the slot fields
 * of the Schedule and Edit dialogs and in the drawer. A scheduling aid only: it
 * never blocks a save. `start` is the dialog's datetime-local value (or an
 * instant); the day holding it is queried once and the slot compared locally.
 * With `interviewId`, that interview's own block is not counted as busy.
 * Readers without the permission (403) and a calendar that is not connected
 * see nothing.
 */
export function SupportCalendarBusy({ start, durationMin, interviewId }: { start: string; durationMin: number; interviewId?: string }) {
  const startsAt = new Date(start);
  const valid = start !== "" && !Number.isNaN(+startsAt) && durationMin > 0;
  const endsAt = new Date(+startsAt + durationMin * 60_000);
  const window = valid ? dayWindow(startsAt) : null;
  const q = useQuery({
    queryKey: calendarKeys.busy(window?.from ?? "", window?.to ?? ""),
    queryFn: () => calendarApi.busy(window!.from, window!.to),
    enabled: window !== null, retry: false, staleTime: 15_000,
  });
  const own = useQuery({ queryKey: calendarKeys.block(interviewId ?? ""), queryFn: () => calendarApi.blockStatus(interviewId!), enabled: Boolean(interviewId), retry: false });
  if (!valid) return null;
  if (q.isPending) return <p className="hint" role="status">Checking the support calendar…</p>;
  if (q.isError) {
    if (q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404)) return null;
    return <p className="hint" role="status">Could not check the support calendar.</p>;
  }
  const d = q.data;
  if (!d.connected) return null;
  if (!d.available) return <p className="hint" role="status">The support calendar needs a reconnect before it can be checked.</p>;
  const ownBlock = own.data?.block ?? null;
  const hits = overlapping(d.busy ?? [], startsAt, endsAt, ownBlock);
  if (hits.length) {
    return <p className="hint" role="status"><b>Support calendar is busy</b> {hits.map((b) => `${timeOf(b.startsAt, startsAt)}–${timeOf(b.endsAt, startsAt)}`).join(", ")}.</p>;
  }
  const ownHit = ownBlock !== null && Date.parse(ownBlock.startsAt) < +endsAt && Date.parse(ownBlock.endsAt) > +startsAt;
  return <p className="hint" role="status">{ownHit ? "No other bookings on the support calendar during this slot." : "Support calendar is free for this slot."}</p>;
}

/** Block / release of the support calendar for one interview (CA-4..CA-7), in the interview drawer. */
export function SupportCalendarBlock({ interviewId, scheduled, startsAt, endsAt }: { interviewId: string; scheduled: boolean; startsAt: string; endsAt: string }) {
  const qc = useQueryClient();
  const id = useId();
  const q = useQuery({ queryKey: calendarKeys.block(interviewId), queryFn: () => calendarApi.blockStatus(interviewId) });
  const block = useMutation({ mutationFn: () => calendarApi.block(interviewId), onSuccess: (s) => { qc.setQueryData(calendarKeys.block(interviewId), s); void qc.invalidateQueries({ queryKey: ["calendar", "busy"] }); } });
  const release = useMutation({ mutationFn: () => calendarApi.release(interviewId), onSuccess: (s) => { qc.setQueryData(calendarKeys.block(interviewId), s); void qc.invalidateQueries({ queryKey: ["calendar", "busy"] }); } });
  const s = q.data;
  if (!s || (!s.block && !s.canBlock)) return null;
  const busy = block.isPending || release.isPending;
  const err = block.error ?? release.error;
  const durationMin = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
  return (
    <section className="card pad" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Support calendar</h2>
      {s.block ? (
        <p>Blocked on <b>{s.block.calendarId}</b> by {s.block.createdBy.name ?? "a colleague"} on {when(s.block.createdAt)}.
          {s.canBlock && <> <button type="button" className="btn sm" disabled={busy} aria-busy={release.isPending || undefined} onClick={() => release.mutate()}>Release slot</button></>}</p>
      ) : !s.connected ? (
        <p className="muted">The support calendar is not connected. Connect it from the top of the Interviews page.</p>
      ) : !scheduled ? (
        <p className="muted">Only a scheduled interview can be blocked.</p>
      ) : (
        <p><button type="button" className="btn sm primary" disabled={busy} aria-busy={block.isPending || undefined} onClick={() => block.mutate()}>Block this slot on the support calendar</button></p>
      )}
      {s.connected && <SupportCalendarBusy start={startsAt} durationMin={durationMin} interviewId={interviewId} />}
      {err && <p className="error" role="alert">{calendarError(err)}</p>}
    </section>
  );
}
