import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type Me } from "../api";
import { ConfirmDialog } from "../admin/Dialog";
import { EditProfileDialog } from "./EditProfileDialog";
import { salesError } from "./errors";
import { DUPLICATE_WARNING, LogSubmissionDialog } from "./LogSubmissionDialog";
import { TRANSITIONS, salesApi, salesKeys, statusLabel, type CandidateProfile as Profile, type Visibility } from "./salesApi";
import { OpenToAllBadge, Phone, Priority, StatusBadge, fmtDate } from "./ui";

type Modal = { kind: "edit" } | { kind: "submit" } | { kind: "terminate" };

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

  if (q.isLoading) return <>{back}<p className="empty">Loading…</p></>;
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

  return (
    <>
      {back}
      <div className="pagehead">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>{c.name}</h1>
          <p className="sub">
            <StatusBadge status={c.status} />{" "}
            {c.visibility === "all_teams" && <><OpenToAllBadge />{" "}</>}
            <Priority p={c.priority} /> · {c.technology} · {c.team.name}
          </p>
        </div>
        <div className="rowactions push">
          {canUpdate && <button type="button" className="btn" onClick={() => setModal({ kind: "edit" })}>Edit profile</button>}
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
            <dt>Recruiter</dt><dd>{c.recruiter?.name ?? "Unassigned"}</dd>
            <dt>Location</dt><dd>{c.location.name}</dd>
            <dt>Phone</dt><dd><Phone c={c} /></dd>
            {c.dobMasked && <><dt>Date of birth</dt><dd className="masked">{c.dobMasked}</dd></>}
            <dt>Marketing since</dt><dd>{fmtDate(c.marketingStartDate)}</dd>
            <dt>Days in market</dt><dd>{c.daysInMarket ?? "—"}</dd>
            <dt>Technical rating</dt><dd>{c.technicalRating ? `${c.technicalRating} / 5` : "Not rated"}</dd>
            <dt>Visibility</dt><dd>{c.visibility === "all_teams" ? "Open to all teams" : "Team only"}</dd>
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
      </div>

      {modal?.kind === "edit" && (
        <EditProfileDialog candidate={c} onClose={() => setModal(null)} onSaved={() => { setModal(null); announce("Profile saved."); refresh(); }} />
      )}
      {modal?.kind === "submit" && (
        <LogSubmissionDialog candidate={c}
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
