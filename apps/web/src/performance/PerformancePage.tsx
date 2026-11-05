import { useId, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type Me } from "../api";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { localToday, shiftDays } from "../employees/employeesApi";
import { Drawer, fmtDate } from "../sales/ui";
import { pipelineLabel } from "../pipeline/pipelineApi";
import { PRESET_DAYS, PeriodPresets } from "../dashboard/PeriodPresets";
import {
  ACTIVITY_PAGE, KIND_LABELS, PERIOD_KINDS, PERIOD_KIND_LABELS, RATIO_LABELS, STATUS_LABELS, TARGET_METRICS,
  dayRange, pct, performanceApi, performanceError, performanceKeys, periodStartOf,
  type Kind, type PeriodKind, type Person, type PersonRow, type Ratios, type Target,
} from "./performanceApi";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import "../dashboard/insights.css";
import "./performance.css";

const fmtInstant = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
const RATIO_KEYS = Object.keys(RATIO_LABELS) as (keyof Ratios)[];
const DRILL_KINDS: Kind[] = ["submissions", "interviews", "interviewsCleared", "placements", "joined"];

/** Short column heads for the ratios; the full name and formula are in the abbr title. */
const RATIO_SHORT: Record<keyof Ratios, string> = { submissionToInterview: "Sub → int", interviewToPlacement: "Int → plc", placement: "Plc rate" };
const RATIO_FORMULA: Record<keyof Ratios, string> = {
  submissionToInterview: "interviews ÷ submissions", interviewToPlacement: "placements ÷ interviews", placement: "placements ÷ submissions",
};

/** People shown before "Show all"; a list only a few longer than this is shown whole. */
const PEOPLE_PAGE = 15;
const NO_TEAM = "__none";

type SortKey = "activity" | "name" | Kind | keyof Ratios;
interface Sort { key: SortKey; desc: boolean }
const activityOf = (p: PersonRow) => Object.values(p.counts).reduce((n, v) => n + v, 0);

/** Most active first by default; people with no activity always sort after everyone with some. */
export function sortPeople(rows: PersonRow[], sort: Sort): PersonRow[] {
  const byName = (a: PersonRow, b: PersonRow) => a.user.name.localeCompare(b.user.name);
  const value = (p: PersonRow): number | null => sort.key === "activity" ? activityOf(p)
    : sort.key in p.counts ? p.counts[sort.key as Kind] : p.ratios[sort.key as keyof Ratios];
  return [...rows].sort((a, b) => {
    const za = activityOf(a) === 0, zb = activityOf(b) === 0;
    if (za !== zb) return za ? 1 : -1;
    if (sort.key === "name") return sort.desc ? byName(b, a) : byName(a, b);
    const va = value(a), vb = value(b);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return sort.desc ? vb - va : va - vb;
    }
    return byName(a, b);
  });
}

/** A column head that sorts the table; aria-sort on the th says which way. */
function SortTh({ k, sort, onSort, className, children }: {
  k: SortKey; sort: Sort; onSort: (s: Sort) => void; className?: string; children: ReactNode;
}) {
  const on = sort.key === k;
  const Icon = !on ? ArrowUpDown : sort.desc ? ArrowDown : ArrowUp;
  return (
    <th className={className} aria-sort={on ? (sort.desc ? "descending" : "ascending") : undefined} scope="col">
      <button type="button" className="ins-sort" onClick={() => onSort({ key: k, desc: on ? !sort.desc : k !== "name" })}>
        {children}<Icon size={12} aria-hidden="true" className="ins-sorticon" />
      </button>
    </th>
  );
}

/**
 * Performance (docs/performance-api.md): submissions, interviews and
 * placements per person with their ratios, the rows behind each count,
 * candidates active on end-client projects, and targets per period. The API
 * decides whose numbers the user sees (own, team, hierarchy, organisation);
 * managers and associate directors also set targets, change designations and
 * move people between teams here.
 */
