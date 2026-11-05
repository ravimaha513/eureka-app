import { useEffect, useId, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { can, type Me } from "../api";
import { dayIn, fmtDay, fmtRange, fmtTime, todayIn, useInterviewZone, zoneAbbr, zoneDayBoundary, zoneOptions } from "../pipeline/zones";
import { QueryError } from "../ui/QueryError";
import { Tabs } from "../ui/Tabs";
import { CoachCalendarAccess } from "./CoachCalendarAccess";
import { type CalendarCoach, type CalendarEvent, type CoachGoogle, GOOGLE_CONNECT_URL, type GoogleAllDayEvent, type GoogleCoachStatus, type GoogleEvent, coachCalendarApi, coachCalendarKeys } from "./coachCalendarApi";
import { addDays, coversDay, hourRange, layOutLanes, mergeGoogleEvents, minutesWithinDay, mondayOf } from "./coachCalendarLayout";
import "./coachCalendar.css";

type View = "day" | "week";
const HOUR_PX = 48;
const WEEKDAYS = 5;
const WEEK = 7;

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h % 24 < 12 ? "am" : "pm"}`;
const weekdayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

type GridEvent = CalendarEvent | GoogleEvent;
const isGoogle = (e: GridEvent): e is GoogleEvent => !("interviewId" in e);
const STATUS_WORDS: Partial<Record<GoogleCoachStatus, string>> = {
  not_connected: "Google not connected", reconnect: "Google needs reconnecting", unavailable: "Google didn't respond",
};

/** Finished, double-booked or scheduled: the class and the words that say so without colour. */
function eventState(e: CalendarEvent, overlaps: boolean, now: number): { cls: string; word: string } {
  if (e.callStatus === "completed" || Date.parse(e.endsAt) < now) return { cls: "done", word: "finished" };
  if (overlaps) return { cls: "clash", word: "double-booked" };
  return { cls: "", word: "scheduled" };
}

function EventCard({ e, overlaps, now, zone, style, onOpen, compact }: {
  e: GridEvent; overlaps: boolean; now: number; zone: string; style?: React.CSSProperties; onOpen?: (id: string) => void; compact?: boolean;
}) {
  if (isGoogle(e)) {
    const who = e.title ?? "Busy";
    const label = `${who}, ${fmtRange(e.startsAt, e.endsAt, zone)}, from Google Calendar`;
    return <div className={`cc-ev google${compact ? " compact" : ""}`} style={style} title={label} role="img" aria-label={label}>
      {compact && <span className="cc-time">{fmtTime(e.startsAt, zone)} </span>}<b>{who}</b>
    </div>;
  }
  const { cls, word } = eventState(e, overlaps, now);
  const time = compact ? fmtTime(e.startsAt, zone) : null;
  const who = e.candidateName ?? "Busy";
  const label = `${who}${e.round ? `, ${e.round}` : ""}, ${fmtRange(e.startsAt, e.endsAt, zone)}, ${word}`;
  const body = <>
    {time && <span className="cc-time">{time} </span>}<b>{who}</b>
    {!compact && e.round && <span className="cc-round">{e.round}</span>}
  </>;
  const className = `cc-ev ${cls}${compact ? " compact" : ""}`;
  return onOpen && e.interviewId
    ? <button type="button" className={className} style={style} title={label} aria-label={label} onClick={() => onOpen(e.interviewId!)}>{body}</button>
    : <div className={className} style={style} title={label} role="img" aria-label={label}>{body}</div>;
}

function AllDayChip({ e }: { e: GoogleAllDayEvent }) {
  const label = `${e.title ?? "Busy"}, all day, from Google Calendar`;
  return <span className="cc-allday" title={label} role="img" aria-label={label}>{e.title ?? "Busy"}</span>;
}

function GoogleTag({ status }: { status?: GoogleCoachStatus }) {
  const word = status && STATUS_WORDS[status];
  return word ? <span className="cc-busytag">{word}</span> : null;
}

function DayGrid({ day, zone, coaches, events, allDay, statuses, now, onOpen }: {
  day: string; zone: string; coaches: CalendarCoach[]; events: GridEvent[]; allDay: GoogleAllDayEvent[]; statuses: Map<string, GoogleCoachStatus>; now: number; onOpen?: (id: string) => void;
}) {
  const span = (e: GridEvent) => minutesWithinDay(e.startsAt, e.endsAt, day, zone);
  const { first, last } = hourRange(events.map(span));
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const cols = `56px repeat(${coaches.length}, minmax(132px, 1fr))`;
  return (
    <div className="cc-scroll" tabIndex={0} role="region" aria-label="Day calendar by coach">
      <div className="cc-grid" style={{ gridTemplateColumns: cols }}>
        <div className="cc-head cc-corner" />
        {coaches.map((c) => <div key={c.id} className="cc-head">
          {c.name}{c.detail === "busy" && <span className="cc-busytag">busy only</span>}<GoogleTag status={statuses.get(c.id)} />
          {allDay.filter((e) => e.coachId === c.id && coversDay(e, day)).map((e, i) => <AllDayChip key={i} e={e} />)}
        </div>)}
        <div className="cc-hours">
          {hours.map((h) => <div key={h} className="cc-hour" style={{ height: HOUR_PX }}>{hourLabel(h)}</div>)}
        </div>
        {coaches.map((c) => (
          <div key={c.id} className="cc-col" style={{ height: hours.length * HOUR_PX, backgroundSize: `100% ${HOUR_PX}px` }}>
            {layOutLanes(events.filter((e) => e.coachId === c.id), span).map(({ item, lane, lanes, overlaps }) => {
              const { start, end } = span(item);
              return <EventCard key={`${item.startsAt}-${isGoogle(item) ? "g" : item.interviewId ?? "b"}-${lane}`} e={item} overlaps={overlaps} now={now} zone={zone} onOpen={onOpen} style={{
                top: (start / 60 - first) * HOUR_PX + 1,
                height: Math.max(((end - start) / 60) * HOUR_PX - 2, 20),
                left: `calc(${(lane / lanes) * 100}% + 2px)`,
                width: `calc(${100 / lanes}% - 4px)`,
              }} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function WeekGrid({ monday, zone, coaches, events, allDay, statuses, now, today, onOpen }: {
  monday: string; zone: string; coaches: CalendarCoach[]; events: GridEvent[]; allDay: GoogleAllDayEvent[]; statuses: Map<string, GoogleCoachStatus>; now: number; today: string; onOpen?: (id: string) => void;
}) {
  const byCell = new Map<string, GridEvent[]>();
  for (const e of events) {
    const k = `${e.coachId}|${dayIn(e.startsAt, zone)}`;
    byCell.set(k, [...(byCell.get(k) ?? []), e]);
  }
  // Monday to Friday, plus a weekend day only when something is booked on it.
  const days = Array.from({ length: WEEK }, (_, i) => addDays(monday, i))
    .filter((d, i) => i < WEEKDAYS || coaches.some((c) => byCell.has(`${c.id}|${d}`) || allDay.some((e) => e.coachId === c.id && coversDay(e, d))));
  return (
    <div className="cc-scroll" tabIndex={0} role="region" aria-label="Week calendar by coach">
      <table className="cc-week">
        <thead><tr><th scope="col" className="cc-weekcoach">Coach</th>{days.map((d) => <th scope="col" key={d} className={d === today ? "today" : undefined}>{weekdayLabel(d)}</th>)}</tr></thead>
        <tbody>
          {coaches.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="cc-weekcoach">{c.name}{c.detail === "busy" && <span className="cc-busytag">busy only</span>}<GoogleTag status={statuses.get(c.id)} /></th>
              {days.map((d) => {
                const cell = byCell.get(`${c.id}|${d}`) ?? [];
                const span = (e: GridEvent) => ({ start: Date.parse(e.startsAt), end: Date.parse(e.endsAt) });
                return <td key={d}>
                  {allDay.filter((e) => e.coachId === c.id && coversDay(e, d)).map((e, i) => <AllDayChip key={i} e={e} />)}
                  {layOutLanes(cell, span).map(({ item, overlaps }, i) =>
                    <EventCard key={`${item.startsAt}-${i}`} e={item} overlaps={overlaps} now={now} zone={zone} onOpen={onOpen} compact />)}
                </td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const GOOGLE_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Calendar connected." },
  cancelled: { ok: false, text: "Google Calendar wasn't connected: the request was cancelled." },
  wrong_account: { ok: false, text: "That Google account isn't the one you sign in to Eureka with. Choose your work account and try again." },
  scope_missing: { ok: false, text: "Google Calendar wasn't connected: Eureka needs permission to read your events. Try again and leave it ticked." },
  failed: { ok: false, text: "Google Calendar didn't connect. Try again." },
};

/** The result Google's round trip came back with, once, then gone from the address. */
function useGoogleResult() {
  const [result] = useState(() => new URLSearchParams(window.location.search).get("google"));
  useEffect(() => {
    if (!result) return;
    const params = new URLSearchParams(window.location.search);
    params.delete("google");
    const qs = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
  }, [result]);
  return result ? GOOGLE_RESULT[result] ?? null : null;
}

/** What a coach sees about their own connection, including who can read it. */
function GoogleBar({ google }: { google: CoachGoogle }) {
  const qc = useQueryClient();
  const result = useGoogleResult();
  const disconnect = useMutation({
    mutationFn: coachCalendarApi.disconnectGoogle,
    onSuccess: () => qc.invalidateQueries({ queryKey: coachCalendarKeys.all }),
  });
  const own = google.me.canConnect
    ? google.me.connected
      ? <p className="cc-google hint">
          <span>Your Google Calendar is connected as {google.me.accountEmail}. Anyone allowed to see your calendar sees your event titles; events you mark private show as Busy.</span>
          <button type="button" className="btn sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</button>
        </p>
      : <p className="cc-google hint">
          <span>Connect your Google Calendar so your other meetings show here. Anyone allowed to see your calendar will see event titles; events you mark private show as Busy. Eureka can only read your calendar, and doesn't keep your events.</span>
          <a className="btn sm primary" href={GOOGLE_CONNECT_URL}>Connect Google Calendar</a>
        </p>
    : null;
  return <>
    {result && <p className={result.ok ? "hint" : "error"} role="status">{result.text}</p>}
    {disconnect.isError && <p className="error" role="alert">That didn't disconnect. Try again.</p>}
    {own}
  </>;
}

function CalendarTab({ onOpenInterview }: { onOpenInterview?: (id: string) => void }) {
  const id = useId();
  const [zone, setZone] = useInterviewZone();
  const [view, setView] = useState<View>("day");
  const [day, setDay] = useState(() => todayIn(zone));
  const today = todayIn(zone);
  const monday = mondayOf(day);
  const from = zoneDayBoundary(view === "day" ? day : monday, zone);
  const to = view === "day" ? zoneDayBoundary(day, zone, true) : zoneDayBoundary(addDays(monday, WEEK - 1), zone, true);
  const q = useQuery({
    queryKey: coachCalendarKeys.calendar(from, to),
    queryFn: () => coachCalendarApi.calendar(from, to),
    placeholderData: keepPreviousData,
  });
  // Separate from the grid: a slow Google answer must never hold up the interviews.
  const g = useQuery({
    queryKey: coachCalendarKeys.google(from, to),
    queryFn: () => coachCalendarApi.google(from, to),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const step = view === "day" ? 1 : WEEK;
  const now = useMemo(() => Date.now(), [q.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = view === "day" ? fmtDay(zoneDayBoundary(day, zone), zone) : `${weekdayLabel(monday)} to ${weekdayLabel(addDays(monday, WEEK - 1))}`;
  const coaches = q.data?.coaches ?? [];
  const interviews = q.data?.events ?? [];
  const events = useMemo<GridEvent[]>(() => mergeGoogleEvents(interviews, g.data?.events ?? []), [interviews, g.data?.events]);
  const allDay = g.data?.allDay ?? [];
  const statuses = useMemo(() => new Map((g.data?.coaches ?? []).map((c) => [c.coachId, c.status])), [g.data?.coaches]);
  const connected = (g.data?.coaches ?? []).filter((c) => c.status === "connected").length;
  return (
    <>
      <div className="toolbar cc-toolbar">
        <div className="tabs" role="group" aria-label="Calendar view">
          {(["day", "week"] as const).map((v) => <button key={v} type="button" className="tab" aria-pressed={view === v} onClick={() => setView(v)}>{v === "day" ? "Day" : "Week"}</button>)}
        </div>
        <div className="rowactions">
          <button type="button" className="btn sm" aria-label={`Previous ${view}`} onClick={() => setDay(addDays(day, -step))}><ChevronLeft size={16} aria-hidden="true" /></button>
          <button type="button" className="btn sm" onClick={() => setDay(today)}>Today</button>
          <button type="button" className="btn sm" aria-label={`Next ${view}`} onClick={() => setDay(addDays(day, step))}><ChevronRight size={16} aria-hidden="true" /></button>
          <b className="cc-title" aria-live="polite">{title}</b>
        </div>
        <div className="field inline push">
          <label htmlFor={`${id}-zone`}>Time zone ({zoneAbbr(zone)})</label>
          <select id={`${id}-zone`} value={zone} onChange={(e) => setZone(e.target.value)}>
            {zoneOptions(zone).map(([z, l]) => <option key={z} value={z}>{l}</option>)}
          </select>
        </div>
      </div>
      {g.data?.enabled && <GoogleBar google={g.data} />}
      {g.isError && <p className="hint" role="status">Google Calendar events didn't load. Interviews below are up to date.</p>}
      <p className="cc-legend hint">
        <span className="cc-swatch" /> Scheduled <span className="cc-swatch clash" /> Double-booked <span className="cc-swatch done" /> Finished <span className="cc-swatch google" /> Google Calendar
        {q.data && <span className="cc-count"> {coaches.length} {coaches.length === 1 ? "coach" : "coaches"}, {interviews.length} {interviews.length === 1 ? "interview" : "interviews"}{g.data?.enabled ? `, ${connected} on Google` : ""}</span>}
      </p>
      {q.isError ? <QueryError query={q} message="The coach calendar didn't load." />
        : q.isPending ? <p className="hint" role="status">Loading the coach calendar…</p>
        : coaches.length === 0 ? <p className="hint">No coaches to show. Active users with the Interview Coach role appear here.</p>
        : view === "day" ? <DayGrid day={day} zone={zone} coaches={coaches} events={events} allDay={allDay} statuses={statuses} now={now} onOpen={onOpenInterview} />
        : <WeekGrid monday={monday} zone={zone} coaches={coaches} events={events} allDay={allDay} statuses={statuses} now={now} today={today} onOpen={onOpenInterview} />}
    </>
  );
}

/** Every coach's interviews in one grid; the CEO also decides here who else may see it. */
export function CoachCalendarPage({ me, onOpenInterview }: { me: Me; onOpenInterview?: (id: string) => void }) {
  const manage = can(me, "coach_calendar:manage");
  return (
    <section className="panel ccpage">
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Coach calendar</h1>
          <p className="sub">Interviews assigned to each coach, plus their Google Calendar once they connect it.</p>
        </div>
      </div>
      {manage
        ? <Tabs label="Coach calendar sections" urlKey="tab" tabs={[{ key: "calendar", label: "Calendar" }, { key: "access", label: "Access" }]}>
            {(tab) => tab === "calendar" ? <CalendarTab onOpenInterview={onOpenInterview} /> : <CoachCalendarAccess />}
          </Tabs>
        : <CalendarTab onOpenInterview={onOpenInterview} />}
    </section>
  );
}
