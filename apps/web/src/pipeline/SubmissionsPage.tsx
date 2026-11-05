import { useEffect, useId, useState } from "react";
import { Pencil } from "lucide-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { INTERVIEW_STAGE_LABELS } from "@eureka/shared";
import { can, type Me } from "../api";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { FilterBar, type FilterChip } from "../ui/FilterBar";
import { Menu } from "../ui/Menu";
import { RecordLink } from "../ui/RecordLink";
import { useLookupName } from "../lookups";
import { Drawer, Field } from "../sales/ui";
import { AssessmentsSection } from "../pipelinereport/AssessmentsSection";
import type { Interview } from "../interviews/InterviewsPage";
import { CreatePlacementDialog, rowPlacement } from "./CreatePlacementDialog";
import { EditSubmissionDialog } from "./EditSubmissionDialog";
import { pipelineError } from "./errors";
import {
  ISO_DAY, SUBMISSION_STATUSES, dayBoundary, fmtDateTime, fmtRate, pipelineApi, pipelineKeys, pipelineLabel, type Submission,
} from "./pipelineApi";
import { ScheduleInterviewDialog, nextRoundOf, refreshAfterSchedule } from "./ScheduleInterviewDialog";
import { RejectRoundDialog, SubmissionRounds, nextRoundName, refreshRounds } from "./SubmissionRounds";
import { PipelineFunnel, PipelineStatus, ReachedFilter, StageTrail, parseReached, reachedValue, fromControl, useBatchOptions, useDebouncedParam, type Reached } from "./ui";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import { useRoutedId, useSearchParams } from "../lib/router";
import "./pipeline.css";

const PAGE_SIZE = 50;
const CLOSING = new Set(["rejected", "withdrawn"]);
const PARAMS = ["status", "from", "to", "reached", "batchId"] as const;

/** "Sep 20, 2026" (the time is in the drawer). */
export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");


/** "Reached L1", "Got an interview", … for the Interview filter chip. */
function reachedLabel(r: Reached): string {
  if (r.stage === "placed") return "Placed";
  if (r.stage) return `Reached ${INTERVIEW_STAGE_LABELS[r.stage as keyof typeof INTERVIEW_STAGE_LABELS] ?? r.stage}`;
  return r.interviewed === "true" ? "Got an interview" : r.interviewed === "false" ? "No interview yet" : "";
}

type RowModal = { kind: "schedule"; s: Submission } | { kind: "place"; s: Submission };

