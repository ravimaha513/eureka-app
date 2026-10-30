import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isSafeHttpsUrl } from "@eureka/shared";
import { ApiError, type Me } from "../api";
import { ConfirmDialog } from "../ui/Dialog";
import { CandidateResumes } from "./CandidateResumes";
import { DocumentsSection } from "../documents/DocumentsSection";
import { CandidateMetrics } from "./CandidateMetrics";
import { CandidateTimeline } from "./CandidateTimeline";
import { NonResponseCard } from "../pipelinereport/NonResponseCard";
import { CandidateWorkAuthorization } from "../workauth/CandidateWorkAuthorization";
import { CandidateTraining } from "../training/CandidateTraining";
import { CandidateSubmissions } from "../pipeline/CandidateSubmissions";
import { pipelineKeys } from "../pipeline/pipelineApi";
import { EditProfileDialog } from "./EditProfileDialog";
import { ComplianceDialog } from "./ComplianceDialog";
import { documentsLabel, eligibilityLabel, stayLabel, visaLabel } from "./candidateFields";
import { salesError } from "./errors";
import { DUPLICATE_WARNING, LogSubmissionDialog } from "./LogSubmissionDialog";
import { TRANSITIONS, VISIBILITY_LABELS, salesApi, salesKeys, statusLabel, type CandidateProfile as Profile, type Visibility } from "./salesApi";
import { OpenToAllBadge, Phone, Priority, SharedBadge, StatusBadge, fmtDate } from "./ui";
import { Loading } from "../ui/Loading";
import { TeamChecklist } from "./TeamChecklist";

const BLANK = new Set(["Not recorded", "—", "Not rated", "No batch"]);

