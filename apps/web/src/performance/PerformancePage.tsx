import { useId, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type Me } from "../api";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { localToday, shiftDays } from "../employees/employeesApi";
import { fmtDate } from "../sales/ui";
import {
  ACTIVITY_PAGE, KIND_LABELS, PERIOD_KINDS, PERIOD_KIND_LABELS, RATIO_LABELS, STATUS_LABELS, TARGET_METRICS,
  dayRange, pct, performanceApi, performanceError, performanceKeys, periodStartOf,
  type Kind, type PeriodKind, type Person, type PersonRow, type Ratios, type Target,
} from "./performanceApi";
import { QueryError } from "../ui/QueryError";

const fmtInstant = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
const RATIO_KEYS = Object.keys(RATIO_LABELS) as (keyof Ratios)[];
const DRILL_KINDS: Kind[] = ["submissions", "interviews", "interviewsCleared", "placements", "joined"];

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
  const [drill, setDrill] = useState<{ kind: Kind; userId: string | null; name: string } | null>(null);
  const [offset, setOffset] = useState(0);
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
  const s = summary.data;

  return (
    <>
      <div>
        <h1 tabIndex={-1}>Performance</h1>
        <p className="sub">Submissions, interviews and placements for the people you can see, with ratios, active candidates on projects and targets.</p>
      </div>
      {notice && <p className="muted" role="status">{notice}</p>}

      <form className="filters" aria-label="Performance period" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-from`}>From</label>
            <input id={`${id}-from`} type="date" value={from} onChange={(e) => { setFrom(e.target.value); setDrill(null); }} />
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-to`}>Through</label>
            <input id={`${id}-to`} type="date" value={through} onChange={(e) => { setThrough(e.target.value); setDrill(null); }}
              aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-range` : undefined} />
          </div>
        </div>
        {invalid && <p id={`${id}-range`} className="error" role="alert">Choose a start date on or before the end date.</p>}
      </form>

      {!invalid && (summary.isLoading ? <p className="empty">Loading…</p> : summary.error || !s ? (
        <QueryError query={summary} message={performanceError(summary.error)} />
      ) : (
        <section aria-labelledby={`${id}-totals`} aria-busy={summary.isFetching || undefined}>
          <h2 id={`${id}-totals`} className="sectiontitle">Activity, {fmtInstant(s.period.from)} – {fmtInstant(new Date(Date.parse(s.period.to) - 1).toISOString())}</h2>
          <ul className="tiles" aria-label="Totals">
            {s.kinds.map((k) => (
              <li key={k} className="tile card">
                <span className="tilelabel">{KIND_LABELS[k]}</span>
                <span className="tilevalue">{s.totals.counts[k]}</span>
                <button type="button" className="btn sm ghost" onClick={() => openDrill(k, null)}>Show rows<span className="sr-only">: {KIND_LABELS[k]}</span></button>
              </li>
            ))}
            {RATIO_KEYS.map((r) => (
              <li key={r} className="tile card"><span className="tilelabel">{RATIO_LABELS[r]}</span><span className="tilevalue">{pct(s.totals.ratios[r])}</span></li>
            ))}
          </ul>

          <div className="card tablewrap">
            <table aria-label="By person">
              <thead>
                <tr><th>Person</th><th>Team</th>{s.kinds.map((k) => <th key={k}>{KIND_LABELS[k]}</th>)}
                  {RATIO_KEYS.map((r) => <th key={r}>{RATIO_LABELS[r]}</th>)}</tr>
              </thead>
              <tbody>
                {s.people.map((p) => (
                  <tr key={p.user.id}>
                    <td>{p.user.name}{p.user.designation && <span className="block muted">{p.user.designation}</span>}</td>
                    <td>{p.team?.name ?? "—"}</td>
                    {s.kinds.map((k) => (
                      <td key={k}>
                        {p.counts[k] > 0 && DRILL_KINDS.includes(k)
                          ? <button type="button" className="btn sm ghost" aria-label={`${KIND_LABELS[k]} of ${p.user.name}: ${p.counts[k]}`} onClick={() => openDrill(k, p)}>{p.counts[k]}</button>
                          : p.counts[k]}
                      </td>
                    ))}
                    {RATIO_KEYS.map((r) => <td key={r}>{pct(p.ratios[r])}</td>)}
                  </tr>
                ))}
                {s.people.length === 0 && <tr><td colSpan={2 + s.kinds.length + RATIO_KEYS.length} className="empty">No one in your scope yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {drill && range && (
        <section aria-labelledby={`${id}-drill`} aria-busy={activity.isFetching || undefined}>
          <div className="toolbar">
            <h2 id={`${id}-drill`} className="sectiontitle">{KIND_LABELS[drill.kind]}: {drill.name}</h2>
            <button type="button" className="btn sm" onClick={() => setDrill(null)}>Close</button>
          </div>
          {activity.isLoading ? <p className="empty">Loading…</p> : activity.error || !activity.data ? (
            <p className="empty error" role="alert">{performanceError(activity.error)}</p>
          ) : (
            <>
              <div className="card tablewrap">
                <table aria-label={`${KIND_LABELS[drill.kind]} rows`}>
                  <thead><tr><th>Date</th><th>Candidate</th><th>Client</th><th>Recruiter</th><th>Status</th><th>Details</th></tr></thead>
                  <tbody>
                    {activity.data.items.map((i) => (
                      <tr key={i.id}>
                        <td>{fmtInstant(i.at)}</td>
                        <td>{i.candidate.name ?? <span className="muted">Name hidden</span>}</td>
                        <td>{i.client ?? "—"}</td>
                        <td>{i.recruiter.name ?? "—"}{i.team && <span className="block muted">{i.team}</span>}</td>
                        <td>{i.status.replace(/_/g, " ")}</td>
                        <td>{Object.entries(i.detail).filter(([, v]) => v).map(([k, v]) => `${k === "jobTitle" ? "" : `${k}: `}${v}`).join(" · ") || "—"}</td>
                      </tr>
                    ))}
                    {activity.data.items.length === 0 && <tr><td colSpan={6} className="empty">No rows in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
              {activity.data.total > ACTIVITY_PAGE && (
                <div className="toolbar" role="group" aria-label="Pages">
                  <span className="muted">{offset + 1}–{Math.min(offset + ACTIVITY_PAGE, activity.data.total)} of {activity.data.total}</span>
                  <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - ACTIVITY_PAGE))}>Previous</button>
                  <button type="button" className="btn sm" disabled={offset + ACTIVITY_PAGE >= activity.data.total} onClick={() => setOffset(offset + ACTIVITY_PAGE)}>Next</button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {!invalid && (
        <section aria-labelledby={`${id}-active`} aria-busy={active.isFetching || undefined}>
          <h2 id={`${id}-active`} className="sectiontitle">Active candidates on end-client projects</h2>
          {active.isLoading ? <p className="empty">Loading…</p> : active.error || !active.data ? (
            <p className="empty error" role="alert">{performanceError(active.error)}</p>
          ) : (
            <div className="card tablewrap">
              <table aria-label="Active candidates">
                <thead><tr><th>Candidate</th><th>Client</th><th>Vendor</th><th>Joining date</th><th>Recruiter</th></tr></thead>
                <tbody>
                  {active.data.items.map((a) => (
                    <tr key={a.assignmentId}>
                      <td>{a.candidate.name ?? <span className="muted">Name hidden</span>}</td>
                      <td>{a.client}{a.implementationPartner && <span className="block muted">via {a.implementationPartner}</span>}</td>
                      <td>{a.vendor ?? "—"}</td>
                      <td>{fmtDate(a.joiningDate)}{a.endDate && <span className="block muted">Ended {fmtDate(a.endDate)}</span>}</td>
                      <td>{a.recruiter.name ?? "—"}{a.team && <span className="block muted">{a.team}</span>}</td>
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
        <section aria-labelledby={`${id}-targets`} aria-busy={targets.isFetching || undefined}>
          <div className="toolbar">
            <h2 id={`${id}-targets`} className="sectiontitle">Targets</h2>
            {canSetTargets && <button type="button" className="btn primary sm" onClick={() => setDialog({ kind: "target" })}>Set target</button>}
          </div>
          {targets.isLoading ? <p className="empty">Loading…</p> : targets.error || !targets.data ? (
            <p className="empty error" role="alert">{performanceError(targets.error)}</p>
          ) : (
            <div className="card tablewrap">
              <table aria-label="Targets">
                <thead><tr><th>Person</th><th>Period</th>{TARGET_METRICS.map((m) => <th key={m}>{KIND_LABELS[m]}</th>)}<th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {targets.data.items.map((t) => (
                    <tr key={t.id}>
                      <td>{t.user.name ?? "—"}</td>
                      <td>{PERIOD_KIND_LABELS[t.periodKind]} {fmtDate(t.periodStart)} – {fmtDate(t.periodEnd)}</td>
                      {TARGET_METRICS.map((m) => (
                        <td key={m}>{t.targets[m] === null ? "—" : `${t.actuals[m] ?? "?"} / ${t.targets[m]}`}</td>
                      ))}
                      <td><span className={`badge ${t.status === "below" ? "st-backout" : t.status === "met" ? "st-joined" : ""}`}>{STATUS_LABELS[t.status]}</span></td>
                      <td>{t.canManage && (
                        <span className="rowactions">
                          <button type="button" className="btn sm" onClick={() => setDialog({ kind: "target", target: t })}
                            aria-label={`Change target of ${t.user.name ?? "this person"}`}>Change</button>
                          <button type="button" className="btn sm danger" onClick={() => setDialog({ kind: "deleteTarget", target: t })}
                            aria-label={`Delete target of ${t.user.name ?? "this person"}`}>Delete</button>
                        </span>
                      )}</td>
                    </tr>
                  ))}
                  {targets.data.items.length === 0 && <tr><td colSpan={3 + TARGET_METRICS.length + 1} className="empty">No targets overlap this period.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {manageable.length > 0 && people.data && (
        <section aria-labelledby={`${id}-people`}>
          <h2 id={`${id}-people`} className="sectiontitle">Teams and designations</h2>
          <div className="card tablewrap">
            <table aria-label="Teams and designations">
              <thead><tr><th>Person</th><th>Designation</th><th>Team</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {manageable.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.designation ?? "—"}</td>
                    <td>{p.team?.name ?? "—"}</td>
                    <td><span className="rowactions">
                      {p.canChangeDesignation && <button type="button" className="btn sm" aria-label={`Change designation of ${p.name}`}
                        onClick={() => setDialog({ kind: "designation", person: p })}>Change designation</button>}
                      {p.canMoveTeam && <button type="button" className="btn sm" aria-label={`Move ${p.name} to another team`}
                        onClick={() => setDialog({ kind: "move", person: p })}>Move to team…</button>}
                    </span></td>
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
    </>
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
