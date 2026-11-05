import { useId, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { can, type Me } from "../api";
import { dayIn, fmtDay, fmtRange, fmtTime, todayIn, useInterviewZone, zoneAbbr, zoneDayBoundary, zoneOptions } from "../pipeline/zones";
import { QueryError } from "../ui/QueryError";
import { Tabs } from "../ui/Tabs";
import { CoachCalendarAccess } from "./CoachCalendarAccess";
import { type CalendarCoach, type CalendarEvent, coachCalendarApi, coachCalendarKeys } from "./coachCalendarApi";
import { addDays, hourRange, layOutLanes, minutesWithinDay, mondayOf } from "./coachCalendarLayout";
import "./coachCalendar.css";

type View = "day" | "week";
const HOUR_PX = 48;
const WEEKDAYS = 5;
const WEEK = 7;

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h % 24 < 12 ? "am" : "pm"}`;
const weekdayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

/** Finished, double-booked or scheduled: the class and the words that say so without colour. */
function eventState(e: CalendarEvent, overlaps: boolean, now: number): { cls: string; word: string } {
  if (e.callStatus === "completed" || Date.parse(e.endsAt) < now) return { cls: "done", word: "finished" };
  if (overlaps) return { cls: "clash", word: "double-booked" };
  return { cls: "", word: "scheduled" };
}

function EventCard({ e, overlaps, now, zone, style, onOpen, compact }: {
  e: CalendarEvent; overlaps: boolean; now: number; zone: string; style?: React.CSSProperties; onOpen?: (id: string) => void; compact?: boolean;
}) {
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

function DayGrid({ day, zone, coaches, events, now, onOpen }: {
  day: string; zone: string; coaches: CalendarCoach[]; events: CalendarEvent[]; now: number; onOpen?: (id: string) => void;
}) {
  const span = (e: CalendarEvent) => minutesWithinDay(e.startsAt, e.endsAt, day, zone);
  const { first, last } = hourRange(events.map(span));
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const cols = `56px repeat(${coaches.length}, minmax(132px, 1fr))`;
  return (
    <div className="cc-scroll" tabIndex={0} role="region" aria-label="Day calendar by coach">
      <div className="cc-grid" style={{ gridTemplateColumns: cols }}>
        <div className="cc-head cc-corner" />
        {coaches.map((c) => <div key={c.id} className="cc-head">{c.name}{c.detail === "busy" && <span className="cc-busytag">busy only</span>}</div>)}
        <div className="cc-hours">
          {hours.map((h) => <div key={h} className="cc-hour" style={{ height: HOUR_PX }}>{hourLabel(h)}</div>)}
        </div>
        {coaches.map((c) => (
          <div key={c.id} className="cc-col" style={{ height: hours.length * HOUR_PX, backgroundSize: `100% ${HOUR_PX}px` }}>
            {layOutLanes(events.filter((e) => e.coachId === c.id), span).map(({ item, lane, lanes, overlaps }) => {
              const { start, end } = span(item);
              return <EventCard key={`${item.startsAt}-${item.interviewId ?? lane}`} e={item} overlaps={overlaps} now={now} zone={zone} onOpen={onOpen} style={{
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

function WeekGrid({ monday, zone, coaches, events, now, today, onOpen }: {
  monday: string; zone: string; coaches: CalendarCoach[]; events: CalendarEvent[]; now: number; today: string; onOpen?: (id: string) => void;
}) {
  const byCell = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const k = `${e.coachId}|${dayIn(e.startsAt, zone)}`;
    byCell.set(k, [...(byCell.get(k) ?? []), e]);
  }
  // Monday to Friday, plus a weekend day only when something is booked on it.
  const days = Array.from({ length: WEEK }, (_, i) => addDays(monday, i))
    .filter((d, i) => i < WEEKDAYS || coaches.some((c) => byCell.has(`${c.id}|${d}`)));
  return (
    <div className="cc-scroll" tabIndex={0} role="region" aria-label="Week calendar by coach">
      <table className="cc-week">
        <thead><tr><th scope="col" className="cc-weekcoach">Coach</th>{days.map((d) => <th scope="col" key={d} className={d === today ? "today" : undefined}>{weekdayLabel(d)}</th>)}</tr></thead>
        <tbody>
          {coaches.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="cc-weekcoach">{c.name}{c.detail === "busy" && <span className="cc-busytag">busy only</span>}</th>
              {days.map((d) => {
                const cell = byCell.get(`${c.id}|${d}`) ?? [];
                const span = (e: CalendarEvent) => ({ start: Date.parse(e.startsAt), end: Date.parse(e.endsAt) });
                return <td key={d}>{layOutLanes(cell, span).map(({ item, overlaps }, i) =>
                  <EventCard key={`${item.startsAt}-${item.interviewId ?? i}`} e={item} overlaps={overlaps} now={now} zone={zone} onOpen={onOpen} compact />)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  const step = view === "day" ? 1 : WEEK;
  const now = useMemo(() => Date.now(), [q.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = view === "day" ? fmtDay(zoneDayBoundary(day, zone), zone) : `${weekdayLabel(monday)} to ${weekdayLabel(addDays(monday, WEEK - 1))}`;
  const coaches = q.data?.coaches ?? [];
  const events = q.data?.events ?? [];
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
      <p className="cc-legend hint">
        <span className="cc-swatch" /> Scheduled <span className="cc-swatch clash" /> Double-booked <span className="cc-swatch done" /> Finished
        {q.data && <span className="cc-count"> {coaches.length} {coaches.length === 1 ? "coach" : "coaches"}, {events.length} {events.length === 1 ? "interview" : "interviews"}</span>}
      </p>
      {q.isError ? <QueryError query={q} message="The coach calendar didn't load." />
        : q.isPending ? <p className="hint" role="status">Loading the coach calendar…</p>
        : coaches.length === 0 ? <p className="hint">No coaches to show. Active users with the Interview Coach role appear here.</p>
        : view === "day" ? <DayGrid day={day} zone={zone} coaches={coaches} events={events} now={now} onOpen={onOpenInterview} />
        : <WeekGrid monday={monday} zone={zone} coaches={coaches} events={events} now={now} today={today} onOpen={onOpenInterview} />}
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
          <p className="sub">Interviews assigned to each coach. Other meetings and leave don't show here.</p>
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
