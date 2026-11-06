import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { can, type Me } from "../api";
import { dayIn, fmtDay, fmtRange, fmtSlot, fmtTime, todayIn, useInterviewZone, zoneAbbr, zoneDayBoundary, zoneOptions } from "../pipeline/zones";
import { Drawer } from "../sales/ui";
import { QueryError } from "../ui/QueryError";
import { Tabs } from "../ui/Tabs";
import { CoachCalendarAccess } from "./CoachCalendarAccess";
import { type CalendarCoach, type CalendarEvent, type CoachGoogle, GOOGLE_CONNECT_URL, type GoogleAllDayEvent, type GoogleCoachStatus, type GoogleEvent, coachCalendarApi, coachCalendarKeys } from "./coachCalendarApi";
import { addDays, coversDay, findClashes, hourRange, layOutLanes, mergeGoogleEvents, minutesWithinDay, mondayOf, overlapping } from "./coachCalendarLayout";
import { CoachChips, CoachPicker } from "./CoachPicker";
import "./coachCalendar.css";

type View = "day" | "week" | "agenda";
const VIEWS: readonly (readonly [View, string])[] = [["day", "Day"], ["week", "Week"], ["agenda", "Agenda"]];
const LANE_PX = 34;
const HOUR_PX = 112;
const WEEKDAYS = 5;
const WEEK = 7;
/** Week cells list this many events, then "+N more" opens the coach's day. */
const CELL_MAX = 3;
const COACHES_KEY = "eureka.coachCalendar.coaches";
const VIEW_KEY = "eureka.coachCalendar.view";

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h % 24 < 12 ? "am" : "pm"}`;
const weekdayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const byStart = <T extends { startsAt: string }>(list: readonly T[]) => [...list].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

type GridEvent = CalendarEvent | GoogleEvent;
const isGoogle = (e: GridEvent): e is GoogleEvent => !("interviewId" in e);
const eventKey = (e: GridEvent) => `${e.coachId}|${e.startsAt}|${e.endsAt}|${isGoogle(e) ? `g:${e.title ?? ""}` : e.interviewId ?? "busy"}`;
const STATUS_WORDS: Partial<Record<GoogleCoachStatus, string>> = {
  not_connected: "Google not connected", reconnect: "Google needs reconnecting", unavailable: "Google events unavailable",
};

/** Browser-only conveniences (which coaches, which view); fine to lose. */
function readStored<T>(key: string, ok: (v: unknown) => v is T): T | null {
  try { const v: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null"); return ok(v) ? v : null; } catch { return null; }
}
function store(key: string, value: unknown) {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ }
}
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isView = (v: unknown): v is View => v === "day" || v === "week" || v === "agenda";
const narrow = () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 650px)").matches;

/** The chosen coaches, remembered in this browser. Null means everyone, so new coaches appear by themselves. */
function useCoachSelection(coaches: CalendarCoach[]): [Set<string>, (ids: Set<string>) => void] {
  const [chosen, setChosen] = useState<string[] | null>(() => readStored(COACHES_KEY, isIdList));
  const selected = useMemo(() => {
    const all = new Set(coaches.map((c) => c.id));
    if (!chosen) return all;
    const kept = new Set(chosen.filter((id) => all.has(id)));
    // Every remembered coach has gone (left, or access changed): start again from everyone.
    return kept.size === 0 && chosen.length > 0 ? all : kept;
  }, [chosen, coaches]);
  const set = useCallback((ids: Set<string>) => {
    const next = ids.size === coaches.length ? null : [...ids];
    store(COACHES_KEY, next);
    setChosen(next);
  }, [coaches.length]);
  return [selected, set];
}

interface Look { cls: string; word: string; who: string; what: string | null }
/** How an event reads: its class, the status word that says it without colour, and its names. */
function look(e: GridEvent, clash: boolean, now: number): Look {
  if (isGoogle(e)) return { cls: `google${clash ? " clash" : ""}`, word: clash ? "overlaps an interview" : "Google Calendar", who: e.title ?? "Busy", what: "Google Calendar" };
  const finished = e.callStatus === "completed" || Date.parse(e.endsAt) < now;
  return {
    cls: finished ? "done" : clash ? "clash" : "",
    word: finished ? (clash ? "finished, was double-booked" : "finished") : clash ? "double-booked" : "scheduled",
    who: e.candidateName ?? "Busy",
    what: e.round,
  };
}

interface Ctx { zone: string; now: number; clashes: Set<GridEvent>; coachName: (id: string) => string; onPick: (e: GridEvent) => void }

/** One event as a full row: time, who and round, coach and status. Used by the agenda and the drawer. */
function EventRow({ e, ctx, showCoach = true }: { e: GridEvent; ctx: Ctx; showCoach?: boolean }) {
  const clash = ctx.clashes.has(e);
  const l = look(e, clash, ctx.now);
  const when = fmtRange(e.startsAt, e.endsAt, ctx.zone);
  return (
    <button type="button" className={`cc-row ${l.cls}`} onClick={() => ctx.onPick(e)}
      aria-label={`${l.who}${l.what ? `, ${l.what}` : ""}, ${when}${showCoach ? `, ${ctx.coachName(e.coachId)}` : ""}, ${l.word}`}>
      <span className="cc-rowtime">{when}</span>
      <span className="cc-rowwho"><b>{l.who}</b>{l.what && <span>{l.what}</span>}</span>
      <span className="cc-rowmeta">
        {showCoach && <span>{ctx.coachName(e.coachId)}</span>}
        <span className={`cc-state ${l.cls}`}>{clash && <AlertTriangle size={12} aria-hidden="true" />}{l.word}</span>
      </span>
    </button>
  );
}

function AllDayChip({ e }: { e: GoogleAllDayEvent }) {
  const label = `${e.title ?? "Busy"}, all day, from Google Calendar`;
  return <span className="cc-allday" title={label} role="img" aria-label={label}>{e.title ?? "Busy"}</span>;
}

function CoachTags({ coach, status }: { coach: CalendarCoach; status?: GoogleCoachStatus }) {
  const word = status && STATUS_WORDS[status];
  if (coach.detail !== "busy" && !word) return null;
  return <span className="cc-tags">{coach.detail === "busy" && <span>Busy only</span>}{word && <span>{word}</span>}</span>;
}

/** Coaches down the side, the day's hours across: a row per coach scales to a big team. */
function DayTimeline({ day, coaches, events, allDay, statuses, today, ctx, onCoach }: {
  day: string; coaches: CalendarCoach[]; events: GridEvent[]; allDay: GoogleAllDayEvent[]; statuses: Map<string, GoogleCoachStatus>;
  today: string; ctx: Ctx; onCoach: (coachId: string, day: string) => void;
}) {
  const span = (e: GridEvent) => minutesWithinDay(e.startsAt, e.endsAt, day, ctx.zone);
  const { first, last } = hourRange(events.map(span));
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const total = (last - first) * 60;
  const pct = (minutes: number) => `${((minutes - first * 60) / total) * 100}%`;
  const nowAt = day === today ? minutesWithinDay(new Date(ctx.now).toISOString(), new Date(ctx.now).toISOString(), day, ctx.zone).start : null;
  const showNow = nowAt !== null && nowAt >= first * 60 && nowAt <= last * 60;
  return (
    <div className="cc-scroll" tabIndex={0} role="region" aria-label="Day timeline by coach">
      <div className="cc-tl" style={{ minWidth: 180 + hours.length * HOUR_PX }}>
        <div className="cc-tlrow cc-tlhead">
          <div className="cc-who">Coach</div>
          <div className="cc-hours" style={{ gridTemplateColumns: `repeat(${hours.length}, 1fr)` }}>
            {hours.map((h) => <span key={h}>{hourLabel(h)}</span>)}
          </div>
        </div>
        {coaches.map((c) => {
          const mine = events.filter((e) => e.coachId === c.id);
          const laid = layOutLanes(mine, span);
          const lanes = Math.max(1, ...laid.map((l) => l.lanes));
          const interviews = mine.filter((e) => !isGoogle(e)).length;
          const clashes = mine.filter((e) => ctx.clashes.has(e) && !isGoogle(e)).length;
          const allDayHere = allDay.filter((e) => e.coachId === c.id && coversDay(e, day));
          return (
            <div key={c.id} className="cc-tlrow">
              <div className="cc-who">
                <button type="button" className="cc-whobtn" onClick={() => onCoach(c.id, day)} aria-label={`${c.name}: ${plural(interviews, "interview")}${clashes ? `, ${clashes} double-booked` : ""}. Open their day`}>
                  <b>{c.name}</b>
                  <small>{plural(interviews, "interview")}{clashes > 0 && <span className="cc-warn"> · <AlertTriangle size={11} aria-hidden="true" /> {clashes}</span>}</small>
                </button>
                <CoachTags coach={c} status={statuses.get(c.id)} />
                {allDayHere.map((e, i) => <AllDayChip key={i} e={e} />)}
              </div>
              <div className="cc-track" style={{ height: 12 + lanes * LANE_PX, backgroundSize: `${100 / hours.length}% 100%` }}>
                {showNow && <span className="cc-now" style={{ left: pct(nowAt) }} aria-hidden="true" />}
                {laid.map(({ item, lane }) => {
                  const { start, end } = span(item);
                  const clash = ctx.clashes.has(item);
                  const l = look(item, clash, ctx.now);
                  const when = fmtRange(item.startsAt, item.endsAt, ctx.zone);
                  const label = `${l.who}${l.what ? `, ${l.what}` : ""}, ${when}, ${l.word}`;
                  return (
                    <button key={eventKey(item)} type="button" className={`cc-chipev ${l.cls}`} title={label} aria-label={label} onClick={() => ctx.onPick(item)}
                      style={{ left: `calc(${pct(start)} + 1px)`, width: `calc(${((end - start) / total) * 100}% - 2px)`, top: 6 + lane * LANE_PX }}>
                      {clash && !isGoogle(item) && <AlertTriangle size={12} aria-hidden="true" />}<b>{l.who}</b>{l.what && <span> · {l.what}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Coaches down the side, the week's days across; each cell lists that coach's day. */
function WeekGrid({ monday, coaches, events, allDay, statuses, today, ctx, onDay, onCoach }: {
  monday: string; coaches: CalendarCoach[]; events: GridEvent[]; allDay: GoogleAllDayEvent[]; statuses: Map<string, GoogleCoachStatus>;
  today: string; ctx: Ctx; onDay: (day: string) => void; onCoach: (coachId: string, day: string) => void;
}) {
  const byCell = new Map<string, GridEvent[]>();
  for (const e of byStart(events)) {
    const k = `${e.coachId}|${dayIn(e.startsAt, ctx.zone)}`;
    byCell.set(k, [...(byCell.get(k) ?? []), e]);
  }
  // Monday to Friday, plus a weekend day only when something is booked on it.
  const days = Array.from({ length: WEEK }, (_, i) => addDays(monday, i))
    .filter((d, i) => i < WEEKDAYS || coaches.some((c) => byCell.has(`${c.id}|${d}`) || allDay.some((e) => e.coachId === c.id && coversDay(e, d))));
  return (
    <div className="cc-scroll" tabIndex={0} role="region" aria-label="Week calendar by coach">
      <table className="cc-week">
        <thead><tr>
          <th scope="col" className="cc-weekcoach">Coach</th>
          {days.map((d) => {
            const n = coaches.reduce((sum, c) => sum + (byCell.get(`${c.id}|${d}`) ?? []).filter((e) => !isGoogle(e)).length, 0);
            return <th scope="col" key={d} className={d === today ? "today" : undefined}>
              <button type="button" className="cc-daybtn" onClick={() => onDay(d)} aria-label={`${weekdayLabel(d)}, ${plural(n, "interview")}. Open day timeline`}>
                {weekdayLabel(d)} <span className="cc-daycount">{n}</span>
              </button>
            </th>;
          })}
        </tr></thead>
        <tbody>
          {coaches.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="cc-weekcoach">{c.name}<CoachTags coach={c} status={statuses.get(c.id)} /></th>
              {days.map((d) => {
                const cell = byCell.get(`${c.id}|${d}`) ?? [];
                return <td key={d} className={d === today ? "today" : undefined}>
                  {allDay.filter((e) => e.coachId === c.id && coversDay(e, d)).map((e, i) => <AllDayChip key={i} e={e} />)}
                  {cell.slice(0, CELL_MAX).map((e) => {
                    const clash = ctx.clashes.has(e);
                    const l = look(e, clash, ctx.now);
                    const label = `${l.who}${l.what ? `, ${l.what}` : ""}, ${fmtRange(e.startsAt, e.endsAt, ctx.zone)}, ${l.word}`;
                    return <button key={eventKey(e)} type="button" className={`cc-mini ${l.cls}`} title={label} aria-label={label} onClick={() => ctx.onPick(e)}>
                      <span className="cc-time">{fmtTime(e.startsAt, ctx.zone)}</span> {clash && !isGoogle(e) && <AlertTriangle size={11} aria-hidden="true" />}<b>{l.who}</b>
                    </button>;
                  })}
                  {cell.length > CELL_MAX && (
                    <button type="button" className="cc-more" onClick={() => onCoach(c.id, d)} aria-label={`${plural(cell.length - CELL_MAX, "more event")} for ${c.name} on ${weekdayLabel(d)}`}>
                      +{cell.length - CELL_MAX} more{cell.slice(CELL_MAX).some((e) => ctx.clashes.has(e)) ? " · double-booked" : ""}
                    </button>
                  )}
                </td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The day as one list in time order, grouped by the hour things start. Default on a phone. */
function Agenda({ events, ctx }: { events: GridEvent[]; ctx: Ctx }) {
  const groups = new Map<string, GridEvent[]>();
  for (const e of byStart(events)) {
    const h = fmtTime(e.startsAt, ctx.zone).replace(/:\d\d/, "");
    groups.set(h, [...(groups.get(h) ?? []), e]);
  }
  return (
    <div className="cc-agenda">
      {[...groups].map(([hour, list]) => (
        <section key={hour} className="cc-agendahour" aria-label={`Starting at ${hour}`}>
          <h3>{hour}</h3>
          <div className="cc-list">{list.map((e) => <EventRow key={eventKey(e)} e={e} ctx={ctx} />)}</div>
        </section>
      ))}
    </div>
  );
}

type Panel = { kind: "event"; e: GridEvent } | { kind: "coach"; coachId: string; day: string };

function EventPanel({ e, events, ctx, onCoach, onOpenInterview }: {
  e: GridEvent; events: GridEvent[]; ctx: Ctx; onCoach: (coachId: string, day: string) => void; onOpenInterview?: (id: string) => void;
}) {
  const clash = ctx.clashes.has(e);
  const l = look(e, clash, ctx.now);
  const others = byStart(overlapping(e, events));
  const coach = ctx.coachName(e.coachId);
  const open = !isGoogle(e) && e.interviewId && onOpenInterview ? e.interviewId : null;
  const what = isGoogle(e) ? "From the coach's Google Calendar" : e.candidateName === null ? "Busy (you see busy times only for this coach)" : e.round ?? "Interview";
  return (
    <div className="cc-panel">
      {clash && <p className="note warn" role="note"><AlertTriangle size={14} aria-hidden="true" /> {coach} has {plural(others.length, "other event")} at the same time.</p>}
      <dl className="cc-dl">
        <div><dt>{isGoogle(e) ? "Event" : "Interview"}</dt><dd>{what}</dd></div>
        <div><dt>Coach</dt><dd>{coach}</dd></div>
        <div><dt>When</dt><dd>{fmtDay(e.startsAt, ctx.zone)} · {fmtSlot(e.startsAt, e.endsAt, ctx.zone)}</dd></div>
        <div><dt>Status</dt><dd><span className={`cc-state ${l.cls}`}>{l.word}</span></dd></div>
      </dl>
      {others.length > 0 && <>
        <h3 className="sectiontitle">Overlapping</h3>
        <div className="cc-list">{others.map((o) => <EventRow key={eventKey(o)} e={o} ctx={ctx} showCoach={false} />)}</div>
      </>}
      <div className="cc-panelactions">
        {open && <button type="button" className="btn primary" onClick={() => onOpenInterview!(open)}>Open interview</button>}
        <button type="button" className="btn" onClick={() => onCoach(e.coachId, dayIn(e.startsAt, ctx.zone))}>See {coach}’s day</button>
      </div>
    </div>
  );
}

function CoachPanel({ coachId, day, events, allDay, ctx }: { coachId: string; day: string; events: GridEvent[]; allDay: GoogleAllDayEvent[]; ctx: Ctx }) {
  const list = byStart(events.filter((e) => e.coachId === coachId && dayIn(e.startsAt, ctx.zone) === day));
  const interviews = list.filter((e) => !isGoogle(e)).length;
  const clashes = list.filter((e) => ctx.clashes.has(e) && !isGoogle(e)).length;
  const allDayHere = allDay.filter((e) => e.coachId === coachId && coversDay(e, day));
  return (
    <div className="cc-panel">
      <p className="drawersub hint">{weekdayLabel(day)} · {plural(interviews, "interview")}{clashes ? ` · ${clashes} double-booked` : ""} · {zoneAbbr(ctx.zone)}</p>
      {allDayHere.length > 0 && <div className="cc-alldays">{allDayHere.map((e, i) => <AllDayChip key={i} e={e} />)}</div>}
      {list.length ? <div className="cc-list">{list.map((e) => <EventRow key={eventKey(e)} e={e} ctx={ctx} showCoach={false} />)}</div>
        : <p className="hint">Nothing booked this day.</p>}
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
  const [view, setViewState] = useState<View>(() => narrow() ? "agenda" : readStored(VIEW_KEY, isView) ?? "day");
  const setView = (v: View) => { store(VIEW_KEY, v); setViewState(v); };
  const [day, setDay] = useState(() => todayIn(zone));
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [picking, setPicking] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const today = todayIn(zone);
  const monday = mondayOf(day);
  const week = view === "week";
  const from = zoneDayBoundary(week ? monday : day, zone);
  const to = week ? zoneDayBoundary(addDays(monday, WEEK - 1), zone, true) : zoneDayBoundary(day, zone, true);
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
  const step = week ? WEEK : 1;
  const now = useMemo(() => Date.now(), [q.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = week ? `${weekdayLabel(monday)} – ${weekdayLabel(addDays(monday, WEEK - 1))}` : fmtDay(zoneDayBoundary(day, zone), zone);
  const coaches = useMemo(() => q.data?.coaches ?? [], [q.data?.coaches]);
  const [selected, setSelected] = useCoachSelection(coaches);
  const all = useMemo<GridEvent[]>(() => mergeGoogleEvents(q.data?.events ?? [], g.data?.events ?? []), [q.data?.events, g.data?.events]);
  const clashes = useMemo(() => findClashes(all), [all]);
  const allDay = g.data?.allDay ?? [];
  const statuses = useMemo(() => new Map((g.data?.coaches ?? []).map((c) => [c.coachId, c.status])), [g.data?.coaches]);
  const names = useMemo(() => new Map(coaches.map((c) => [c.id, c.name])), [coaches]);

  // The data still holds the previous range while the next one loads; keep only what's on screen.
  const inRange = (e: GridEvent) => Date.parse(e.endsAt) > Date.parse(from) && Date.parse(e.startsAt) < Date.parse(to);
  const shown = all.filter((e) => selected.has(e.coachId) && inRange(e) && (!conflictsOnly || clashes.has(e)));
  const shownCoaches = coaches.filter((c) => selected.has(c.id) && (!conflictsOnly || shown.some((e) => e.coachId === c.id)));
  const interviews = shown.filter((e) => !isGoogle(e));
  const doubleBooked = all.filter((e) => !isGoogle(e) && selected.has(e.coachId) && inRange(e) && clashes.has(e)).length;
  const connected = (g.data?.coaches ?? []).filter((c) => c.status === "connected" && selected.has(c.coachId)).length;

  const ctx: Ctx = { zone, now, clashes, coachName: (c) => names.get(c) ?? "Coach", onPick: (e) => setPanel({ kind: "event", e }) };
  const openCoach = (coachId: string, d: string) => setPanel({ kind: "coach", coachId, day: d });
  const openDay = (d: string) => { setDay(d); setView("day"); };
  const onPickerOpen = useCallback((open: boolean) => setPicking(open), []);

  const body = q.isError ? <QueryError query={q} message="The coach calendar didn't load." />
    : q.isPending ? <p className="hint" role="status">Loading the coach calendar…</p>
    : coaches.length === 0 ? <p className="cc-empty">No coaches to show. Active users with the Interview Coach role appear here.</p>
    : selected.size === 0 ? <p className="cc-empty">Choose at least one coach to see their calendar.</p>
    : conflictsOnly && shown.length === 0 ? <p className="cc-empty">No double-bookings {week ? "this week" : "on this day"} for these coaches.</p>
    : view === "day" ? <DayTimeline day={day} coaches={shownCoaches} events={shown} allDay={allDay} statuses={statuses} today={today} ctx={ctx} onCoach={openCoach} />
    : view === "week" ? <WeekGrid monday={monday} coaches={shownCoaches} events={shown} allDay={allDay} statuses={statuses} today={today} ctx={ctx} onDay={openDay} onCoach={openCoach} />
    : shown.length === 0 ? <p className="cc-empty">Nothing booked on this day for these coaches.</p>
    : <Agenda events={shown} ctx={ctx} />;

  return (
    <>
      <div className="cc-toolbar">
        <div className="tabs seg" role="group" aria-label="Calendar view">
          {VIEWS.map(([v, label]) => <button key={v} type="button" className="tab" aria-pressed={view === v} onClick={() => setView(v)}>{label}</button>)}
        </div>
        <div className="cc-nav">
          <button type="button" className="iconbtn sm" aria-label={`Previous ${week ? "week" : "day"}`} onClick={() => setDay(addDays(day, -step))}><ChevronLeft size={16} aria-hidden="true" /></button>
          <button type="button" className="btn sm" disabled={week ? monday === mondayOf(today) : day === today} onClick={() => setDay(today)}>Today</button>
          <button type="button" className="iconbtn sm" aria-label={`Next ${week ? "week" : "day"}`} onClick={() => setDay(addDays(day, step))}><ChevronRight size={16} aria-hidden="true" /></button>
          <b className="cc-title" aria-live="polite">{title}</b>
        </div>
        <div className="field inline cc-zone">
          <label htmlFor={`${id}-zone`}>Time zone ({zoneAbbr(zone)})</label>
          <select id={`${id}-zone`} value={zone} onChange={(e) => setZone(e.target.value)}>
            {zoneOptions(zone).map(([z, l]) => <option key={z} value={z}>{l}</option>)}
          </select>
        </div>
      </div>
      <div className="cc-filters">
        {coaches.length > 1 && <CoachPicker coaches={coaches} selected={selected} onChange={setSelected} open={picking} onOpenChange={onPickerOpen} />}
        <label className="cc-check"><input type="checkbox" checked={conflictsOnly} onChange={(e) => setConflictsOnly(e.target.checked)} /> Double-booked only</label>
        {q.data && <span className="cc-count" aria-live="polite">
          {plural(interviews.length, "interview")} {week ? "this week" : "on this day"}
          {doubleBooked > 0 && <span className="cc-warn"> · <AlertTriangle size={12} aria-hidden="true" /> {doubleBooked} double-booked</span>}
          {g.data?.enabled ? ` · ${connected} on Google` : ""}
        </span>}
      </div>
      <CoachChips coaches={coaches} selected={selected} onChange={setSelected} onMore={() => setPicking(true)} />
      {g.data?.enabled && <GoogleBar google={g.data} />}
      {g.isError && <p className="hint" role="status">Google Calendar events didn't load. Interviews below are up to date.</p>}
      {body}
      <p className="cc-legend" aria-hidden="true">
        <span><i className="cc-swatch" /> Scheduled</span><span><i className="cc-swatch clash" /> Double-booked</span>
        <span><i className="cc-swatch done" /> Finished</span><span><i className="cc-swatch google" /> Google Calendar</span>
      </p>
      {panel && (
        <Drawer key={panel.kind === "event" ? eventKey(panel.e) : `${panel.coachId}|${panel.day}`} closeLabel="Close details" onClose={() => setPanel(null)}
          title={panel.kind === "event" ? look(panel.e, clashes.has(panel.e), now).who : `${names.get(panel.coachId) ?? "Coach"}’s day`}>
          {panel.kind === "event"
            ? <EventPanel e={panel.e} events={all} ctx={ctx} onCoach={openCoach} onOpenInterview={onOpenInterview} />
            : <CoachPanel coachId={panel.coachId} day={panel.day} events={all} allDay={allDay} ctx={ctx} />}
        </Drawer>
      )}
    </>
  );
}

/** Every coach's interviews in one place; the CEO also decides here who else may see it. */
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
