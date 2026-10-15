import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck } from "lucide-react";
import { calendarApi, calendarError, calendarKeys } from "./calendarApi";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The support calendar connection (docs/alerts-calendar-birthdays.md CA-1..CA-3),
 * shown on the Interviews page to calendar:block holders: connect the support
 * team's Google Calendar (a top-level Google sign-in) or disconnect it.
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
        <p>Connected: <b>{s.calendarId}</b> (Google account {s.accountEmail}), connected by {s.connectedBy?.name ?? "a colleague"}{s.connectedAt ? ` on ${when(s.connectedAt)}` : ""}.
          {" "}Block a slot from any interview's details.
          {" "}<button type="button" className="btn sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</button></p>
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

/** Block / release of the support calendar for one interview (CA-4..CA-6), in the interview drawer. */
export function SupportCalendarBlock({ interviewId, scheduled }: { interviewId: string; scheduled: boolean }) {
  const qc = useQueryClient();
  const id = useId();
  const q = useQuery({ queryKey: calendarKeys.block(interviewId), queryFn: () => calendarApi.blockStatus(interviewId) });
  const block = useMutation({ mutationFn: () => calendarApi.block(interviewId), onSuccess: (s) => qc.setQueryData(calendarKeys.block(interviewId), s) });
  const release = useMutation({ mutationFn: () => calendarApi.release(interviewId), onSuccess: (s) => qc.setQueryData(calendarKeys.block(interviewId), s) });
  const s = q.data;
  if (!s || (!s.block && !s.canBlock)) return null;
  const busy = block.isPending || release.isPending;
  const err = block.error ?? release.error;
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
      {err && <p className="error" role="alert">{calendarError(err)}</p>}
    </section>
  );
}
