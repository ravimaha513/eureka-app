import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isSafeHttpsUrl } from "@eureka/shared";
import { ApiError, type Me } from "../api";
import { ConfirmDialog } from "../ui/Dialog";
import { CandidateResumes } from "./CandidateResumes";
import { DocumentsSection } from "../documents/DocumentsSection";
import { CandidateTimeline } from "./CandidateTimeline";
import { NonResponseCard } from "../pipelinereport/NonResponseCard";
import { CandidateWorkAuthorization } from "../workauth/CandidateWorkAuthorization";
import { CandidateTraining } from "../training/CandidateTraining";
import { EditProfileDialog } from "./EditProfileDialog";
import { ComplianceDialog } from "./ComplianceDialog";
import { documentsLabel, eligibilityLabel, stayLabel, visaLabel } from "./candidateFields";
import { salesError } from "./errors";
import { DUPLICATE_WARNING, LogSubmissionDialog } from "./LogSubmissionDialog";
import { TRANSITIONS, VISIBILITY_LABELS, salesApi, salesKeys, statusLabel, type CandidateProfile as Profile, type Visibility } from "./salesApi";
import { OpenToAllBadge, Phone, Priority, SharedBadge, StatusBadge, fmtDate } from "./ui";
import { Loading } from "../ui/Loading";
import { TeamChecklist } from "./TeamChecklist";

type Modal = { kind: "edit" } | { kind: "submit" } | { kind: "terminate" } | { kind: "compliance" };

/**
 * Candidate profile (GET /api/v1/candidates/:id). Actions follow the record's
 * `actions` hints when the server sends them, otherwise the user's capabilities;
 * the API still decides per candidate (403/404/422).
 */