export function PerformancePage({ me }: { me: Pick<Me, "capabilities"> }) {
  const id = useId();
  const qc = useQueryClient();
  const today = localToday();
  const [from, setFrom] = useState(shiftDays(today, -29));
  const [through, setThrough] = useState(today);
  const invalid = !from || !through || from > through;
  const range = useMemo(() => (invalid ? null : dayRange(from, through)), [from, through, invalid]);
  const preset = through === today ? PRESET_DAYS.find((n) => from === shiftDays(today, -(n - 1))) ?? null : null;
  const [drill, setDrill] = useState<{ kind: Kind; userId: string | null; name: string } | null>(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<Sort>({ key: "activity", desc: true });
  const [find, setFind] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [showIdle, setShowIdle] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: "target"; target?: Target } | { kind: "deleteTarget"; target: Target }
    | { kind: "designation"; person: Person } | { kind: "move"; person: Person } | null>(null);
  const [notice, setNotice] = useState("");
  const canSetTargets = can(me, "performance.target:manage");

  const summary = useQuery({
    queryKey: range ? performanceKeys.summary(range) : ["performance", "summary", "invalid"],
    queryFn: () => performanceApi.summary(range!),
    enabled: range !== null,
    placeholderData: keepPreviousData,
  });
  const activity = useQuery({
    queryKey: range && drill ? performanceKeys.activity(range, drill.kind, drill.userId, offset) : ["performance", "activity", "none"],
    queryFn: () => performanceApi.activity(range!, drill!.kind, drill!.userId, offset),
    enabled: range !== null && drill !== null,
    placeholderData: keepPreviousData,
  });
  const active = useQuery({
    queryKey: range ? performanceKeys.active(range) : ["performance", "active", "invalid"],
    queryFn: () => performanceApi.active(range!),
    enabled: range !== null,
    placeholderData: keepPreviousData,
  });
  const targets = useQuery({
    queryKey: performanceKeys.targets(from, through),
    queryFn: () => performanceApi.targets(from, through),
    enabled: !invalid,
    placeholderData: keepPreviousData,
  });
  const people = useQuery({ queryKey: performanceKeys.people, queryFn: performanceApi.people });
  const manageable = (people.data?.people ?? []).filter((p) => p.canChangeDesignation || p.canMoveTeam);
  const refresh = () => void qc.invalidateQueries({ queryKey: performanceKeys.all });

  const openDrill = (kind: Kind, p: PersonRow | null) => {
    setOffset(0);
    setDrill({ kind, userId: p?.user.id ?? null, name: p?.user.name ?? "everyone in your scope" });
  };
  const setPeriod = (f: string, t: string) => { setFrom(f); setThrough(t); setDrill(null); };
  const s = summary.data;
  const rows = useMemo(() => (s ? sortPeople(s.people, sort) : []), [s, sort]);
  const teams = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of s?.people ?? []) if (p.team) m.set(p.team.id, p.team.name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [s]);
  const hasNoTeam = (s?.people ?? []).some((p) => !p.team);
  const term = find.trim().toLowerCase();
  // Team and search narrow the list; people with no activity stay hidden unless asked for or searched by name.
  const inScope = rows.filter((p) => (!teamFilter || (teamFilter === NO_TEAM ? !p.team : p.team?.id === teamFilter))
    && (!term || p.user.name.toLowerCase().includes(term) || (p.user.designation ?? "").toLowerCase().includes(term)));
  const idle = inScope.filter((p) => activityOf(p) === 0).length;
  const matching = showIdle || term ? inScope : inScope.filter((p) => activityOf(p) > 0);
  const capped = !showAll && matching.length > PEOPLE_PAGE + 5;
  const shown = capped ? matching.slice(0, PEOPLE_PAGE) : matching;
  const sortValue = `${sort.key}:${sort.desc ? "desc" : "asc"}`;
  const periodText = s ? `${fmtInstant(s.period.from)} – ${fmtInstant(new Date(Date.parse(s.period.to) - 1).toISOString())}` : "";
  const drillCols = drill?.userId === null ? 6 : 5;

  return (
    <div className="perf">
      <div className="perf-head">
        <h1 tabIndex={-1}>Performance</h1>
        <p className="sub">Submissions, interviews and placements for the people you can see, with ratios, active candidates on projects and targets.</p>
      </div>
      {notice && <p className="muted" role="status">{notice}</p>}

      <form className="ins-period" aria-label="Performance period" onSubmit={(e) => e.preventDefault()}>
        <PeriodPresets value={preset} onChange={(n) => setPeriod(shiftDays(today, -(n - 1)), today)} />
        <div className="ins-dates">
          <div className="field inline">
            <label htmlFor={`${id}-from`}>From</label>
            <input id={`${id}-from`} type="date" value={from} onChange={(e) => setPeriod(e.target.value, through)} />
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-to`}>Through</label>
            <input id={`${id}-to`} type="date" value={through} onChange={(e) => setPeriod(from, e.target.value)}
              aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-range` : undefined} />
          </div>
        </div>
        {invalid && <p id={`${id}-range`} className="error perf-rangeerror" role="alert">Choose a start date on or before the end date.</p>}
      </form>

      {!invalid && (summary.isLoading ? <Loading /> : summary.error || !s ? (
        <QueryError query={summary} message={performanceError(summary.error)} />
      ) : (
        <>
          <section className="ins-section" aria-labelledby={`${id}-totals`} aria-busy={summary.isFetching || undefined}>
            <div className="ins-head">
              <h2 id={`${id}-totals`}>Activity<span className="sr-only">, {periodText}</span></h2>
              <span className="muted" aria-hidden="true">{periodText}</span>
            </div>
            <ul className="ins-tiles perf-tiles" aria-label="Totals">
              {s.kinds.map((k) => (
                <li key={k}>
                  <span className="tilelabel">{KIND_LABELS[k]}</span>
                  <span className="tilevalue">{s.totals.counts[k]}</span>
                  <span className="ins-sub">
                    {DRILL_KINDS.includes(k) && s.totals.counts[k] > 0 && (
                      <button type="button" className="linkbtn" onClick={() => openDrill(k, null)}>Show rows<span className="sr-only">: {KIND_LABELS[k]}</span></button>
                    )}
                  </span>
                </li>
              ))}
              <li className="perf-conv">
                <span className="tilelabel">Conversion</span>
                <dl>
                  {RATIO_KEYS.map((r) => (
                    <div key={r}><dt>{RATIO_LABELS[r]}</dt><dd>{pct(s.totals.ratios[r])}</dd></div>
                  ))}
                </dl>
              </li>
            </ul>
            <p className="ins-note">Submission → interview = interviews ÷ submissions. Interview → placement = placements ÷ interviews. Placement ratio = placements ÷ submissions.</p>
          </section>

          <section className="ins-section" aria-labelledby={`${id}-people-h`}>
            <div className="ins-head">
              <h2 id={`${id}-people-h`}>By person <span className="ins-count">{s.people.length}</span></h2>
              <span className="muted">{sort.key === "activity" ? "Most active first" : "Sorted by the chosen column"}. Select a count to see its rows.</span>
            </div>
            {s.people.length > 0 && (
              <div className="toolbar perf-filters" role="group" aria-label="Filter people">
                <div className="field inline perf-find">
                  <label htmlFor={`${id}-find`}>Find a person</label>
                  <input id={`${id}-find`} type="search" placeholder="Name or designation" value={find} onChange={(e) => setFind(e.target.value)} />
                </div>
                {teams.length + (hasNoTeam ? 1 : 0) > 1 && (
                  <div className="field inline">
                    <label htmlFor={`${id}-team`}>Team</label>
                    <select id={`${id}-team`} value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
                      <option value="">All teams</option>
                      {teams.map(([tid, name]) => <option key={tid} value={tid}>{name}</option>)}
                      {hasNoTeam && <option value={NO_TEAM}>No team</option>}
                    </select>
                  </div>
                )}
                <div className="field inline perf-sortpick">
                  <label htmlFor={`${id}-sort`}>Sort by</label>
                  <select id={`${id}-sort`} value={sortValue} onChange={(e) => {
                    const [key, dir] = e.target.value.split(":");
                    setSort({ key: key as SortKey, desc: dir === "desc" });
                  }}>
                    <option value="activity:desc">Most active</option>
                    <option value="name:asc">Name A–Z</option>
                    {s.kinds.map((k) => <option key={k} value={`${k}:desc`}>{KIND_LABELS[k]} (most first)</option>)}
                    {RATIO_KEYS.map((r) => <option key={r} value={`${r}:desc`}>{RATIO_LABELS[r]} (highest first)</option>)}
                    {!["activity:desc", "name:asc"].includes(sortValue) && !sortValue.endsWith(":desc") && <option value={sortValue}>Current column order</option>}
                  </select>
                </div>
                {idle > 0 && !term && (
                  <label className="perf-idletoggle">
                    <input type="checkbox" checked={showIdle} onChange={(e) => setShowIdle(e.target.checked)} />
                    Show {idle} with no activity
                  </label>
                )}
              </div>
            )}
            <div className="card tablewrap listcard">
              <table className="dtable perf-people" aria-label="By person">
                <thead>
                  <tr>
                    <SortTh k="name" sort={sort} onSort={setSort}>Person</SortTh>
                    <th scope="col" className="perf-teamh">Team</th>
                    {s.kinds.map((k) => <SortTh key={k} k={k} sort={sort} onSort={setSort} className="num">{KIND_LABELS[k]}</SortTh>)}
                    {RATIO_KEYS.map((r) => (
                      <SortTh key={r} k={r} sort={sort} onSort={setSort} className="num">
                        <abbr title={`${RATIO_LABELS[r]} = ${RATIO_FORMULA[r]}`}>{RATIO_SHORT[r]}</abbr><span className="sr-only">: {RATIO_LABELS[r]}</span>
                      </SortTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.user.id} className={activityOf(p) === 0 ? "perf-idle" : undefined}>
                      <td className="c-primary"><b>{p.user.name}</b>{p.user.designation && <span className="block muted">{p.user.designation}</span>}</td>
                      <td className="perf-team" data-label="Team">{p.team?.name ?? "—"}</td>
                      {s.kinds.map((k) => (
                        <td key={k} className="num perf-count" data-label={KIND_LABELS[k]}>
                          {p.counts[k] > 0 && DRILL_KINDS.includes(k)
                            ? <button type="button" className="ins-numlink" aria-label={`${KIND_LABELS[k]} of ${p.user.name}: ${p.counts[k]}`} onClick={() => openDrill(k, p)}>{p.counts[k]}</button>
                            : <span className={p.counts[k] === 0 ? "ins-zero" : undefined}>{p.counts[k]}</span>}
                        </td>
                      ))}
                      {RATIO_KEYS.map((r) => <td key={r} className="num perf-ratio" data-label={RATIO_SHORT[r]}>{pct(p.ratios[r])}</td>)}
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr><td colSpan={2 + s.kinds.length + RATIO_KEYS.length} className="empty">
                      {s.people.length === 0 ? "No one in your scope yet."
                        : inScope.length === 0 ? "No one matches these filters."
                          : `No activity in this period. ${idle === 1 ? "1 person has" : `${idle} people have`} none.`}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {(capped || (showAll && matching.length > PEOPLE_PAGE + 5)) && (
              <div className="toolbar perf-more">
                <span className="muted" role="status">Showing {shown.length} of {matching.length}</span>
                <button type="button" className="btn sm" aria-expanded={!capped} onClick={() => setShowAll(capped)}>
                  {capped ? `Show all ${matching.length}` : `Show top ${PEOPLE_PAGE}`}
                </button>
              </div>
            )}
          </section>
        </>
      ))}

      {drill && range && (
        <Drawer title={`${KIND_LABELS[drill.kind]}: ${drill.name}`} wide onClose={() => setDrill(null)} closeLabel="Close rows">
          <section className="perf-drill" aria-label={`${KIND_LABELS[drill.kind]} of ${drill.name}`} aria-busy={activity.isFetching || undefined}>
            <p className="muted">{periodText}{activity.data ? ` · ${activity.data.total} ${activity.data.total === 1 ? "row" : "rows"}` : ""}</p>
            {activity.isLoading ? <Loading /> : activity.error || !activity.data ? (
              <p className="empty error" role="alert">{performanceError(activity.error)}</p>
            ) : (
              <>
                <div className="card tablewrap listcard">
                  <table className="dtable" aria-label={`${KIND_LABELS[drill.kind]} rows`}>
                    <thead><tr><th scope="col">Candidate</th><th scope="col">Date</th><th scope="col">Client</th>
                      {drill.userId === null && <th scope="col">Recruiter</th>}<th scope="col">Status</th><th scope="col">Details</th></tr></thead>
                    <tbody>
                      {activity.data.items.map((i) => (
                        <tr key={i.id}>
                          <td className="c-primary">{i.candidate.name ? <b>{i.candidate.name}</b> : <span className="muted">Name hidden</span>}</td>
                          <td data-label="Date" className="perf-date">{fmtInstant(i.at)}</td>
                          <td data-label="Client">{i.client ?? "—"}</td>
                          {drill.userId === null && <td data-label="Recruiter">{i.recruiter.name ?? "—"}{i.team && <span className="block muted">{i.team}</span>}</td>}
                          <td className="c-badge"><span className={`badge st-${i.status}`}>{pipelineLabel(i.status)}</span></td>
                          <td data-label="Details">{Object.entries(i.detail).filter(([, v]) => v).map(([k, v]) => `${k === "jobTitle" ? "" : `${k}: `}${v}`).join(" · ") || "—"}</td>
                        </tr>
                      ))}
                      {activity.data.items.length === 0 && <tr><td colSpan={drillCols} className="empty">No rows in this period.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {activity.data.total > ACTIVITY_PAGE && (
                  <div className="toolbar perf-pager" role="group" aria-label="Pages">
                    <span className="muted">{offset + 1}–{Math.min(offset + ACTIVITY_PAGE, activity.data.total)} of {activity.data.total}</span>
                    <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - ACTIVITY_PAGE))}>Previous</button>
                    <button type="button" className="btn sm" disabled={offset + ACTIVITY_PAGE >= activity.data.total} onClick={() => setOffset(offset + ACTIVITY_PAGE)}>Next</button>
                  </div>
                )}
              </>
            )}
          </section>
        </Drawer>
      )}

      {!invalid && (
        <section className="ins-section" aria-labelledby={`${id}-active`} aria-busy={active.isFetching || undefined}>
          <div className="ins-head">
            <h2 id={`${id}-active`}>Active candidates on end-client projects {active.data && <span className="ins-count">{active.data.total}</span>}</h2>
            <span className="muted">On a project on any day of the period, including projects that ended in it.</span>
          </div>
          {active.isLoading ? <Loading /> : active.error || !active.data ? (
            <p className="empty error" role="alert">{performanceError(active.error)}</p>
          ) : (
            <div className="card tablewrap listcard">
              <table className="dtable" aria-label="Active candidates">
                <thead><tr><th scope="col">Candidate</th><th scope="col">Client</th><th scope="col">Vendor</th><th scope="col">Joining date</th><th scope="col">Recruiter</th></tr></thead>
                <tbody>
                  {active.data.items.map((a) => (
                    <tr key={a.assignmentId}>
                      <td className="c-primary">{a.candidate.name ? <b>{a.candidate.name}</b> : <span className="muted">Name hidden</span>}</td>
                      <td data-label="Client">{a.client}{a.implementationPartner && <span className="block muted">via {a.implementationPartner}</span>}</td>
                      <td data-label="Vendor">{a.vendor ?? "—"}</td>
                      <td data-label="Joining date">{fmtDate(a.joiningDate)}{a.endDate && <span className="block muted">Ended {fmtDate(a.endDate)}</span>}</td>
                      <td data-label="Recruiter">{a.recruiter.name ?? "—"}{a.team && <span className="block muted">{a.team}</span>}</td>
                    </tr>
                  ))}
                  {active.data.items.length === 0 && <tr><td colSpan={5} className="empty">No candidates on a project in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {active.data?.truncated && <p className="muted" role="status">Showing the first {active.data.items.length} of {active.data.total}. Choose a shorter period to see the rest.</p>}
        </section>
      )}

      {!invalid && (
        <section className="ins-section" aria-labelledby={`${id}-targets`} aria-busy={targets.isFetching || undefined}>
          <div className="ins-head">
            <h2 id={`${id}-targets`}>Targets {targets.data && targets.data.items.length > 0 && <span className="ins-count">{targets.data.items.length}</span>}</h2>
            {canSetTargets && <button type="button" className="btn primary sm" onClick={() => setDialog({ kind: "target" })}>Set target</button>}
          </div>
          {targets.isLoading ? <Loading /> : targets.error || !targets.data ? (
            <p className="empty error" role="alert">{performanceError(targets.error)}</p>
          ) : targets.data.items.length === 0 ? (
            <p className="card perf-empty muted">No targets overlap this period.</p>
          ) : (
            <div className="card tablewrap listcard">
              <table className="dtable" aria-label="Targets">
                <thead><tr><th scope="col">Person</th><th scope="col">Period</th>{TARGET_METRICS.map((m) => <th key={m} scope="col" className="num">{KIND_LABELS[m]}</th>)}
                  <th scope="col">Status</th><th className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {targets.data.items.map((t) => (
                    <tr key={t.id}>
                      <td className="c-primary"><b>{t.user.name ?? "—"}</b></td>
                      <td data-label="Period">{PERIOD_KIND_LABELS[t.periodKind]} {fmtDate(t.periodStart)} – {fmtDate(t.periodEnd)}</td>
                      {TARGET_METRICS.map((m) => (
                        <td key={m} className="num" data-label={KIND_LABELS[m]}>{t.targets[m] === null ? "—" : `${t.actuals[m] ?? "?"} / ${t.targets[m]}`}</td>
                      ))}
                      <td className="c-badge"><span className={`badge ${t.status === "below" ? "st-backout" : t.status === "met" ? "st-joined" : ""}`}>{STATUS_LABELS[t.status]}</span></td>
                      <td className="c-act">{t.canManage && (
                        <>
                          <button type="button" className="btn sm" onClick={() => setDialog({ kind: "target", target: t })}
                            aria-label={`Change target of ${t.user.name ?? "this person"}`}>Change</button>
                          <button type="button" className="btn sm danger" onClick={() => setDialog({ kind: "deleteTarget", target: t })}
                            aria-label={`Delete target of ${t.user.name ?? "this person"}`}>Delete</button>
                        </>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {manageable.length > 0 && people.data && (
        <section className="ins-section" aria-labelledby={`${id}-people`}>
          <div className="ins-head"><h2 id={`${id}-people`}>Teams and designations <span className="ins-count">{manageable.length}</span></h2></div>
          <div className="card tablewrap listcard">
            <table className="dtable" aria-label="Teams and designations">
              <thead><tr><th scope="col">Person</th><th scope="col">Designation</th><th scope="col">Team</th><th className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {manageable.map((p) => (
                  <tr key={p.id}>
                    <td className="c-primary"><b>{p.name}</b></td>
                    <td data-label="Designation">{p.designation ?? "—"}</td>
                    <td data-label="Team">{p.team?.name ?? "—"}</td>
                    <td className="c-act">
                      {p.canChangeDesignation && <button type="button" className="btn sm" aria-label={`Change designation of ${p.name}`}
                        onClick={() => setDialog({ kind: "designation", person: p })}>Change designation</button>}
                      {p.canMoveTeam && <button type="button" className="btn sm" aria-label={`Move ${p.name} to another team`}
                        onClick={() => setDialog({ kind: "move", person: p })}>Move to team…</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {dialog?.kind === "target" && (
        <TargetDialog people={(people.data?.people ?? []).filter((p) => p.canSetTarget)} initial={dialog.target} today={today}
          onClose={() => setDialog(null)} onSaved={(msg) => { setDialog(null); setNotice(msg); refresh(); }} />
      )}
      {dialog?.kind === "deleteTarget" && (
        <ConfirmDialog title="Delete target" confirmLabel="Delete" danger formatError={performanceError}
          action={() => performanceApi.deleteTarget(dialog.target.id)} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setNotice("Target deleted."); refresh(); }}>
          Delete the {PERIOD_KIND_LABELS[dialog.target.periodKind].toLowerCase()} target of {dialog.target.user.name ?? "this person"} starting {fmtDate(dialog.target.periodStart)}?
        </ConfirmDialog>
      )}
      {dialog?.kind === "designation" && (
        <DesignationDialog person={dialog.person} onClose={() => setDialog(null)}
          onSaved={(msg) => { setDialog(null); setNotice(msg); refresh(); }} />
      )}
      {dialog?.kind === "move" && people.data && (
        <MoveDialog person={dialog.person} teams={people.data.moveTeams} onClose={() => setDialog(null)}
          onMoved={(msg) => { setDialog(null); setNotice(msg); refresh(); }} />
      )}
    </div>
  );
}

const toCount = (v: string) => (v.trim() === "" ? null : Number(v));

function TargetDialog({ people, initial, today, onClose, onSaved }: {
  people: Person[]; initial?: Target; today: string; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const id = useId();
  const [userId, setUserId] = useState(initial?.user.id ?? "");
  const [kind, setKind] = useState<PeriodKind>(initial?.periodKind ?? "month");
  const [day, setDay] = useState(initial?.periodStart ?? today);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(TARGET_METRICS.map((m) => [m, initial?.targets[m] == null ? "" : String(initial.targets[m])])));
  const { busy, error, setError, run } = useSubmit(performanceError);
  const start = day ? periodStartOf(kind, day) : "";
  const nums = TARGET_METRICS.map((m) => toCount(values[m] ?? ""));
  const anySet = nums.some((n) => n !== null);
  const badNumber = nums.some((n) => n !== null && (!Number.isInteger(n) || n < 0 || n > 100000));
  const name = people.find((p) => p.id === userId)?.name ?? "";
  return (
    <Dialog title={initial ? "Change target" : "Set target"} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (badNumber) { setError("Targets are whole numbers from 0 to 100,000."); return; }
        void run(async () => {
          const [submissions, interviews, placements] = nums as [number | null, number | null, number | null];
          const r = await performanceApi.setTarget({ userId, periodKind: kind, periodStart: start, submissions, interviews, placements });
          onSaved(`${r.created ? "Target set" : "Target updated"} for ${name}.`);
        });
      }}>
        <div className="dialogbody">
          <div className="field"><label htmlFor={`${id}-who`}>Person</label>
            <select id={`${id}-who`} required data-autofocus value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="" disabled>Choose a person…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.team ? ` (${p.team.name})` : ""}</option>)}
            </select></div>
          <div className="field"><label htmlFor={`${id}-kind`}>Period</label>
            <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as PeriodKind)}>
              {PERIOD_KINDS.map((k) => <option key={k} value={k}>{PERIOD_KIND_LABELS[k]}</option>)}
            </select></div>
          <div className="field"><label htmlFor={`${id}-day`}>Any day in the period</label>
            <input id={`${id}-day`} type="date" required value={day} onChange={(e) => setDay(e.target.value)} aria-describedby={`${id}-start`} />
            <small id={`${id}-start`} className="hint">{start ? `The ${PERIOD_KIND_LABELS[kind].toLowerCase()} starting ${fmtDate(start)}.` : ""}</small></div>
          {TARGET_METRICS.map((m) => (
            <div key={m} className="field"><label htmlFor={`${id}-${m}`}>{KIND_LABELS[m]}</label>
              <input id={`${id}-${m}`} type="number" inputMode="numeric" min={0} max={100000} step={1} value={values[m]}
                onChange={(e) => setValues({ ...values, [m]: e.target.value })} /></div>
          ))}
          <p className="hint">Leave a number empty for no target on it. Recruiters, their lead and manager are notified when a period ends below target.</p>
        </div>
        <DialogActions onCancel={onClose} submitLabel="Save target" busy={busy} error={error} disabled={!userId || !start || !anySet} />
      </form>
    </Dialog>
  );
}

function DesignationDialog({ person, onClose, onSaved }: { person: Person; onClose: () => void; onSaved: (msg: string) => void }) {
  const id = useId();
  const [value, setValue] = useState(person.designation ?? "");
  const { busy, error, run } = useSubmit(performanceError);
  return (
    <Dialog title={`Designation of ${person.name}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const r = await performanceApi.setDesignation(person.id, value.trim() || null);
          onSaved(r.designation ? `${person.name} is now ${r.designation}.` : `Designation of ${person.name} cleared.`);
        });
      }}>
        <div className="dialogbody">
          <div className="field"><label htmlFor={`${id}-d`}>Designation</label>
            <input id={`${id}-d`} data-autofocus maxLength={120} value={value} onChange={(e) => setValue(e.target.value)} aria-describedby={`${id}-h`} />
            <small id={`${id}-h`} className="hint">A title shown with the name. It does not change what they can see or do.</small></div>
        </div>
        <DialogActions onCancel={onClose} submitLabel="Save" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

function MoveDialog({ person, teams, onClose, onMoved }: {
  person: Person; teams: { id: string; name: string }[]; onClose: () => void; onMoved: (msg: string) => void;
}) {
  const id = useId();
  const [toTeamId, setToTeamId] = useState("");
  const { busy, error, run } = useSubmit(performanceError);
  const targets = teams.filter((t) => t.id !== person.memberOfTeamId);
  const toName = targets.find((t) => t.id === toTeamId)?.name ?? "";
  return (
    <Dialog title={`Move ${person.name} to another team`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const r = await performanceApi.moveMember(person.memberOfTeamId!, person.id, toTeamId);
          onMoved(`Moved ${person.name} to ${toName}. ${r.movedCandidates} candidate${r.movedCandidates === 1 ? "" : "s"} reassigned to ${r.reassignedTo.displayName ?? "the team lead"}.`);
        });
      }}>
        <div className="dialogbody">
          <p className="hint">Their candidates stay with {person.team?.name ?? "the current team"} and go to its lead.</p>
          <div className="field"><label htmlFor={`${id}-t`}>Move to team</label>
            <select id={`${id}-t`} required data-autofocus value={toTeamId} onChange={(e) => setToTeamId(e.target.value)}>
              <option value="" disabled>Choose a team…</option>
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></div>
        </div>
        <DialogActions onCancel={onClose} submitLabel="Move" busy={busy} error={error} disabled={!toTeamId} />
      </form>
    </Dialog>
  );
}