type Tab = "overview" | "submissions" | "documents" | "training" | "activity";
type Modal = { kind: "edit" } | { kind: "submit" } | { kind: "terminate" } | { kind: "compliance" } | { kind: "delete" };

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
  const [tab, setTab] = useState<Tab>("overview");
  const tabsId = useId();

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
  const canDelete = a ? a.delete : caps.has("candidate:delete");
  const next = a ? a.transition : canUpdate ? TRANSITIONS[c.status] ?? [] : [];
  // With hints, the status block appears only when a change is allowed; without, for candidate:update holders.
  const showStatus = a ? next.length > 0 : canUpdate;
  // The Hot List is the active statuses, so "In training" -> Active is what puts a candidate on it.
  const canAddToHotList = c.status === "in_training" && next.includes("active");

  type Fact = { label: string; value: ReactNode; className?: string };
  const link = (url: string | null, text: string) =>
    url ? (isSafeHttpsUrl(url) ? <a href={url} target="_blank" rel="noopener noreferrer">{text}</a> : url) : "—";
  const facts: (Fact | false)[] = [
    { label: "Technology", value: c.technology },
    { label: "Team", value: c.team.name },
    !!c.teamAssignedAt && { label: "Added to team", value: fmtDate(c.teamAssignedAt) },
    { label: "Recruiter", value: c.recruiter?.name ?? "Unassigned" },
    { label: "Location", value: c.location.name },
    { label: "Phone", value: <Phone c={c} /> },
    !!c.dobMasked && { label: "Date of birth", value: c.dobMasked, className: "masked" },
    c.stay !== undefined && { label: "Stay", value: stayLabel(c) },
    c.marketingLocations !== undefined && { label: "Marketing locations", value: c.marketingLocations.length ? c.marketingLocations.join("; ") : "Not recorded" },
    c.visaCategory !== undefined && { label: "Visa (marketed)", value: visaLabel(c.visaCategory) },
    c.eligibility !== undefined && { label: "Eligibility", value: eligibilityLabel(c.eligibility) },
    c.confirmations !== undefined && { label: "Confirmations", value: c.confirmations },
    c.linkedinUrl !== undefined && { label: "LinkedIn", value: link(c.linkedinUrl, "Open profile") },
    c.resumeUrl !== undefined && { label: "Resume link", value: link(c.resumeUrl, "Open resume") },
    c.batch !== undefined && { label: "Batch", value: c.batch?.label ?? "No batch" },
    { label: "Marketing since", value: fmtDate(c.marketingStartDate) },
    { label: "Days in market", value: c.daysInMarket ?? "—" },
    { label: "Technical rating", value: c.technicalRating ? `${c.technicalRating} / 5` : "Not rated" },
    { label: "Visibility", value: `${VISIBILITY_LABELS[c.visibility]}${c.sharedTeams?.length ? `: ${c.sharedTeams.map((t) => t.name).join(", ")}` : ""}` },
    c.inPersonOk !== undefined && { label: "In-person interviews", value: c.inPersonOk === null ? "Not recorded" : c.inPersonOk ? "Open to in-person" : "Remote only" },
    c.marketingEmail !== undefined && { label: "Marketing email", value: c.marketingEmail ?? "—" },
    c.vitelNumber !== undefined && { label: "VITEL number", value: c.vitelNumber ?? "—" },
  ];
  const shown = facts.filter((f): f is Fact => !!f);
  // Unset fields fold under "Not recorded (n)" so the filled ones are easy to scan.
  const isBlank = (f: Fact) => typeof f.value === "string" && BLANK.has(f.value);
  const filled = shown.filter((f) => !isBlank(f));
  const blank = shown.filter(isBlank);
  const factList = (list: Fact[]) => (
    <dl className="facts">
      {list.map((f) => <Fragment key={f.label}><dt>{f.label}</dt><dd className={f.className}>{f.value}</dd></Fragment>)}
    </dl>
  );

  const hasDocs = caps.has("document:read") || caps.has("visa:read") || c.companies !== undefined || c.documentsStatus !== undefined;
  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    ...(caps.has("submission:read") ? [{ key: "submissions" as const, label: "Submissions" }] : []),
    ...(hasDocs ? [{ key: "documents" as const, label: "Documents" }] : []),
    ...(caps.has("training:read") ? [{ key: "training" as const, label: "Training" }] : []),
    { key: "activity", label: "Activity" },
  ];
  const current = tabs.some((t) => t.key === tab) ? tab : "overview";

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
          {showStatus && (
            <StatusMenu from={c.status} next={next} busy={busy}
              onPick={(to) => to === "terminated" ? setModal({ kind: "terminate" })
                : void act(`to:${to}`, () => salesApi.transition(c.id, to), `Status changed to ${statusLabel(to)}.`, "transition")} />
          )}
          {canUpdate && <button type="button" className="btn" onClick={() => setModal({ kind: "edit" })}>Edit profile</button>}
          {canSubmit && <button type="button" className="btn primary" onClick={() => { pendingWarning.current = ""; setWarning(""); setModal({ kind: "submit" }); }}>Log submission</button>}
          {canDelete && <button type="button" className="btn danger" onClick={() => setModal({ kind: "delete" })}>Delete…</button>}
        </div>
      </div>

      <p role="status" aria-live="polite" className="livemsg">{message}</p>
      {warning && <p className="note warn" role="alert">{warning}</p>}
      {actionError && <p className="banner error" role="alert">{actionError}</p>}

      <div className="tabs cp-tabs" role="tablist" aria-label="Candidate sections">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" id={`${tabsId}-t-${t.key}`} className="tab" aria-selected={current === t.key}
            aria-controls={`${tabsId}-p-${t.key}`} tabIndex={current === t.key ? 0 : -1} onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              const i = tabs.findIndex((x) => x.key === t.key);
              const j = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : -1;
              if (j < 0) return;
              e.preventDefault(); setTab(tabs[j]!.key);
              document.getElementById(`${tabsId}-t-${tabs[j]!.key}`)?.focus();
            }}>
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${tabsId}-p-${current}`} aria-labelledby={`${tabsId}-t-${current}`}>
        {current === "overview" && <CandidateMetrics candidateId={c.id} />}
        {current === "overview" && (
          <div className="cp-overview">
            <section className="card pad" aria-labelledby="facts-h">
              <h2 id="facts-h">Details</h2>
              <div className="cp-facts">{factList(filled)}</div>
              {blank.length > 0 && (
                <details className="cp-blank">
                  <summary>Not recorded ({blank.length})</summary>
                  <div className="cp-facts">{factList(blank)}</div>
                </details>
              )}
            </section>
            <div className="cp-side">
              {(canVisibility || canRate) && (
                <section className="card pad" aria-labelledby="manage-h">
                  <h2 id="manage-h">Sharing and rating</h2>
                  {canVisibility && (
                    <VisibilitySwitch value={c.visibility} busy={busy === "vis"}
                      onChange={(to) => void act("vis", () => salesApi.setVisibility(c.id, to),
                        to === "all_teams" ? `${c.name} is now open to all teams.` : `${c.name} is now visible to your team only.`)} />
                  )}
                  {canVisibility && c.visibility !== "all_teams" && (
                    <TeamSharePicker ownTeamId={c.team.id} shared={c.sharedTeams ?? []} busy={busy === "share"}
                      onSave={(ids) => void act("share", () => salesApi.setVisibility(c.id, ids.length ? "selected_teams" : "team", ids.length ? ids : undefined),
                        ids.length ? `${c.name} is now shared with ${ids.length === 1 ? "1 team" : `${ids.length} teams`}.` : `${c.name} is now visible to your team only.`)} />
                  )}
                  {canRate && (
                    <RatingForm current={c.technicalRating} busy={busy === "rating"}
                      onSave={(r) => void act("rating", () => salesApi.setRating(c.id, r), `Technical rating set to ${r} of 5.`)} />
                  )}
                </section>
              )}
              <NonResponseCard candidateId={c.id} />
            </div>
          </div>
        )}

        {current === "documents" && (
          <div className="cp-docs">
            {caps.has("document:read") && <CandidateResumes candidateId={c.id} />}
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
            {caps.has("document:read") && <div className="cp-wide"><DocumentsSection owner={{ kind: "candidate", id: c.id }} title="Paperwork documents" /></div>}
            {caps.has("visa:read") && <div className="cp-wide"><CandidateWorkAuthorization candidateId={c.id} /></div>}
          </div>
        )}

        {current === "submissions" && <CandidateSubmissions candidateId={c.id} />}
        {current === "training" && <CandidateTraining candidateId={c.id} />}
        {current === "activity" && <CandidateTimeline id={c.id} />}
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
          onLogged={(r) => { announce("Submission logged."); void qc.invalidateQueries({ queryKey: pipelineKeys.submissions }); pendingWarning.current = r.duplicateWarning ? DUPLICATE_WARNING : ""; }} />
      )}
      {modal?.kind === "terminate" && (
        <ConfirmDialog title={`Terminate ${c.name}?`} confirmLabel="Terminate" danger formatError={(e) => salesError(e, "transition")}
          action={() => salesApi.transition(c.id, "terminated")} onClose={() => setModal(null)}
          onDone={() => { setModal(null); announce("Status changed to Terminated."); refresh(); }}>
          <p>The candidate leaves the Hot List. This can't be undone from this screen.</p>
        </ConfirmDialog>
      )}
      {modal?.kind === "delete" && (
        <ConfirmDialog title={`Delete ${c.name}?`} confirmLabel="Delete candidate" danger formatError={(e) => salesError(e, "delete")}
          action={() => salesApi.remove(c.id)} onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            qc.removeQueries({ queryKey: salesKeys.candidate(id) });
            void qc.invalidateQueries({ queryKey: salesKeys.hotlist });
            void qc.invalidateQueries({ queryKey: salesKeys.candidates });
            onBack();
          }}>
          <p>This permanently deletes the candidate with their submissions, interviews and feedback, resumes, documents, paperwork and history. It can't be undone.</p>
          <p>Candidates with a placement or employee record can't be deleted.</p>
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
 * with none picked goes back to team only. Hidden while Open to all teams is on.
 */
function TeamSharePicker({ ownTeamId, shared, busy, onSave }: {
  ownTeamId: string; shared: { id: string }[]; busy: boolean; onSave: (teamIds: string[]) => void;
}) {
  const id = useId();
  const savedKey = shared.map((t) => t.id).sort().join(",");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(shared.map((t) => t.id)));
  useEffect(() => setPicked(new Set(savedKey ? savedKey.split(",") : [])), [savedKey]);
  const dirty = [...picked].sort().join(",") !== savedKey;
  return (
    <form className="manageblock" aria-labelledby={`${id}-l`} onSubmit={(e) => { e.preventDefault(); onSave([...picked]); }}>
      <h3 id={`${id}-l`}>Share with selected teams</h3>
      <p id={`${id}-d`} className="hint">Picked teams can see and submit this candidate while they're active. Your team always sees it.</p>
      <TeamChecklist picked={picked} onChange={setPicked} excludeTeamId={ownTeamId} disabled={busy} describedBy={`${id}-d`} />
      <button type="submit" className="btn" disabled={busy || !dirty} aria-busy={busy || undefined}>Save sharing</button>
    </form>
  );
}

/** "Change status" disclosure: the allowed transitions in a small popover; Escape or a click outside closes it. */
function StatusMenu({ from, next, busy, onPick }: {
  from: string; next: readonly string[]; busy: string | null; onPick: (to: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="cp-statusmenu" ref={wrap}>
      <button ref={toggle} type="button" className="btn" aria-expanded={open} aria-controls={`${id}-p`}
        aria-busy={busy?.startsWith("to:") || undefined} onClick={() => setOpen((o) => !o)}>
        Change status <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id={`${id}-p`} className="cp-statuspop">
          {next.length === 0 ? <p className="muted">No status changes are available from {statusLabel(from)}.</p> : (
            <div role="group" aria-label="Status">
              {next.map((to) => (
                <button key={to} type="button" className={`btn sm ${to === "terminated" ? "danger" : ""}`} disabled={busy !== null}
                  onClick={() => { setOpen(false); onPick(to); }}>
                  {to === "terminated" ? "Terminate…" : `Move to ${statusLabel(to)}`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
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
