import { useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Me } from "../api";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { useLookupName } from "../lookups";
import { salesApi } from "../sales/salesApi";
import { Drawer, Field } from "../sales/ui";
import { CreatePlacementDialog } from "./CreatePlacementDialog";
import { pipelineError } from "./errors";
import {
  SUBMISSION_STATUSES, dayBoundary, fmtDateTime, fmtRate, pipelineApi, pipelineKeys, pipelineLabel, type Submission,
} from "./pipelineApi";
import { ScheduleInterviewDialog } from "./ScheduleInterviewDialog";
import { PipelineStatus, StatusChips } from "./ui";

const PAGE_SIZE = 50;
const CLOSING = new Set(["rejected", "withdrawn"]);

/** Submissions list (GET /api/v1/submissions) with a detail drawer for status changes and next steps. */
export function SubmissionsPage({ me, onOpenPlacement }: { me: Pick<Me, "capabilities">; onOpenPlacement?: (id: string) => void }) {
  const id = useId();
  const canSearchCandidates = me.capabilities.includes("candidate:read");
  const [status, setStatusRaw] = useState("");
  const [from, setFromRaw] = useState("");
  const [to, setToRaw] = useState("");
  const [candidateId, setCandidateRaw] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const page = cursors.length - 1;
  const reset = () => setCursors([null]);
  const setStatus = (v: string) => { setStatusRaw(v); reset(); };
  const setFrom = (v: string) => { setFromRaw(v); reset(); };
  const setTo = (v: string) => { setToRaw(v); reset(); };
  const setCandidate = (v: string) => { setCandidateRaw(v); reset(); };
  const invalidRange = Boolean(from && to && from > to);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const filters = {
    status, candidateId,
    from: from ? dayBoundary(from) : "", to: to ? dayBoundary(to, true) : "",
    cursor: cursors[page] ?? "", limit: PAGE_SIZE,
  };
  const q = useQuery({
    queryKey: [...pipelineKeys.submissions, "list", filters],
    queryFn: () => pipelineApi.submissions(filters),
    placeholderData: keepPreviousData,
    enabled: !invalidRange,
  });
  const items = q.data?.items ?? [];
  const showRate = items.some((s) => "rate" in s);
  const hasFilters = Boolean(status || from || to || candidateId);
  const open = items.find((s) => s.id === openId) ?? null;
  const n = items.length;
  const countMsg = q.isLoading || q.error || invalidRange ? ""
    : `${n} ${n === 1 ? "submission" : "submissions"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;

  return (
    <>
      <div>
        <h1 tabIndex={-1}>Submissions</h1>
        <p className="sub">Track each submission from first send to a decision. Open one to move it forward, schedule an interview or create a placement.</p>
      </div>

      <form className="filters" role="search" aria-label="Submission filters" onSubmit={(e) => e.preventDefault()}>
        <StatusChips label="Status" statuses={SUBMISSION_STATUSES} value={status} onChange={setStatus} />
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-from`}>Submitted from</label>
            <input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-to`}>Submitted through</label>
            <input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)}
              aria-invalid={invalidRange || undefined} aria-describedby={invalidRange ? `${id}-range` : undefined} />
          </div>
          {canSearchCandidates && <CandidateFilter value={candidateId} onChange={setCandidate} />}
          {hasFilters && (
            <button type="button" className="btn" onClick={() => { setStatusRaw(""); setFromRaw(""); setToRaw(""); setCandidateRaw(""); reset(); }}>
              Clear filters
            </button>
          )}
        </div>
        {invalidRange && <p id={`${id}-range`} className="error" role="alert">“Submitted through” must be on or after “Submitted from”.</p>}
      </form>

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      {!invalidRange && (
        <div className="card tablewrap">
          {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
            <p className="empty error" role="alert">{pipelineError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
          ) : (
            <table aria-label="Submissions" aria-busy={q.isFetching || undefined}>
              <thead><tr>
                <th>Candidate</th><th>Job / client</th><th>Status</th><th>Submitted</th><th>Recruiter</th>
                {showRate && <th>Rate</th>}
                <th><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.candidateName ?? "Candidate"}</b></td>
                    <td>{s.jobTitle}<span className="block">{s.client}</span></td>
                    <td><PipelineStatus status={s.status} /></td>
                    <td>{fmtDateTime(s.submittedAt)}</td>
                    <td>{s.recruiterName ?? "—"}</td>
                    {showRate && <td>{"rate" in s ? fmtRate(s.rate) : <span className="muted">—</span>}</td>}
                    <td className="rowactions">
                      <button type="button" className="btn sm" onClick={() => setOpenId(s.id)}
                        aria-label={`Open submission of ${s.candidateName ?? "candidate"} for ${s.jobTitle} at ${s.client}`}>Open</button>
                    </td>
                  </tr>
                ))}
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
        <nav className="pager" aria-label="Submission pages">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="btn sm" disabled={!q.data?.nextCursor || q.isPlaceholderData}
            onClick={() => { const nx = q.data?.nextCursor; if (nx) setCursors((c) => [...c, nx]); }}>Next</button>
        </nav>
      </div>

      {openId && (
        <SubmissionDrawer id={openId} initial={open} onClose={() => setOpenId(null)} onNotice={setNotice} onOpenPlacement={onOpenPlacement} />
      )}
    </>
  );
}

/** Candidate name search: finds candidates, then filters submissions by the one picked (server-side). */
function CandidateFilter({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const id = useId();
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(input.trim()), 250); return () => clearTimeout(t); }, [input]);
  const q = useQuery({
    queryKey: ["submissions", "candidate-search", term],
    queryFn: () => salesApi.candidates({ search: term, limit: 20 }),
    enabled: term.length >= 2,
    staleTime: 60_000,
  });
  const matches = q.data?.items ?? [];
  return (
    <>
      <div className="field inline">
        <label htmlFor={`${id}-search`}>Candidate search</label>
        <input id={`${id}-search`} type="search" placeholder="Type 2+ letters of a name" value={input}
          onChange={(e) => { setInput(e.target.value); if (value) onChange(""); }} aria-describedby={`${id}-msg`} />
      </div>
      <div className="field inline">
        <label htmlFor={`${id}-pick`}>Candidate</label>
        <select id={`${id}-pick`} value={value} onChange={(e) => onChange(e.target.value)} disabled={term.length < 2 || q.isLoading}>
          <option value="">Any candidate</option>
          {matches.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.team.name}</option>)}
        </select>
      </div>
      <span id={`${id}-msg`} className="sr-only" aria-live="polite">
        {term.length >= 2 && q.data ? `${matches.length} matching ${matches.length === 1 ? "candidate" : "candidates"}. Pick one in the Candidate list.` : ""}
        {q.error ? "Candidate search is unavailable." : ""}
      </span>
    </>
  );
}

type Modal = { kind: "reject" } | { kind: "withdraw" } | { kind: "interview" } | { kind: "placement" };

function SubmissionDrawer({ id, initial, onClose, onNotice, onOpenPlacement }: {
  id: string; initial: Submission | null; onClose: () => void; onNotice: (m: string) => void; onOpenPlacement?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: pipelineKeys.submission(id), queryFn: () => pipelineApi.submission(id), placeholderData: initial ?? undefined });
  const [modal, setModal] = useState<Modal | null>(null);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<{ id: string; isFirstPlacement: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const s = q.data;
  const vendorName = useLookupName("vendors", s?.vendorId);
  const title = s ? `${s.candidateName ?? "Candidate"} · ${s.jobTitle}` : "Submission";

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: pipelineKeys.submissions });
  };
  const announce = (m: string) => { setError(""); setMessage(m); onNotice(m); };

  const move = async (to: string) => {
    setBusy(to); setError(""); setMessage("");
    try { await pipelineApi.changeSubmissionStatus(id, to); announce(`Status changed to ${pipelineLabel(to)}.`); refresh(); }
    catch (e) { setError(pipelineError(e, "submission")); }
    finally { setBusy(null); }
  };

  const actions = s?.actions;
  const forward = actions?.transition.filter((t) => !CLOSING.has(t)) ?? [];
  const canReject = actions?.transition.includes("rejected") ?? false;
  const canWithdraw = actions?.transition.includes("withdrawn") ?? false;
  const anyAction = Boolean(actions && (actions.transition.length || actions.createInterview || actions.createPlacement));

  return (
    <>
      <Drawer title={title} onClose={onClose} suspended={modal !== null} closeLabel="Close submission details">
        {q.isLoading && !s ? <p className="empty">Loading…</p> : !s ? (
          <p className="error" role="alert">{pipelineError(q.error, "submission")}</p>
        ) : (
          <>
            <dl className="facts">
              <dt>Candidate</dt><dd>{s.candidateName ?? "—"}</dd>
              <dt>Job title</dt><dd>{s.jobTitle}</dd>
              <dt>Client</dt><dd>{s.client}</dd>
              <dt>Vendor</dt><dd>{s.vendorId ? vendorName ?? "Vendor on file" : "None"}</dd>
              <dt>Status</dt><dd><PipelineStatus status={s.status} /></dd>
              {s.rejectionReason && <><dt>Rejection reason</dt><dd>{s.rejectionReason}</dd></>}
              <dt>Recruiter</dt><dd>{s.recruiterName ?? "—"}</dd>
              {"rate" in s && <><dt>Rate</dt><dd>{fmtRate(s.rate)}</dd></>}
              <dt>Submitted</dt><dd>{fmtDateTime(s.submittedAt)}</dd>
              <dt>Last status change</dt><dd>{fmtDateTime(s.statusChangedAt)}</dd>
            </dl>

            <p role="status" aria-live="polite" className="livemsg">{message}</p>
            {created && onOpenPlacement && (
              <button type="button" className="btn" onClick={() => { onClose(); onOpenPlacement(created.id); }}>Open the new placement</button>
            )}
            {error && <p className="banner error" role="alert">{error}</p>}

            {anyAction && actions && (
              <section className="manageblock" aria-labelledby={`${id}-next`}>
                <h3 id={`${id}-next`}>Next steps</h3>
                {actions.transition.length > 0 && (
                  <div className="rowactions" role="group" aria-label="Change status">
                    {forward.map((t) => (
                      <button key={t} type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === t || undefined}
                        onClick={() => void move(t)}>Move to {pipelineLabel(t)}</button>
                    ))}
                    {canReject && <button type="button" className="btn sm danger" disabled={busy !== null} onClick={() => setModal({ kind: "reject" })}>Reject…</button>}
                    {canWithdraw && <button type="button" className="btn sm danger" disabled={busy !== null} onClick={() => setModal({ kind: "withdraw" })}>Withdraw…</button>}
                  </div>
                )}
                {(actions.createInterview || actions.createPlacement) && (
                  <div className="rowactions">
                    {actions.createInterview && <button type="button" className="btn" onClick={() => setModal({ kind: "interview" })}>Schedule interview</button>}
                    {actions.createPlacement && <button type="button" className="btn primary" onClick={() => setModal({ kind: "placement" })}>Create placement</button>}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </Drawer>

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
      {s && modal?.kind === "interview" && (
        <ScheduleInterviewDialog submission={s} onClose={() => setModal(null)}
          onScheduled={() => {
            setModal(null); announce("Interview scheduled.");
            void qc.invalidateQueries({ queryKey: ["interviews"] }); refresh();
          }} />
      )}
      {s && modal?.kind === "placement" && (
        <CreatePlacementDialog submission={s} onClose={() => setModal(null)}
          onCreated={(r) => {
            setModal(null); setCreated(r);
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
    <Dialog title="Reject this submission?" onClose={onClose}>
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