/** Submissions list (GET /api/v1/submissions) with a detail drawer for status changes and next steps. */
export function SubmissionsPage({ me, onOpenPlacement, initialOpenId = null, onOpenChange }: {
  me: Pick<Me, "capabilities">; onOpenPlacement?: (id: string) => void;
  /** The submission open in the drawer (/submissions/<id>). */
  initialOpenId?: string | null;
  /** The open submission changed (the shell keeps it in the URL). */
  onOpenChange?: (id: string | null) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const canSearchCandidates = can(me, "candidate:read");
  const canOpenInterview = can(me, "interview:read");
  // Every filter lives in the address bar (?status=&from=&to=&reached=&batchId=&candidate=&q=), so a refresh or a shared link keeps it.
  const [url, setUrl] = useSearchParams(PARAMS);
  const reached = parseReached(url.reached);
  const [searchInput, setSearchInput, search] = useDebouncedParam("q");
  const [candidateInput, setCandidateInput, candidate] = useDebouncedParam("candidate");
  const status = (SUBMISSION_STATUSES as readonly string[]).includes(url.status) ? url.status : "";
  const from = ISO_DAY.test(url.from) ? url.from : "";
  const to = ISO_DAY.test(url.to) ? url.to : "";
  const batchId = url.batchId;
  const batches = useBatchOptions(me);
  const pager = useCursorPager();
  const { page, reset } = pager;
  const patch = (p: Partial<Record<(typeof PARAMS)[number], string>>) => { setUrl(p); reset(); };
  const setReached = (v: Reached) => patch({ reached: reachedValue(v) });
  useEffect(() => { reset(); }, [search, candidate, reset]);
  const invalidRange = Boolean(from && to && from > to);
  const [openId, setOpenId] = useRoutedId(initialOpenId, onOpenChange);
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [rowModal, setRowModal] = useState<RowModal | null>(null);
  const say = (m: string, placementId: string | null = null) => { setNotice(m); setCreated(placementId); };

  const filters = {
    status, candidate, batchId, ...reached, search,
    from: from ? dayBoundary(from) : "", to: to ? dayBoundary(to, true) : "",
    cursor: pager.cursor ?? "", limit: PAGE_SIZE,
  };
  const q = useQuery({
    queryKey: [...pipelineKeys.submissions, "list", filters],
    queryFn: () => pipelineApi.submissions(filters),
    placeholderData: keepPreviousData,
    enabled: !invalidRange,
  });
  // Funnel and status counts for the same filters except status and "reached" (those are what they break down).
  const sumFilters = { candidate, batchId, search, from: filters.from, to: filters.to };
  const summary = useQuery({
    queryKey: [...pipelineKeys.submissions, "summary", sumFilters],
    queryFn: () => pipelineApi.submissionSummary(sumFilters),
    placeholderData: keepPreviousData,
    enabled: !invalidRange,
  });
  const items = q.data?.items ?? [];
  const showRate = items.some((s) => "rate" in s);
  const hasFilters = Boolean(status || from || to || candidate || batchId || reached.interviewed || reached.stage || search);
  const open = items.find((s) => s.id === openId) ?? null;
  const n = items.length;
  const countMsg = q.isLoading || q.error || invalidRange ? ""
    : `${n} ${n === 1 ? "submission" : "submissions"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;
  const counts = summary.data?.byStatus;
  const clear = () => { setUrl({ status: "", from: "", to: "", reached: "", batchId: "" }); setCandidateInput(""); setSearchInput(""); reset(); };

  const chips: FilterChip[] = [];
  if (batchId) chips.push({ key: "batch", label: `Batch: ${batches.find((b) => b.id === batchId)?.name ?? "Selected batch"}`, onRemove: () => patch({ batchId: "" }) });
  if (reached.interviewed || reached.stage) chips.push({ key: "reached", label: reachedLabel(reached), onRemove: () => patch({ reached: "" }) });
  const activeCount = [status, from, to, candidate, search].filter(Boolean).length + chips.length;

  const jobField = (
    <div className={`field inline${canSearchCandidates ? "" : " fb-search"}`}>
      <label htmlFor={`${id}-job`}>Job or client</label>
      <input id={`${id}-job`} type="search" placeholder="e.g. Java, Meta" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
    </div>
  );

  return (
    <section className="panel plpage">
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Submissions{!q.isLoading && !q.error && !invalidRange && <span className="h1count" aria-hidden="true">{n}{q.data?.nextCursor ? "+" : ""}</span>}</h1>
          <p className="sub">Track each submission from first send to a decision. Open one to move it forward, schedule an interview or create a placement.</p>
        </div>
      </div>

      <FilterBar label="Submission filters" hasFilters={hasFilters} onClear={clear} chips={chips} moreCount={chips.length} activeCount={activeCount}
        search={canSearchCandidates ? (
          <div className="field inline fb-search">
            <label htmlFor={`${id}-candidate`}>Candidate</label>
            <input id={`${id}-candidate`} type="search" placeholder="Search by name" value={candidateInput} onChange={(e) => setCandidateInput(e.target.value)} />
          </div>
        ) : jobField}
        primary={
          <>
            <div className="field inline fb-status">
              <label htmlFor={`${id}-status`}>Status</label>
              <select id={`${id}-status`} value={status} onChange={(e) => patch({ status: e.target.value })}>
                <option value="">Any status{summary.data ? ` · ${summary.data.total}` : ""}</option>
                {SUBMISSION_STATUSES.map((st) => <option key={st} value={st}>{pipelineLabel(st)}{counts ? ` · ${counts[st] ?? 0}` : ""}</option>)}
              </select>
            </div>
            {canSearchCandidates && jobField}
            <div className="field inline pl-date">
              <label htmlFor={`${id}-from`}>Submitted from</label>
              <input id={`${id}-from`} type="date" value={from} onChange={(e) => patch({ from: e.target.value })} />
            </div>
            <div className="field inline pl-date">
              <label htmlFor={`${id}-to`}>Submitted through</label>
              <input id={`${id}-to`} type="date" value={to} onChange={(e) => patch({ to: e.target.value })}
                aria-invalid={invalidRange || undefined} aria-describedby={invalidRange ? `${id}-range` : undefined} />
            </div>
          </>
        }
        more={
          <>
            {batches.length > 0 && (
              <div className="field inline">
                <label htmlFor={`${id}-batch`}>Batch</label>
                <select id={`${id}-batch`} value={batchId} onChange={(e) => patch({ batchId: e.target.value })}>
                  <option value="">All</option>
                  {batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            )}
            <ReachedFilter value={reached} onChange={setReached} />
          </>
        }
      />
      {invalidRange && <p id={`${id}-range`} className="error" role="alert">“Submitted through” must be on or after “Submitted from”.</p>}

      {!invalidRange && summary.data && <PipelineFunnel summary={summary.data} value={reached} onPick={setReached} />}

      <div className="pl-notice">
        <p role="status" aria-live="polite" className="livemsg">{notice}</p>
        {created && onOpenPlacement && notice && <button type="button" className="btn sm" onClick={() => onOpenPlacement(created)}>Open placement</button>}
      </div>

      {!invalidRange && (
        <div className="card tablewrap listcard">
          {q.isLoading ? <Loading /> : q.error ? (
            <QueryError query={q} message={pipelineError(q.error)} />
          ) : (
            <table className="dtable pl-subs" aria-label="Submissions" aria-busy={q.isFetching || undefined}>
              <thead><tr>
                <th>Candidate</th><th>Job / client</th><th>Status</th><th>Interview rounds</th><th>Submitted</th>
                {showRate && <th className="num p2">Rate</th>}
                <th className="c-act"><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>
                {items.map((s) => {
                  const name = s.candidateName ?? "Candidate";
                  const place = rowPlacement(s);
                  const next = nextRoundOf(s);
                  const schedule = s.actions?.createInterview ? {
                    label: next.held ? "Schedule next round" : "Schedule interview",
                    aria: `Schedule ${next.held ? "next round" : "interview"} for ${name}, ${s.jobTitle} at ${s.client}`,
                    run: () => setRowModal({ kind: "schedule", s }),
                  } : null;
                  const placeAct = place ? { label: "Create placement", aria: `Create placement for ${name}, ${s.jobTitle} at ${s.client}`, run: () => setRowModal({ kind: "place", s }) } : null;
                  const primary = placeAct ?? schedule;
                  const extra = placeAct && schedule ? schedule : null;
                  return (
                    <tr key={s.id} className="rowopen" onClick={(e) => { if (!fromControl(e)) setOpenId(s.id); }}>
                      <td className="c-primary">
                        <RecordLink kind="candidate" id={s.candidateId} allowed={canSearchCandidates}><b>{name}</b></RecordLink>
                      </td>
                      <td data-label="Job"><span>{s.jobTitle}<small className="block muted">{s.client}</small></span></td>
                      <td className="c-badge"><PipelineStatus status={s.status} /></td>
                      <td data-label="Rounds"><StageTrail s={s} /></td>
                      <td data-label="Submitted" className="pl-nowrap"><span>{fmtDay(s.submittedAt)}<small className="block muted">{s.recruiterName ?? "—"}</small></span></td>
                      {showRate && <td className="num p2" data-label="Rate">{"rate" in s ? fmtRate(s.rate) : <span className="muted">—</span>}</td>}
                      <td className="c-act">
                        <div className="pl-act">
                          {primary && <button type="button" className="btn sm" aria-label={primary.aria} onClick={primary.run}>{primary.label}</button>}
                          <button type="button" className="btn sm" onClick={() => setOpenId(s.id)}
                            aria-label={`Open submission of ${name} for ${s.jobTitle} at ${s.client}`}>Open</button>
                          {extra && <Menu label={`More actions for ${name}`} items={[{ label: extra.label, onSelect: extra.run }]} />}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {items.length === 0 && (
                  <tr><td colSpan={showRate ? 7 : 6} className="empty">{hasFilters ? "No submissions match these filters." : "No submissions yet. Log one from a candidate profile."}</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <Pager pager={pager} label="Submission pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>

      {rowModal?.kind === "schedule" && (
        <ScheduleInterviewDialog submission={rowModal.s} defaultRound={nextRoundOf(rowModal.s).round} onClose={() => setRowModal(null)}
          onScheduled={() => { const s = rowModal.s; setRowModal(null); say(`Interview scheduled for ${s.candidateName ?? "the candidate"}.`); refreshAfterSchedule(qc); }} />
      )}
      {rowModal?.kind === "place" && (() => {
        const s = rowModal.s;
        const from = rowPlacement(s);
        const refresh = () => {
          void qc.invalidateQueries({ queryKey: pipelineKeys.submissions });
          void qc.invalidateQueries({ queryKey: pipelineKeys.placements });
          void qc.invalidateQueries({ queryKey: ["interviews"] });
        };
        return (
          <CreatePlacementDialog submission={s} onClose={() => setRowModal(null)}
            clearRound={from?.round && { id: from.round.id!, round: from.round.round, pending: false }}
            onSelectedOnly={from?.round ? () => { setRowModal(null); say("Submission moved to Selected."); refresh(); } : undefined}
            onCreated={(r) => {
              setRowModal(null); refresh();
              say(r.isFirstPlacement ? `Placement created for ${s.candidateName ?? "the candidate"}. This is their first placement.` : `Placement created for ${s.candidateName ?? "the candidate"}.`, r.id);
            }} />
        );
      })()}

      {openId && (
        <SubmissionDrawer id={openId} initial={open} onClose={() => setOpenId(null)} onNotice={(m) => say(m)} onOpenPlacement={onOpenPlacement}
          canOpenCandidate={canSearchCandidates} canOpenInterview={canOpenInterview} />
      )}
    </section>
  );
}

type Modal = { kind: "edit" } | { kind: "reject" } | { kind: "withdraw" } | { kind: "interview"; defaultRound?: string }
  | { kind: "placement"; round?: Interview } | { kind: "rejectRound"; round: Interview };

const dead = (i: Pick<Interview, "callStatus">) => i.callStatus === "cancelled" || i.callStatus === "no_invite";
/** Statuses where booking an interview usually means "Interview scheduled" next. */
const BEFORE_SCHEDULED = new Set(["submitted", "under_review", "interview_requested"]);

/**
 * Submission drawer. The action strip comes first: status, what is next (the upcoming round or the
 * last change), the next action (create placement, or schedule the next round), then the allowed
 * status moves with Reject / Withdraw (confirmed in a dialog). Then the details, the rounds and assessments.
 */
export function SubmissionDrawer({ id, initial, onClose, onNotice, onOpenPlacement, canOpenCandidate = false, canOpenInterview = false }: {
  id: string; initial: Submission | null; onClose: () => void; onNotice: (m: string) => void; onOpenPlacement?: (id: string) => void;
  /** Link the candidate name to their profile (candidate:read). */
  canOpenCandidate?: boolean;
  /** Link each round to the Interviews board (interview:read). */
  canOpenInterview?: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: pipelineKeys.submission(id), queryFn: () => pipelineApi.submission(id), placeholderData: initial ?? undefined });
  const rounds = useQuery({ queryKey: pipelineKeys.rounds(id), queryFn: () => pipelineApi.submissionInterviews(id) });
  const [modal, setModal] = useState<Modal | null>(null);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<{ id: string; isFirstPlacement: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduledHint, setScheduledHint] = useState(false);
  const s = q.data;
  const vendorName = useLookupName("vendors", s?.vendorId);
  const title = s ? `${s.candidateName ?? "Candidate"} · ${s.jobTitle}` : "Submission";

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: pipelineKeys.submissions });
  };
  const announce = (m: string) => { setError(""); setMessage(m); onNotice(m); };

  const move = async (to: string) => {
    setBusy(to); setError(""); setMessage(""); setScheduledHint(false);
    try { await pipelineApi.changeSubmissionStatus(id, to); announce(`Status changed to ${pipelineLabel(to)}.`); refresh(); }
    catch (e) { setError(pipelineError(e, "submission")); }
    finally { setBusy(null); }
  };

  const actions = s?.actions;
  const forward = actions?.transition.filter((t) => !CLOSING.has(t)) ?? [];
  const canReject = actions?.transition.includes("rejected") ?? false;
  const canWithdraw = actions?.transition.includes("withdrawn") ?? false;
  const live = (rounds.data?.items ?? []).filter((r) => !dead(r));
  const latest = live[live.length - 1];
  const upcoming = live.find((r) => r.result === "pending" && Date.parse(r.startsAt) > Date.now());
  const placement = (rounds.data?.items ?? []).find((r) => r.placement)?.placement ?? null;
  const scheduleLabel = live.length ? "Schedule next round" : "Schedule interview";
  const note = !s ? "" : upcoming ? `Next: ${upcoming.round}, ${fmtDateTime(upcoming.startsAt)}`
    : s.status === "rejected" && s.rejectionReason ? `Rejected: ${s.rejectionReason}`
      : `Last change ${fmtDateTime(s.statusChangedAt ?? s.submittedAt)}`;
  const anyAction = Boolean(actions && (actions.transition.length || actions.createPlacement || actions.createInterview));

  return (
    <>
      <Drawer title={title} onClose={onClose} suspended={modal !== null} closeLabel="Close submission details">
        {q.isLoading && !s ? <Loading /> : !s ? (
          <p className="error" role="alert">{pipelineError(q.error, "submission")}</p>
        ) : (
          <>
            <div className="actionstrip pl-strip">
              <div className="as-status"><PipelineStatus status={s.status} /><span className="as-note">{note}</span></div>
              {anyAction && actions && (
                <div className="as-actions">
                  {actions.createPlacement && <button type="button" className="btn primary" onClick={() => setModal({ kind: "placement" })}>Create placement</button>}
                  {actions.createInterview && (
                    <button type="button" className={actions.createPlacement ? "btn" : "btn primary"}
                      onClick={() => setModal({ kind: "interview", defaultRound: nextRoundName(latest?.round) })}>{scheduleLabel}</button>
                  )}
                  {actions.transition.length > 0 && (
                    <div className="pl-moves" role="group" aria-label="Change status">
                      {forward.map((t) => (
                        <button key={t} type="button" className="btn" disabled={busy !== null} aria-busy={busy === t || undefined}
                          onClick={() => void move(t)}>Move to {pipelineLabel(t)}</button>
                      ))}
                      {canReject && <button type="button" className="btn danger" disabled={busy !== null} onClick={() => setModal({ kind: "reject" })}>Reject…</button>}
                      {canWithdraw && <button type="button" className="btn danger" disabled={busy !== null} onClick={() => setModal({ kind: "withdraw" })}>Withdraw…</button>}
                    </div>
                  )}
                </div>
              )}
            </div>

            <p role="status" aria-live="polite" className="livemsg">{message}</p>
            {scheduledHint && forward.includes("interview_scheduled") && BEFORE_SCHEDULED.has(s.status) && (
              <p className="banner info pl-hint">
                <span>The interview is booked. The status is still {pipelineLabel(s.status)}.</span>
                <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void move("interview_scheduled")}>Move to Interview scheduled</button>
              </p>
            )}
            {created && onOpenPlacement && (
              <button type="button" className="btn" onClick={() => { onClose(); onOpenPlacement(created.id); }}>Open the new placement</button>
            )}
            {error && <p className="banner error" role="alert">{error}</p>}

            <section aria-labelledby={`${id}-details`}>
              <div className="factshead">
                <h3 id={`${id}-details`}>Details</h3>
                {actions?.editDetails && (
                  <button type="button" className="btn sm" onClick={() => setModal({ kind: "edit" })}>
                    <Pencil size={14} aria-hidden="true" />Edit details
                  </button>
                )}
              </div>
              <dl className="facts">
                <dt>Candidate</dt><dd>{s.candidateName ? <RecordLink kind="candidate" id={s.candidateId} allowed={canOpenCandidate}>{s.candidateName}</RecordLink> : "—"}</dd>
                <dt>Job title</dt><dd>{s.jobTitle}</dd>
                <dt>Client</dt><dd>{s.client}</dd>
                <dt>Vendor</dt><dd>{s.vendorId ? vendorName ?? "Vendor on file" : "None"}</dd>
                {s.rejectionReason && <><dt>Rejection reason</dt><dd>{s.rejectionReason}</dd></>}
                <dt>Recruiter</dt><dd>{s.recruiterName ?? "—"}</dd>
                {"rate" in s && <><dt>Rate</dt><dd>{fmtRate(s.rate)}</dd></>}
                <dt>Submitted</dt><dd>{fmtDateTime(s.submittedAt)}</dd>
                <dt>Last status change</dt><dd>{fmtDateTime(s.statusChangedAt)}</dd>
                {placement && <><dt>Placement</dt><dd>
                  <RecordLink kind="placement" id={placement.id} allowed={Boolean(onOpenPlacement)} onOpen={onOpenPlacement ? (pid) => { onClose(); onOpenPlacement(pid); } : undefined}>
                    {pipelineLabel(placement.status)}
                  </RecordLink>
                </dd></>}
              </dl>
              {s.detailsEdited && (
                <p className="muted factsnote">Details edited {fmtDateTime(s.detailsEdited.at)}{s.detailsEdited.byName ? ` by ${s.detailsEdited.byName}` : ""}.</p>
              )}
            </section>

            <SubmissionRounds submission={s} onNotice={announce} canOpenInterview={canOpenInterview}
              onPlace={(round) => setModal({ kind: "placement", round })}
              onReject={(round) => setModal({ kind: "rejectRound", round })} />

            <AssessmentsSection submissionId={s.id} />
          </>
        )}
      </Drawer>

      {s && modal?.kind === "edit" && (
        <EditSubmissionDialog submission={s} canEditRate={actions?.editRate ?? false} onClose={() => setModal(null)}
          onSaved={(changed) => {
            setModal(null);
            announce(changed.length ? "Submission details saved." : "Nothing changed.");
            refresh(); void qc.invalidateQueries({ queryKey: ["interviews"] });
          }} />
      )}
      {s && modal?.kind === "reject" && (
        <RejectDialog submission={s} onClose={() => setModal(null)}
          onDone={() => { setModal(null); announce("Submission rejected."); refresh(); }} />
      )}
      {s && modal?.kind === "withdraw" && (
        <ConfirmDialog title="Withdraw this submission?" confirmLabel="Withdraw" danger formatError={(e) => pipelineError(e, "submission")}
          action={() => pipelineApi.changeSubmissionStatus(s.id, "withdrawn")} onClose={() => setModal(null)}
          onDone={() => { setModal(null); announce("Submission withdrawn."); refresh(); }}>
          <p>{s.candidateName ?? "The candidate"} will be withdrawn from {s.jobTitle} at {s.client}. A withdrawn submission is closed and can't be reopened.</p>
        </ConfirmDialog>
      )}
      {s && modal?.kind === "rejectRound" && (
        <RejectRoundDialog submission={s} round={modal.round} canRejectSubmission={canReject}
          onClose={() => setModal(null)}
          onDone={(also) => {
            setModal(null); refreshRounds(qc, s.id);
            announce(also ? `${modal.round.round} marked rejected and the submission rejected.` : `${modal.round.round} marked rejected.`);
          }} />
      )}
      {s && modal?.kind === "interview" && (
        <ScheduleInterviewDialog submission={s} defaultRound={modal.defaultRound} onClose={() => setModal(null)}
          onScheduled={() => {
            setModal(null); announce("Interview scheduled."); setScheduledHint(true);
            refreshRounds(qc, s.id);
          }} />
      )}
      {s && modal?.kind === "placement" && (
        <CreatePlacementDialog submission={s} onClose={() => setModal(null)}
          clearRound={modal.round && { id: modal.round.id, round: modal.round.round, pending: modal.round.result !== "cleared" }}
          onSelectedOnly={() => {
            setModal(null); announce("Round cleared and submission moved to Selected. Create the placement when the offer is in.");
            refreshRounds(qc, s.id);
          }}
          onCreated={(r) => {
            setModal(null); setCreated(r); refreshRounds(qc, s.id);
            announce(r.isFirstPlacement ? `Placement created for ${s.candidateName ?? "the candidate"}. This is their first placement.` : `Placement created for ${s.candidateName ?? "the candidate"}.`);
            void qc.invalidateQueries({ queryKey: ["placements"] }); refresh();
          }} />
      )}
    </>
  );
}

function RejectDialog({ submission, onClose, onDone }: { submission: Submission; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [fieldErr, setFieldErr] = useState("");
  const submit = useSubmit((e) => pipelineError(e, "submission"));
  return (
    <Dialog title="Reject this submission?" onClose={onClose} dirty={reason.trim() !== ""}>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        const r = reason.trim();
        if (!r) { setFieldErr("Give a rejection reason."); e.currentTarget.querySelector<HTMLElement>("textarea")?.focus(); return; }
        setFieldErr("");
        void submit.run(async () => { await pipelineApi.changeSubmissionStatus(submission.id, "rejected", r); onDone(); });
      }}>
        <p className="dialogbody">{submission.candidateName ?? "The candidate"} · {submission.jobTitle} at {submission.client}. A rejected submission is closed.</p>
        <Field label="Rejection reason" hint="Shared with the team on the submission record. Up to 500 characters." error={fieldErr}>
          {(p) => <textarea {...p} rows={4} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Reject submission" danger busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}
