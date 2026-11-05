import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type Me } from "../api";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { DocumentsSection } from "../documents/DocumentsSection";
import { saveBlob } from "../lib/download";
import { docTypeLabel } from "../lib/format";
import { useRoutedId, useSearchParam } from "../lib/router";
import { FilterBar, type FilterChip } from "../ui/FilterBar";
import { RecordLink } from "../ui/RecordLink";
import { Tabs } from "../ui/Tabs";
import { ContractsSection } from "./ContractsSection";
import { ClearedInterviews } from "./ClearedInterviews";
import { Drawer, Field, fmtDate } from "../sales/ui";
import { RoleName, useLookups, type Named } from "../lookups";
import { pipelineError } from "./errors";
import { paperworkApi, paperworkKeys } from "../paperwork/paperworkApi";
import {
  CONTACT_KIND_LABELS, PLACEMENT_EXPORT_ROW_CAP, PLACEMENT_STATUSES, PLACEMENT_TYPE_LABELS, WORK_MODE_LABELS,
  ISO_DAY, dayBoundary, fmtDateTime, fmtRate, pipelineApi, pipelineKeys, pipelineLabel, type Placement, type PlacementFilters,
} from "./pipelineApi";
import { FirstPlacementBadge, PipelineStatus, fromControl, useBatchOptions, useDebouncedParam } from "./ui";
import "./pipeline.css";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";

const PAGE_SIZE = 50;
/** Exits that need a confirmation and a reason (PL-4). */
const EXITS = new Set(["backout", "bgc_failed", "joining_issue"]);
const EXIT_TEXT: Record<string, string> = {
  backout: "The candidate backed out before joining. They return to Active marketing.",
  bgc_failed: "The background check failed. Before joining the candidate returns to Active; after joining the open assignment ends and they move to Bench.",
  joining_issue: "The candidate could not join because of an issue at joining. They return to Active marketing, and the submission can be placed again.",
};
const EXIT_LABEL: Record<string, string> = { backout: "Mark backout", bgc_failed: "Mark BGC failed", joining_issue: "Mark joining issue" };