export function CandidateProfile({ id, me, onBack, backLabel = "Back" }: {
  id: string; me: Pick<Me, "id" | "capabilities">; onBack: () => void; backLabel?: string;
}) {
  const qc = useQueryClient();
  const caps = new Set(me.capabilities);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [message, setMessage] = useState("");
  const [warning, setWarning] = useState("");
  // A duplicate warning is shown in the dialog first, then kept on the page after it closes.
  const pendingWarning = useRef("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({ queryKey: salesKeys.candidate(id), queryFn: () => salesApi.candidate(id) });

  // Move focus to the page heading when the profile (or its not-found state) appears.
  useEffect(() => { if (!q.isLoading) headingRef.current?.focus(); }, [q.isLoading, id]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: salesKeys.candidate(id) });
    void qc.invalidateQueries({ queryKey: salesKeys.hotlist });
    void qc.invalidateQueries({ queryKey: salesKeys.candidates });
  };
  const announce = (msg: string) => { setActionError(""); setMessage(msg); };

  /** Runs one inline action (visibility, rating, status) with busy/error state. */
  const act = async (key: string, fn: () => Promise<unknown>, success: string, ctx: "profile" | "transition" = "profile") => {
    setBusy(key); setActionError(""); setMessage("");
    try { await fn(); announce(success); refresh(); }
    catch (e) { setActionError(salesError(e, ctx)); }
    finally { setBusy(null); }
  };

  const back = <button type="button" className="btn sm backbtn" onClick={onBack}>← {backLabel}</button>;

  if (q.isLoading) return <>{back}<Loading /></>;
  if (q.error || !q.data) {
    const notFound = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <>
        {back}
        <div className="card notfound">
          <h1 ref={headingRef} tabIndex={-1}>{notFound ? "Candidate not available" : "Couldn't load this candidate"}</h1>
          <p className="sub" role="alert">
            {notFound ? "This candidate doesn't exist, or the profile belongs to another team. Hot List details stay visible on the Hot List." : salesError(q.error)}
          </p>
        </div>
      </>
    );
  }

  const c: Profile = q.data;
  const a = c.actions;
  const canUpdate = a ? a.edit : caps.has("candidate:update");
  const canVisibility = a ? a.visibility : caps.has("candidate.visibility:update");
  const canRate = a ? a.rating : caps.has("candidate.rating:update");
  const canSubmit = a ? a.logSubmission : caps.has("submission:create");
  const next = a ? a.transition : canUpdate ? TRANSITIONS[c.status] ?? [] : [];
  // With hints, the status block appears only when a change is allowed; without, for candidate:update holders.
  const showStatus = a ? next.length > 0 : canUpdate;
  // The Hot List is the active statuses, so "In training" -> Active is what puts a candidate on it.
  const canAddToHotList = c.status === "in_training" && next.includes("active");

  return (
    <>
      {back}
      <div className="pagehead">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>{c.name}</h1>
          <p className="sub">
            <StatusBadge status={c.status} />{" "}
            {c.statusLabel && c.statusLabel.includes("/") && <>{c.statusLabel}{" "}</>}
            {c.visibility === "all_teams" && <><OpenToAllBadge />{" "}</>}
            {c.visibility === "selected_teams" && <><SharedBadge />{" "}</>}
            <Priority p={c.priority} /> · {c.technology} · {c.team.name}
          </p>
        </div>
        <div className="rowactions push">
          {canAddToHotList && (
            <button type="button" className="btn" disabled={busy !== null} aria-busy={busy === "to:active" || undefined}
              onClick={() => void act("to:active", () => salesApi.transition(c.id, "active"), "Added to the Hot List (status Active).", "transition")}>
              Add to Hot List
            </button>
          )}
          {canUpdate &&<button type="button" className="btn" onClick={() => setModal({ kind: "edit" })}>Edit profile</button>}
          {canSubmit && <button type="button" className="btn primary" onClick={() => { pendingWarning.current = ""; setWarning(""); setModal({ kind: "submit" }); }}>Log submission</button>}
        </div>
      </div>

      <p role="status" aria-live="polite" className="livemsg">{message}</p>
      {warning && <p className="note warn" role="alert">{warning}</p>}
      {actionError && <p className="banner error" role="alert">{actionError}</p>}

      <div className="profilegrid">
        <section className="card pad" aria-labelledby="facts-h">
          <h2 id="facts-h">Details</h2>
          <dl className="facts">
            <dt>Technology</dt><dd>{c.technology}</dd>
            <dt>Team</dt><dd>{c.team.name}</dd>
            {c.teamAssignedAt && <><dt>Added to team</dt><dd>{fmtDate(c.teamAssignedAt)}</dd></>}
            <dt>Recruiter</dt><dd>{c.recruiter?.name ?? "Unassigned"}</dd>
            <dt>Location</dt><dd>{c.location.name}</dd>
            {c.stay !== undefined && <><dt>Stay</dt><dd>{stayLabel(c)}</dd></>}
            {c.marketingLocations !== undefined && <><dt>Marketing locations</dt><dd>{c.marketingLocations.length ? c.marketingLocations.join("; ") : "Not recorded"}</dd></>}
            {c.visaCategory !== undefined && <><dt>Visa (marketed)</dt><dd>{visaLabel(c.visaCategory)}</dd></>}
            {c.eligibility !== undefined && <><dt>Eligibility</dt><dd>{eligibilityLabel(c.eligibility)}</dd></>}
            {c.confirmations !== undefined && <><dt>Confirmations</dt><dd>{c.confirmations}</dd></>}
            {c.linkedinUrl !== undefined && (
              <><dt>LinkedIn</dt><dd>{c.linkedinUrl ? (isSafeHttpsUrl(c.linkedinUrl) ? <a href={c.linkedinUrl} target="_blank" rel="noopener noreferrer">Open profile</a> : c.linkedinUrl) : "—"}</dd></>
            )}
            {c.resumeUrl !== undefined && (
              <><dt>Resume link</dt><dd>{c.resumeUrl ? (isSafeHttpsUrl(c.resumeUrl) ? <a href={c.resumeUrl} target="_blank" rel="noopener noreferrer">Open resume</a> : c.resumeUrl) : "—"}</dd></>
            )}
            {c.batch !== undefined && <><dt>Batch</dt><dd>{c.batch?.label ?? "No batch"}</dd></>}
            <dt>Phone</dt><dd><Phone c={c} /></dd>
            {c.dobMasked && <><dt>Date of birth</dt><dd className="masked">{c.dobMasked}</dd></>}
            <dt>Marketing since</dt><dd>{fmtDate(c.marketingStartDate)}</dd>
            <dt>Days in market</dt><dd>{c.daysInMarket ?? "—"}</dd>
            <dt>Technical rating</dt><dd>{c.technicalRating ? `${c.technicalRating} / 5` : "Not rated"}</dd>
            <dt>Visibility</dt><dd>{VISIBILITY_LABELS[c.visibility]}{c.sharedTeams?.length ? `: ${c.sharedTeams.map((t) => t.name).join(", ")}` : ""}</dd>
            {c.inPersonOk !== undefined && <><dt>In-person interviews</dt><dd>{c.inPersonOk === null ? "Not recorded" : c.inPersonOk ? "Open to in-person" : "Remote only"}</dd></>}
            {c.marketingEmail !== undefined && <><dt>Marketing email</dt><dd>{c.marketingEmail ?? "—"}</dd></>}
            {c.vitelNumber !== undefined && <><dt>VITEL number</dt><dd>{c.vitelNumber ?? "—"}</dd></>}
          </dl>
        </section>

        {(canVisibility || canRate || showStatus) && (
          <section className="card pad" aria-labelledby="manage-h">
            <h2 id="manage-h">Manage</h2>
            {canVisibility && (
              <VisibilitySwitch value={c.visibility} busy={busy === "vis"}
                onChange={(to) => void act("vis", () => salesApi.setVisibility(c.id, to),
                  to === "all_teams" ? `${c.name} is now open to all teams.` : `${c.name} is now visible to your team only.`)} />
            )}
            {canVisibility && (
              <TeamSharePicker ownTeamId={c.team.id} visibility={c.visibility} shared={c.sharedTeams ?? []} busy={busy === "share"}
                onSave={(ids) => void act("share", () => salesApi.setVisibility(c.id, ids.length ? "selected_teams" : "team", ids.length ? ids : undefined),
                  ids.length ? `${c.name} is now shared with ${ids.length === 1 ? "1 team" : `${ids.length} teams`}.` : `${c.name} is now visible to your team only.`)} />
            )}
            {canRate && (
              <RatingForm current={c.technicalRating} busy={busy === "rating"}
                onSave={(r) => void act("rating", () => salesApi.setRating(c.id, r), `Technical rating set to ${r} of 5.`)} />
            )}
            {showStatus && (
              <div className="manageblock">
                <h3 id="status-h">Status</h3>
                {next.length === 0 ? <p className="muted">No status changes are available from {statusLabel(c.status)}.</p> : (
                  <div className="rowactions" role="group" aria-labelledby="status-h">
                    {next.map((to) => to === "terminated" ? (
                      <button key={to} type="button" className="btn sm danger" disabled={busy !== null} onClick={() => setModal({ kind: "terminate" })}>Terminate…</button>
                    ) : (
                      <button key={to} type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === `to:${to}` || undefined}
                        onClick={() => void act(`to:${to}`, () => salesApi.transition(c.id, to), `Status changed to ${statusLabel(to)}.`, "transition")}>
                        Move to {statusLabel(to)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {(c.companies !== undefined || c.documentsStatus !== undefined) && (
          <section className="card pad" aria-labelledby="compliance-h">
            <h2 id="compliance-h">Companies and documents</h2>
            <dl className="facts">
              <dt>Documents status</dt><dd>{documentsLabel(c.documentsStatus)}</dd>
              {c.companies && (
                <>
                  <dt>E-Verify company</dt><dd>{c.companies.everify?.name ?? "—"}</dd>
                  <dt>Offer letter company</dt><dd>{c.companies.offerLetter?.name ?? "—"}</dd>
                  <dt>1099 company</dt><dd>{c.companies.form1099?.name ?? "—"}</dd>
                </>
              )}
            </dl>
            {c.canEditCompliance && <button type="button" className="btn" onClick={() => setModal({ kind: "compliance" })}>Edit companies and documents</button>}
          </section>
        )}
        {caps.has("document:read") && <CandidateResumes candidateId={c.id} />}
        {caps.has("document:read") && <DocumentsSection owner={{ kind: "candidate", id: c.id }} title="Paperwork documents" />}
        {caps.has("visa:read") && <CandidateWorkAuthorization candidateId={c.id} />}
        {caps.has("training:read") && <CandidateTraining candidateId={c.id} />}

        <NonResponseCard candidateId={c.id} />
        <CandidateTimeline id={c.id} />
      </div>

      {modal?.kind === "edit" && (
        <EditProfileDialog candidate={c} onClose={() => setModal(null)} onSaved={() => { setModal(null); announce("Profile saved."); refresh(); }} />
      )}
      {modal?.kind === "compliance" && (
        <ComplianceDialog candidate={c} onClose={() => setModal(null)} onSaved={() => { setModal(null); announce("Companies and documents saved."); refresh(); }} />
      )}
      {modal?.kind === "submit" && (
        <LogSubmissionDialog candidate={c}
          canAddClient={caps.has("client:create")} canAddVendor={caps.has("vendor:create")}
          onClose={() => { setModal(null); setWarning(pendingWarning.current); }}
          onLogged={(r) => { announce("Submission logged."); pendingWarning.current = r.duplicateWarning ? DUPLICATE_WARNING : ""; }} />
      )}
      {modal?.kind === "terminate" && (
        <ConfirmDialog title={`Terminate ${c.name}?`} confirmLabel="Terminate" danger formatError={(e) => salesError(e, "transition")}
          action={() => salesApi.transition(c.id, "terminated")} onClose={() => setModal(null)}
          onDone={() => { setModal(null); announce("Status changed to Terminated."); refresh(); }}>
          <p>The candidate leaves the Hot List. This can't be undone from this screen.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function VisibilitySwitch({ value, busy, onChange }: { value: Visibility; busy: boolean; onChange: (v: Visibility) => void }) {
  const id = useId();
  const on = value === "all_teams";
  return (
    <div className="manageblock">
      <h3 id={`${id}-l`}>Open to all teams</h3>
      <p id={`${id}-d`} className="hint">When on, every Sales team can see and submit this candidate while they're active.</p>
      <button type="button" role="switch" aria-checked={on} aria-labelledby={`${id}-l`} aria-describedby={`${id}-d`}
        className={`switch ${on ? "on" : ""}`} disabled={busy} aria-busy={busy || undefined} onClick={() => onChange(on ? "team" : "all_teams")}>
        <span className="knob" aria-hidden="true" /> <span>{on ? "On" : "Off"}</span>
      </button>
    </div>
  );
}

/**
 * "Selected teams" (0240): pick the teams that may also see the candidate. Saving
 * with none picked goes back to team only; Open to all teams already covers every team.
 */
function TeamSharePicker({ ownTeamId, visibility, shared, busy, onSave }: {
  ownTeamId: string; visibility: Visibility; shared: { id: string }[]; busy: boolean; onSave: (teamIds: string[]) => void;
}) {
  const id = useId();
  const savedKey = shared.map((t) => t.id).sort().join(",");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(shared.map((t) => t.id)));
  useEffect(() => setPicked(new Set(savedKey ? savedKey.split(",") : [])), [savedKey]);
  const dirty = [...picked].sort().join(",") !== savedKey;
  const openToAll = visibility === "all_teams";
  return (
    <form className="manageblock" aria-labelledby={`${id}-l`} onSubmit={(e) => { e.preventDefault(); onSave([...picked]); }}>
      <h3 id={`${id}-l`}>Share with selected teams</h3>
      <p id={`${id}-d`} className="hint">
        {openToAll
          ? "Open to all teams already shares this candidate with every team. Turn it off to pick teams."
          : "Picked teams can see and submit this candidate while they're active. Your team always sees it."}
      </p>
      {!openToAll && (
        <>
          <TeamChecklist picked={picked} onChange={setPicked} excludeTeamId={ownTeamId} disabled={busy} describedBy={`${id}-d`} />
          <button type="submit" className="btn" disabled={busy || !dirty} aria-busy={busy || undefined}>Save sharing</button>
        </>
      )}
    </form>
  );
}

function RatingForm({ current, busy, onSave }: { current: number | null; busy: boolean; onSave: (r: number) => void }) {
  const id = useId();
  const [r, setR] = useState(String(current ?? ""));
  useEffect(() => setR(String(current ?? "")), [current]);
  return (
    <form className="manageblock" onSubmit={(e) => { e.preventDefault(); if (r) onSave(Number(r)); }}>
      <h3>Technical rating</h3>
      <div className="toolbar">
        <div className="field inline">
          <label htmlFor={id}>Rating (1 to 5)</label>
          <select id={id} value={r} onChange={(e) => setR(e.target.value)}>
            <option value="" disabled>Choose…</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button type="submit" className="btn" disabled={busy || !r || Number(r) === current} aria-busy={busy || undefined}>Save rating</button>
      </div>
    </form>
  );
}