/** One report filter over a lookup list; hidden when the server withholds the list (it returns []). */
function LookupFilter({ id, label, items, value, onChange }: { id: string; label: string; items: Named[]; value: string; onChange: (v: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="field inline">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
    </div>
  );
}

/** Re-confirmed existing consultant (entered on placement entry). */
const ReconfirmedBadge = () => <span className="badge">Re-confirmed</span>;

/** "2 of 3 done (1 required open, 1 overdue)": verified or waived items count as done. */
function ChecklistProgress({ items }: { items: NonNullable<Placement["checklist"]> }) {
  const done = items.filter((c) => c.status === "verified" || c.status === "waived").length;
  const requiredOpen = items.filter((c) => c.required && (c.status === "pending" || c.status === "received")).length;
  const overdue = items.filter((c) => c.overdue).length;
  const extra = [requiredOpen ? `${requiredOpen} required open` : "", overdue ? `${overdue} overdue` : ""].filter(Boolean).join(", ");
  return (
    <p className="muted">
      <progress max={items.length} value={done} aria-label="Paperwork done" /> {done} of {items.length} done{extra && ` (${extra})`}
    </p>
  );
}

const where = (p: Pick<Placement, "projectCity" | "projectState">) => [p.projectCity, p.projectState].filter(Boolean).join(", ");

/** Days from today to a YYYY-MM-DD date (negative when past). */
const daysUntil = (day: string) => {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((+new Date(`${day.slice(0, 10)}T00:00:00`) - +t) / 86_400_000);
};
const OPEN = new Set(["confirmed", "paperwork", "bgc", "ready"]);
/** "in 5 days", "today", "3 days ago": the start, relative, for open placements. */
function startNote(p: Pick<Placement, "status" | "tentativeStart" | "actualStart">): { text: string; tone: "" | "soon" | "past" } | null {
  if (!OPEN.has(p.status) || p.actualStart) return null;
  const d = daysUntil(p.tentativeStart);
  if (d === 0) return { text: "Starts today", tone: "soon" };
  if (d > 0) return { text: d === 1 ? "Starts tomorrow" : `Starts in ${d} days`, tone: d <= 7 ? "soon" : "" };
  return { text: `Start date passed ${-d} ${d === -1 ? "day" : "days"} ago`, tone: "past" };
}

/** Placements list (GET /api/v1/placements) with a detail drawer for contacts, assignment and status changes. */
export function PlacementsPage({ me, initialOpenId = null, onOpenChange, onOpenSubmission }: {
  me?: Pick<Me, "capabilities">; initialOpenId?: string | null;
  /** The open placement changed (the shell keeps it in the URL). */
  onOpenChange?: (id: string | null) => void;
  /** Opens the source submission (the Submissions drawer); without it the submission is not linked. */
  onOpenSubmission?: (id: string) => void;
}) {
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Filters live in the address bar (?status=&from=&to=&vendorId=…&candidate=), so a refresh or a shared link keeps them.
  const [statusParam, setStatusRaw] = useSearchParam("status");
  const [fromParam, setFromRaw] = useSearchParam("from");
  const [toParam, setToRaw] = useSearchParam("to");
  const [vendorId, setVendorId] = useSearchParam("vendorId");
  const [clientId, setClientId] = useSearchParam("clientId");
  const [technologyId, setTechnologyId] = useSearchParam("technologyId");
  const [locationId, setLocationId] = useSearchParam("locationId");
  const [teamId, setTeamId] = useSearchParam("teamId");
  const [batchId, setBatchId] = useSearchParam("batchId");
  const [candidateInput, setCandidateInput, candidate] = useDebouncedParam("candidate");
  // ?view=cleared: rounds marked Cleared on the Interviews board (migration 0360).
  const [viewParam] = useSearchParam("view");
  const canSeeCleared = can(me, "interview:read");
  const view = viewParam === "cleared" && canSeeCleared ? "cleared" : "placements";
  const status = (PLACEMENT_STATUSES as readonly string[]).includes(statusParam) ? statusParam : "";
  const from = ISO_DAY.test(fromParam) ? fromParam : "";
  const to = ISO_DAY.test(toParam) ? toParam : "";
  // Lookup ids from a link go to the API as they are (it validates them); an unknown one matches nothing.
  const report = { vendorId, clientId, technologyId, locationId, teamId, batchId };
  const reportSetters = { vendorId: setVendorId, clientId: setClientId, technologyId: setTechnologyId, locationId: setLocationId, teamId: setTeamId, batchId: setBatchId };
  const setReportKey = (k: keyof typeof report) => (v: string) => { reportSetters[k](v); reset(); };
  const lookups = useLookups();
  const batches = useBatchOptions(me);
  // A team lead's scope is one team: the filter shows only when there is more than one to pick.
  const teams = useQuery({ queryKey: [...pipelineKeys.placements, "teams"], queryFn: () => pipelineApi.placementTeams(), staleTime: 60_000 });
  const teamItems = (teams.data?.items.length ?? 0) > 1 ? teams.data!.items : [];
  const canExport = can(me, "report:export");
  const exportRun = useMutation({
    mutationFn: () => pipelineApi.exportPlacements({
      status, from: from ? dayBoundary(from) : "", to: to ? dayBoundary(to, true) : "", ...report, candidate,
    }),
    onSuccess: (r) => saveBlob(r.blob, r.filename),
  });
  const pager = useCursorPager();
  const { page, reset } = pager;
  useEffect(() => { reset(); }, [candidate, reset]);
  const invalidRange = Boolean(from && to && from > to);
  const [openId, setOpenId] = useRoutedId(initialOpenId, onOpenChange);
  const [notice, setNotice] = useState("");

  const filters = {
    status, from: from ? dayBoundary(from) : "", to: to ? dayBoundary(to, true) : "", ...report, candidate, cursor: pager.cursor ?? "", limit: PAGE_SIZE,
  };
  const q = useQuery({
    queryKey: [...pipelineKeys.placements, "list", filters],
    queryFn: () => pipelineApi.placements(filters),
    placeholderData: keepPreviousData,
    enabled: !invalidRange && view === "placements",
  });
  const items = q.data?.items ?? [];
  const showRate = items.some((p) => "rate" in p);
  const hasFilters = Boolean(status || from || to || candidate || Object.values(report).some(Boolean));
  const n = items.length;
  const countMsg = q.isLoading || q.error || invalidRange ? ""
    : `${n} ${n === 1 ? "placement" : "placements"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;
  const canOpenCandidate = can(me, "candidate:read");

  const close = () => {
    setOpenId(null);
    // Opened from another screen, there's no row to return to: land on the heading.
    setTimeout(() => { if (document.activeElement === document.body) headingRef.current?.focus(); });
  };
  const clearAll = () => { setStatusRaw(""); setFromRaw(""); setToRaw(""); setCandidateInput(""); for (const set of Object.values(reportSetters)) set(""); reset(); };

  const nameOf = (items: readonly Named[], v: string) => items.find((i) => i.id === v)?.name ?? "Selected";
  const chips: FilterChip[] = [];
  const more: [keyof typeof report, string, readonly Named[]][] = [
    ["batchId", "Batch", batches], ["vendorId", "Vendor", lookups.data?.vendors ?? []], ["clientId", "End client", lookups.data?.clients ?? []],
    ["technologyId", "Technology", lookups.data?.technologies ?? []], ["teamId", "Team", teamItems], ["locationId", "Location", lookups.data?.locations ?? []],
  ];
  for (const [k, label, list] of more) if (report[k]) chips.push({ key: k, label: `${label}: ${nameOf(list, report[k])}`, onRemove: () => setReportKey(k)("") });
  const activeCount = [status, from, to, candidate].filter(Boolean).length + chips.length;

  const candidateField = (
    <div className="field inline fb-search">
      <label htmlFor={`${id}-candidate`}>Candidate</label>
      <input id={`${id}-candidate`} type="search" placeholder="Search by name" value={candidateInput} onChange={(e) => setCandidateInput(e.target.value)} />
    </div>
  );

  const list = (
    <>
      <FilterBar label="Placement filters" hasFilters={hasFilters} onClear={clearAll} chips={chips} moreCount={chips.length} activeCount={activeCount}
        search={candidateField}
        primary={<>
          <div className="field inline fb-status">
            <label htmlFor={`${id}-status`}>Status</label>
            <select id={`${id}-status`} value={status} onChange={(e) => { setStatusRaw(e.target.value); reset(); }}>
              <option value="">Any status</option>
              {PLACEMENT_STATUSES.map((st) => <option key={st} value={st}>{pipelineLabel(st)}</option>)}
            </select>
          </div>
          <div className="field inline pl-date">
            <label htmlFor={`${id}-from`}>Created from</label>
            <input id={`${id}-from`} type="date" value={from} onChange={(e) => { setFromRaw(e.target.value); reset(); }} />
          </div>
          <div className="field inline pl-date">
            <label htmlFor={`${id}-to`}>Created through</label>
            <input id={`${id}-to`} type="date" value={to} onChange={(e) => { setToRaw(e.target.value); reset(); }}
              aria-invalid={invalidRange || undefined} aria-describedby={invalidRange ? `${id}-range` : undefined} />
          </div>
        </>}
        more={<>
          <LookupFilter id={`${id}-batch`} label="Batch" items={batches} value={report.batchId} onChange={setReportKey("batchId")} />
          <LookupFilter id={`${id}-vendor`} label="Vendor" items={lookups.data?.vendors ?? []} value={report.vendorId} onChange={setReportKey("vendorId")} />
          <LookupFilter id={`${id}-client`} label="End client" items={lookups.data?.clients ?? []} value={report.clientId} onChange={setReportKey("clientId")} />
          <LookupFilter id={`${id}-tech`} label="Technology" items={lookups.data?.technologies ?? []} value={report.technologyId} onChange={setReportKey("technologyId")} />
          <LookupFilter id={`${id}-team`} label="Team" items={teamItems} value={report.teamId} onChange={setReportKey("teamId")} />
          <LookupFilter id={`${id}-loc`} label="Location" items={lookups.data?.locations ?? []} value={report.locationId} onChange={setReportKey("locationId")} />
        </>}
      />
      {invalidRange && <p id={`${id}-range`} className="error" role="alert">“Created through” must be on or after “Created from”.</p>}

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      {!invalidRange && (
        <div className="card tablewrap listcard">
          {q.isLoading ? <Loading /> : q.error ? (
            <QueryError query={q} message={pipelineError(q.error, "placement")} />
          ) : (
            <table className="dtable pl-list" aria-label="Placements" aria-busy={q.isFetching || undefined}>
              <thead><tr>
                <th>Candidate</th><th>Client / vendor</th><th>Type</th><th>Start</th><th>Status</th><th className="p2">Recruiter</th>
                {showRate && <th className="num">Rate</th>}
                <th className="c-act"><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>
                {items.map((p) => {
                  const note = startNote(p);
                  return (
                    <tr key={p.id} className="rowopen" onClick={(e) => { if (!fromControl(e)) setOpenId(p.id); }}>
                      <td className="c-primary">
                        <RecordLink kind="candidate" id={p.candidate.id} allowed={canOpenCandidate}><b>{p.candidate.name}</b></RecordLink>
                        {p.isFirstPlacement && <span className="pl-tag" title="This is the candidate's first placement">First placement</span>}
                        {p.reconfirmed && <>{" "}<ReconfirmedBadge /></>}
                        {p.technology && <small className="block muted">{p.technology.name}</small>}
                      </td>
                      <td data-label="Client"><span>{p.client.name}<small className="block muted">{p.vendor?.name ?? "No vendor"}</small></span></td>
                      <td data-label="Type"><span>{PLACEMENT_TYPE_LABELS[p.placementType] ?? p.placementType}<small className="block muted">{WORK_MODE_LABELS[p.workMode] ?? p.workMode}{where(p) && ` · ${where(p)}`}</small></span></td>
                      <td data-label="Start" className="pl-nowrap"><span>{p.actualStart ? fmtDate(p.actualStart) : <>{fmtDate(p.tentativeStart)} <span className="muted">(tentative)</span></>}
                        {note && <small className={`block pl-next ${note.tone}`}>{note.text}</small>}</span></td>
                      <td className="c-badge" data-label="Status"><PipelineStatus status={p.status} /></td>
                      <td className="p2" data-label="Recruiter"><span>{p.recruiter.name}<small className="block muted">{p.team.name}</small></span></td>
                      {showRate && <td className="num" data-label="Rate">{"rate" in p ? fmtRate(p.rate) : <span className="muted">—</span>}</td>}
                      <td className="c-act">
                        <button type="button" className="btn sm" onClick={() => setOpenId(p.id)} aria-label={`Open placement of ${p.candidate.name} at ${p.client.name}`}>Open</button>
                      </td>
                    </tr>
                  );
                })}
                {items.length === 0 && (
                  <tr><td colSpan={showRate ? 8 : 7} className="empty">{hasFilters ? "No placements match these filters." : "No placements yet. Create one from a selected submission."}</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <Pager pager={pager} label="Placement pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>
    </>
  );

  const cleared = (
    <>
      <form className="filterbar" role="search" aria-label="Cleared interview filters" onSubmit={(e) => e.preventDefault()}>
        <div className="fb-row pl-clearedfilters">
          <div className="field inline fb-search">
            <label htmlFor={`${id}-ccand`}>Candidate</label>
            <input id={`${id}-ccand`} type="search" placeholder="Search by name" value={candidateInput} onChange={(e) => setCandidateInput(e.target.value)} />
          </div>
          <LookupFilter id={`${id}-cbatch`} label="Batch" items={batches} value={batchId} onChange={setBatchId} />
          <LookupFilter id={`${id}-cteam`} label="Team" items={teamItems} value={teamId} onChange={setTeamId} />
        </div>
      </form>
      <ClearedInterviews teamId={teamId} candidate={candidate} batchId={batchId} onOpenPlacement={(pid) => setOpenId(pid)} canOpenCandidate={canOpenCandidate} />
    </>
  );

  return (
    <section className="panel plpage">
      <div className="pagehead">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>Placements{view === "placements" && !q.isLoading && !q.error && !invalidRange && <span className="h1count" aria-hidden="true">{n}{q.data?.nextCursor ? "+" : ""}</span>}</h1>
          <p className="sub">Confirmed offers through joining. Open a placement to see its next step, contacts and paperwork.</p>
        </div>
        {canExport && view === "placements" && (
          <div className="pageactions push export pl-export">
            <button type="button" className="btn" disabled={exportRun.isPending || invalidRange} onClick={() => exportRun.mutate()}
              title={`Exports placements matching these filters in your scope, up to ${PLACEMENT_EXPORT_ROW_CAP.toLocaleString("en-US")} rows. No rates or contacts.`}>
              {exportRun.isPending ? "Exporting…" : "Export CSV"}
            </button>
            <small className="hint">Matching filters, up to {PLACEMENT_EXPORT_ROW_CAP.toLocaleString("en-US")} rows. No rates or contacts.</small>
            <p role="status" aria-live="polite" className={exportRun.isError ? "error" : "muted"}>
              {exportRun.isError ? pipelineError(exportRun.error, "generic")
                : exportRun.data ? `Exported ${exportRun.data.rows} ${exportRun.data.rows === 1 ? "row" : "rows"}${exportRun.data.truncated ? " (limit reached; narrow the filters)" : ""}.` : ""}
            </p>
          </div>
        )}
      </div>

      {canSeeCleared ? (
        <Tabs label="Placements sections" urlKey="view" defaultValue="placements" panelClassName="pl-tabpanel"
          tabs={[{ key: "placements", label: "Placements" }, { key: "cleared", label: "Cleared interviews" }]}>
          {(tab) => (tab === "cleared" ? cleared : list)}
        </Tabs>
      ) : list}

      {openId && <PlacementDrawer id={openId} initial={items.find((p) => p.id === openId) ?? null} onClose={close} onNotice={setNotice}
        canReadDocuments={can(me, "document:read")} canOpenCandidate={canOpenCandidate}
        canOpenPaperwork={can(me, "document:read") || can(me, "bgc:update")} onOpenSubmission={onOpenSubmission} />}
    </section>
  );
}

const STEPS = ["confirmed", "paperwork", "bgc", "ready", "joined"] as const;

/** Confirmed · Paperwork · BGC · Ready · Joined, the current step filled; exits mark the last step reached. */
function StageStepper({ status }: { status: string }) {
  const at = (STEPS as readonly string[]).indexOf(status);
  const exited = at < 0;
  return (
    <ol className={`pl-steps${exited ? " exited" : ""}`} aria-label="Placement stages">
      {STEPS.map((st, i) => {
        const state = i === at ? "now" : i < at ? "done" : "";
        return <li key={st} className={state} aria-current={i === at ? "step" : undefined}>{pipelineLabel(st)}{i < at && <span className="sr-only"> (done)</span>}</li>;
      })}
    </ol>
  );
}

function PlacementDrawer({ id, initial, onClose, onNotice, canReadDocuments = false, canOpenCandidate = false, canOpenPaperwork = false, onOpenSubmission }: {
  id: string; initial: Placement | null; onClose: () => void; onNotice: (m: string) => void; canReadDocuments?: boolean;
  canOpenCandidate?: boolean; canOpenPaperwork?: boolean; onOpenSubmission?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const hid = useId();
  // The list row lacks contacts and assignment; show it while the full record loads.
  const q = useQuery({ queryKey: pipelineKeys.placement(id), queryFn: () => pipelineApi.placement(id), placeholderData: initial ?? undefined });
  const [exit, setExit] = useState<string | null>(null);
  const [reinitiate, setReinitiate] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const p = q.data;
  const full = Boolean(p && !q.isPlaceholderData);

  const refresh = () => { void qc.invalidateQueries({ queryKey: pipelineKeys.placements }); };
  const announce = (m: string) => { setError(""); setMessage(m); onNotice(m); };
  const move = async (to: string) => {
    setBusy(to); setError(""); setMessage("");
    try { await pipelineApi.changePlacementStatus(id, to); announce(`Placement moved to ${pipelineLabel(to)}.`); refresh(); }
    catch (e) { setError(pipelineError(e, "placement")); }
    finally { setBusy(null); }
  };

  const initiateBgc = async () => {
    setBusy("bgc"); setError(""); setMessage("");
    try { await paperworkApi.updateBgc(id, { status: "initiated" }); announce("Background check initiated."); refreshBgc(); }
    catch (e) { setError(pipelineError(e, "placement")); }
    finally { setBusy(null); }
  };
  const refreshBgc = () => { refresh(); void qc.invalidateQueries({ queryKey: paperworkKeys.all }); };

  const transitions = p?.allowedTransitions ?? [];
  const canInitiateBgc = full && Boolean(p?.bgc?.actions?.transition.includes("initiated"));
  const forward = transitions.filter((t) => !EXITS.has(t));
  const exits = transitions.filter((t) => EXITS.has(t));
  const anyAction = transitions.length > 0 || canInitiateBgc;
  const note = !p ? "" : p.joinedAt ? `Joined ${fmtDateTime(p.joinedAt)}` : p.actualStart ? `Started ${fmtDate(p.actualStart)}`
    : OPEN.has(p.status) ? `${startNote(p)?.text ?? "Starts"} · ${fmtDate(p.tentativeStart)} (tentative)` : `Last change ${fmtDateTime(p.statusChangedAt ?? p.createdAt)}`;
  // Overdue first, then open required items, then the rest (stable).
  const checklist = [...(p?.checklist ?? [])].sort((a, b) => Number(Boolean(b.overdue)) - Number(Boolean(a.overdue)));

  return (
    <>
      <Drawer title={p ? `${p.candidate.name ?? "Candidate not visible"} · ${p.client.name}` : "Placement"} onClose={onClose} suspended={exit !== null || reinitiate} wide closeLabel="Close placement details">
        {q.isLoading && !p ? <Loading /> : !p ? (
          <p className="error" role="alert">{pipelineError(q.error, "placement")}</p>
        ) : (
          <>
            <div className="actionstrip pl-strip">
              <div className="as-status">
                <PipelineStatus status={p.status} />{p.isFirstPlacement && <FirstPlacementBadge />}{p.reconfirmed && <ReconfirmedBadge />}
                <span className="as-note">{note}</span>
              </div>
              {anyAction && (
                <div className="as-actions" role="group" aria-label="Status">
                  {forward.map((t, i) => (
                    <button key={t} type="button" className={i === 0 ? "btn primary" : "btn"} disabled={busy !== null} aria-busy={busy === t || undefined}
                      onClick={() => void move(t)}>Move to {pipelineLabel(t)}</button>
                  ))}
                  {canInitiateBgc && (p.bgc?.status === "cleared" ? (
                    <button type="button" className="btn" disabled={busy !== null} onClick={() => setReinitiate(true)}>Re-initiate BGC…</button>
                  ) : (
                    <button type="button" className={forward.length ? "btn" : "btn primary"} disabled={busy !== null} aria-busy={busy === "bgc" || undefined}
                      onClick={() => void initiateBgc()}>Mark BGC initiated</button>
                  ))}
                  {exits.map((t) => (
                    <button key={t} type="button" className="btn danger pl-exit" disabled={busy !== null} onClick={() => setExit(t)}>
                      {EXIT_LABEL[t] ?? pipelineLabel(t)}…
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!anyAction && full && (
              <p className="pl-readonly">You can view this placement. Status changes are made by its recruiter&apos;s team, and the background check by HR.</p>
            )}
            <StageStepper status={p.status} />

            <p role="status" aria-live="polite" className="livemsg">{message}</p>
            {error && <p className="banner error" role="alert">{error}</p>}

            <div className="pl-factgroups">
              <div>
                <h4>Job</h4>
                <dl className="facts">
                  <dt>Client</dt><dd>{p.client.name}</dd>
                  <dt>Vendor</dt><dd>{p.vendor?.name ?? "None"}</dd>
                  <dt>Technology</dt><dd>{p.technology?.name ?? "—"}</dd>
                  <dt>Type</dt><dd>{PLACEMENT_TYPE_LABELS[p.placementType] ?? p.placementType}</dd>
                  <dt>Work mode</dt><dd>{WORK_MODE_LABELS[p.workMode] ?? p.workMode}</dd>
                  <dt>Project location</dt><dd>{where(p) || "—"}</dd>
                  {"rate" in p && <><dt>Rate</dt><dd>{fmtRate(p.rate)}</dd></>}
                </dl>
              </div>
              <div>
                <h4>People</h4>
                <dl className="facts">
                  <dt>Candidate</dt><dd>{p.candidate.name
                    ? <RecordLink kind="candidate" id={p.candidate.id} allowed={canOpenCandidate}>{p.candidate.name}</RecordLink>
                    : <span className="muted">Not visible to you</span>}</dd>
                  <dt>Recruiter</dt><dd>{p.recruiter.name} · {p.team.name}</dd>
                  <dt>Location</dt><dd>{p.location.name}</dd>
                  <dt>Re-confirmed</dt><dd>{p.reconfirmed ? "Yes" : "No"}</dd>
                  <dt>Submission</dt><dd><RecordLink kind="submission" id={p.submissionId} onOpen={onOpenSubmission ? (sid) => { onClose(); onOpenSubmission(sid); } : undefined}
                    label={`Open the submission this placement came from`}>{onOpenSubmission ? "Open submission" : "On file"}</RecordLink></dd>
                </dl>
              </div>
              <div>
                <h4>Dates</h4>
                <dl className="facts">
                  <dt>Tentative start</dt><dd>{fmtDate(p.tentativeStart)}</dd>
                  {p.actualStart && <><dt>Actual start</dt><dd>{fmtDate(p.actualStart)}</dd></>}
                  {p.joinedAt && <><dt>Joined</dt><dd>{fmtDateTime(p.joinedAt)}</dd></>}
                  <dt>Created</dt><dd>{fmtDateTime(p.createdAt)}</dd>
                  <dt>Last status change</dt><dd>{fmtDateTime(p.statusChangedAt)}</dd>
                </dl>
              </div>
            </div>

            {(!full || p.checklist !== undefined) && (
              <section className="pl-section" aria-labelledby={`${hid}-k`}>
                <div className="factshead">
                  <h3 id={`${hid}-k`}>Paperwork checklist</h3>
                  {full && Boolean(p.checklist?.length) && <RecordLink kind="paperwork" id={p.id} allowed={canOpenPaperwork} className="pl-openpw">Open in Paperwork &amp; BGC</RecordLink>}
                </div>
                {!full ? <p className="muted">Loading checklist…</p> : !p.checklist?.length ? (
                  <p className="muted">No paperwork checklist is set up for {PLACEMENT_TYPE_LABELS[p.placementType] ?? p.placementType} placements.</p>
                ) : (
                  <>
                    <ChecklistProgress items={p.checklist} />
                    <div className="tablewrap"><table className="mini pl-mini" aria-labelledby={`${hid}-k`}>
                      <thead><tr><th>Document</th><th>Owner</th><th>Required</th><th>Status</th><th>Due</th></tr></thead>
                      <tbody>
                        {checklist.map((c) => (
                          <tr key={c.docType}>
                            <td data-label="Document">{docTypeLabel(c.docType)}</td>
                            <td data-label="Owner"><RoleName k={c.ownerRole} /></td>
                            <td data-label="Required">{c.required ? "Required" : "Optional"}</td>
                            <td data-label="Status">{pipelineLabel(c.status)}</td>
                            <td data-label="Due"><span>{c.dueOn ? fmtDate(c.dueOn) : "—"}{c.overdue && <> <span className="badge overdue">Overdue</span></>}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  </>
                )}
              </section>
            )}

            {full && p.bgc && (
              <section className="pl-section" aria-labelledby={`${hid}-b`}>
                <h3 id={`${hid}-b`}>Background check</h3>
                <p><span className={`badge bgc-${p.bgc.status}`}>{p.bgc.status === "not_started" ? "Not started" : pipelineLabel(p.bgc.status)}</span>
                  {" "}<span className="muted">{canInitiateBgc
                    ? "Mark it initiated with the button at the top; HR records the details on Paperwork & BGC."
                    : "HR records the check on Paperwork & BGC."}</span></p>
              </section>
            )}

            <section className="pl-section" aria-labelledby={`${hid}-c`}>
              <h3 id={`${hid}-c`}>Contacts</h3>
              {!full ? <p className="muted">Loading contacts…</p> : !p.contacts?.length ? <p className="muted">No contacts recorded.</p> : (
                <div className="tablewrap"><table className="mini pl-mini" aria-labelledby={`${hid}-c`}>
                  <thead><tr><th>Kind</th><th>Name</th><th>Email</th><th>Phone</th></tr></thead>
                  <tbody>
                    {p.contacts.map((c, i) => (
                      <tr key={i}>
                        <td data-label="Kind">{CONTACT_KIND_LABELS[c.kind] ?? c.kind}</td>
                        <td data-label="Name">{c.name}</td>
                        <td data-label="Email">{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="muted">—</span>}</td>
                        <td data-label="Phone">{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </section>

            <section className="pl-section" aria-labelledby={`${hid}-a`}>
              <h3 id={`${hid}-a`}>Assignment</h3>
              {!full ? <p className="muted">Loading assignment…</p> : !p.assignment ? (
                <p className="muted">No assignment yet. One opens when the placement moves to Joined.</p>
              ) : (
                <dl className="facts">
                  <dt>Assignment no.</dt><dd>{p.assignment.assignmentNo}</dd>
                  <dt>Started</dt><dd>{fmtDate(p.assignment.startDate)}</dd>
                  <dt>Ended</dt><dd>{p.assignment.endDate ? fmtDate(p.assignment.endDate) : "Ongoing"}</dd>
                  {p.assignment.endReason && <><dt>End reason</dt><dd>{pipelineLabel(p.assignment.endReason)}</dd></>}
                </dl>
              )}
            </section>

            {full && <ContractsSection placementId={id} />}

            {canReadDocuments && <DocumentsSection owner={{ kind: "placement", id }} title="Placement documents" />}
          </>
        )}
      </Drawer>

      {p && exit && (
        <ExitDialog placement={p} to={exit} onClose={() => setExit(null)}
          onDone={() => { const t = exit; setExit(null); announce(`Placement marked ${pipelineLabel(t)}.`); refresh(); }} />
      )}
      {p && reinitiate && (
        <ReinitiateBgcDialog placement={p} onClose={() => setReinitiate(false)}
          onDone={() => { setReinitiate(false); announce("Background check re-initiated."); refreshBgc(); }} />
      )}
    </>
  );
}

/** Cleared BGC back to Initiated (PW-7), e.g. the vendor asks for more documents after joining. The placement status is unchanged. */
function ReinitiateBgcDialog({ placement, onClose, onDone }: { placement: Placement; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [fieldErr, setFieldErr] = useState("");
  const submit = useSubmit((e) => pipelineError(e, "placement"));
  useEffect(() => setFieldErr(""), [reason]);
  return (
    <Dialog title={`Re-initiate the background check for ${placement.candidate.name}?`} onClose={onClose} dirty={reason.trim() !== ""}>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        const r = reason.trim();
        if (!r) { setFieldErr("Give a reason."); e.currentTarget.querySelector<HTMLElement>("textarea")?.focus(); return; }
        void submit.run(async () => { await paperworkApi.updateBgc(placement.id, { status: "initiated", reason: r }); onDone(); });
      }}>
        <p className="dialogbody">The check goes back to Initiated from today and its completion date is cleared. The placement status{placement.status === "joined" ? " and the assignment stay" : " stays"} as {placement.status === "joined" ? "they are" : "it is"}.</p>
        <Field label="Reason" hint="For example, the vendor asked for more documents. Up to 500 characters; never in the audit log." error={fieldErr}>
          {(p) => <textarea {...p} rows={4} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Re-initiate BGC" busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}

/** Backout / BGC failed: confirm with a required reason (sent as `reason`). */
function ExitDialog({ placement, to, onClose, onDone }: { placement: Placement; to: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [fieldErr, setFieldErr] = useState("");
  const submit = useSubmit((e) => pipelineError(e, "placement"));
  const label = EXIT_LABEL[to] ?? `Mark ${pipelineLabel(to)}`;
  useEffect(() => setFieldErr(""), [reason]);
  return (
    <Dialog title={`${label} for ${placement.candidate.name}?`} onClose={onClose} dirty={reason.trim() !== ""}>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        const r = reason.trim();
        if (!r) { setFieldErr("Give a reason."); e.currentTarget.querySelector<HTMLElement>("textarea")?.focus(); return; }
        void submit.run(async () => { await pipelineApi.changePlacementStatus(placement.id, to, r); onDone(); });
      }}>
        <p className="dialogbody">{EXIT_TEXT[to]} This can't be undone from this screen.</p>
        <Field label="Reason" hint="Up to 500 characters." error={fieldErr}>
          {(p) => <textarea {...p} rows={4} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />}
        </Field>
        <DialogActions onCancel={onClose} submitLabel={label} danger busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}
