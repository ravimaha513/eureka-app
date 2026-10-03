import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ROLE_LABELS, type Role } from "@eureka/shared";
import type { Me } from "../api";
import { Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { DocumentsSection } from "../documents/DocumentsSection";
import { Drawer, Field, fmtDate } from "../sales/ui";
import { pipelineError } from "./errors";
import {
  CONTACT_KIND_LABELS, PLACEMENT_STATUSES, PLACEMENT_TYPE_LABELS, WORK_MODE_LABELS,
  dayBoundary, fmtDateTime, fmtRate, pipelineApi, pipelineKeys, pipelineLabel, type Placement,
} from "./pipelineApi";
import { FirstPlacementBadge, PipelineStatus, StatusChips } from "./ui";

const PAGE_SIZE = 50;
/** Exits that need a confirmation and a reason (PL-4). */
const EXITS = new Set(["backout", "bgc_failed"]);
const EXIT_TEXT: Record<string, string> = {
  backout: "The candidate backed out before joining. They return to Active marketing.",
  bgc_failed: "The background check failed. Before joining the candidate returns to Active; after joining the open assignment ends and they move to Bench.",
};

/** "offer_letter" → "Offer letter", "i9" → "I9" (document types are snake_case keys). */
export const docTypeLabel = (t: string) => { const s = t.replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };

const where = (p: Pick<Placement, "projectCity" | "projectState">) => [p.projectCity, p.projectState].filter(Boolean).join(", ");

/** Placements list (GET /api/v1/placements) with a detail drawer for contacts, assignment and status changes. */
export function PlacementsPage({ me, initialOpenId = null }: { me?: Pick<Me, "capabilities">; initialOpenId?: string | null }) {
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [status, setStatusRaw] = useState("");
  const [from, setFromRaw] = useState("");
  const [to, setToRaw] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const page = cursors.length - 1;
  const reset = () => setCursors([null]);
  const invalidRange = Boolean(from && to && from > to);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [notice, setNotice] = useState("");

  const filters = {
    status, from: from ? dayBoundary(from) : "", to: to ? dayBoundary(to, true) : "", cursor: cursors[page] ?? "", limit: PAGE_SIZE,
  };
  const q = useQuery({
    queryKey: [...pipelineKeys.placements, "list", filters],
    queryFn: () => pipelineApi.placements(filters),
    placeholderData: keepPreviousData,
    enabled: !invalidRange,
  });
  const items = q.data?.items ?? [];
  const showRate = items.some((p) => "rate" in p);
  const hasFilters = Boolean(status || from || to);
  const n = items.length;
  const countMsg = q.isLoading || q.error || invalidRange ? ""
    : `${n} ${n === 1 ? "placement" : "placements"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;

  const close = () => {
    setOpenId(null);
    // Opened from another screen, there's no row to return to: land on the heading.
    setTimeout(() => { if (document.activeElement === document.body) headingRef.current?.focus(); });
  };

  return (
    <>
      <div>
        <h1 ref={headingRef} tabIndex={-1}>Placements</h1>
        <p className="sub">Confirmed offers through joining. Open a placement to see contacts and the assignment, or move it to the next step.</p>
      </div>

      <form className="filters" role="search" aria-label="Placement filters" onSubmit={(e) => e.preventDefault()}>
        <StatusChips label="Status" statuses={PLACEMENT_STATUSES} value={status} onChange={(v) => { setStatusRaw(v); reset(); }} />
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-from`}>Created from</label>
            <input id={`${id}-from`} type="date" value={from} onChange={(e) => { setFromRaw(e.target.value); reset(); }} />
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-to`}>Created through</label>
            <input id={`${id}-to`} type="date" value={to} onChange={(e) => { setToRaw(e.target.value); reset(); }}
              aria-invalid={invalidRange || undefined} aria-describedby={invalidRange ? `${id}-range` : undefined} />
          </div>
          {hasFilters && <button type="button" className="btn" onClick={() => { setStatusRaw(""); setFromRaw(""); setToRaw(""); reset(); }}>Clear filters</button>}
        </div>
        {invalidRange && <p id={`${id}-range`} className="error" role="alert">“Created through” must be on or after “Created from”.</p>}
      </form>

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      {!invalidRange && (
        <div className="card tablewrap">
          {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
            <p className="empty error" role="alert">{pipelineError(q.error, "placement")} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
          ) : (
            <table aria-label="Placements" aria-busy={q.isFetching || undefined}>
              <thead><tr>
                <th>Candidate</th><th>Client / vendor</th><th>Type</th><th>Tentative start</th><th>Status</th><th>Recruiter</th>
                {showRate && <th>Rate</th>}
                <th><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.candidate.name}</b>{p.isFirstPlacement && <>{" "}<FirstPlacementBadge /></>}</td>
                    <td>{p.client.name}<span className="block">{p.vendor?.name ?? "No vendor"}</span></td>
                    <td>{PLACEMENT_TYPE_LABELS[p.placementType] ?? p.placementType}<span className="block">{WORK_MODE_LABELS[p.workMode] ?? p.workMode}{where(p) && ` · ${where(p)}`}</span></td>
                    <td>{fmtDate(p.tentativeStart)}</td>
                    <td><PipelineStatus status={p.status} /></td>
                    <td>{p.recruiter.name}<span className="block">{p.team.name}</span></td>
                    {showRate && <td>{"rate" in p ? fmtRate(p.rate) : <span className="muted">—</span>}</td>}
                    <td className="rowactions">
                      <button type="button" className="btn sm" onClick={() => setOpenId(p.id)} aria-label={`Open placement of ${p.candidate.name} at ${p.client.name}`}>Open</button>
                    </td>
                  </tr>
                ))}
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
        <nav className="pager" aria-label="Placement pages">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="btn sm" disabled={!q.data?.nextCursor || q.isPlaceholderData}
            onClick={() => { const nx = q.data?.nextCursor; if (nx) setCursors((c) => [...c, nx]); }}>Next</button>
        </nav>
      </div>

      {openId && <PlacementDrawer id={openId} initial={items.find((p) => p.id === openId) ?? null} onClose={close} onNotice={setNotice}
        canReadDocuments={Boolean(me?.capabilities.includes("document:read"))} />}
    </>
  );
}

function PlacementDrawer({ id, initial, onClose, onNotice, canReadDocuments = false }: {
  id: string; initial: Placement | null; onClose: () => void; onNotice: (m: string) => void; canReadDocuments?: boolean;
}) {
  const qc = useQueryClient();
  const hid = useId();
  // The list row lacks contacts and assignment; show it while the full record loads.
  const q = useQuery({ queryKey: pipelineKeys.placement(id), queryFn: () => pipelineApi.placement(id), placeholderData: initial ?? undefined });
  const [exit, setExit] = useState<string | null>(null);
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

  const transitions = p?.allowedTransitions ?? [];
  const forward = transitions.filter((t) => !EXITS.has(t));
  const exits = transitions.filter((t) => EXITS.has(t));

  return (
    <>
      <Drawer title={p ? `${p.candidate.name} · ${p.client.name}` : "Placement"} onClose={onClose} suspended={exit !== null} wide closeLabel="Close placement details">
        {q.isLoading && !p ? <p className="empty">Loading…</p> : !p ? (
          <p className="error" role="alert">{pipelineError(q.error, "placement")}</p>
        ) : (
          <>
            <p><PipelineStatus status={p.status} />{p.isFirstPlacement && <>{" "}<FirstPlacementBadge /></>}</p>
            <dl className="facts">
              <dt>Candidate</dt><dd>{p.candidate.name}</dd>
              <dt>Client</dt><dd>{p.client.name}</dd>
              <dt>Vendor</dt><dd>{p.vendor?.name ?? "None"}</dd>
              <dt>Type</dt><dd>{PLACEMENT_TYPE_LABELS[p.placementType] ?? p.placementType}</dd>
              <dt>Work mode</dt><dd>{WORK_MODE_LABELS[p.workMode] ?? p.workMode}</dd>
              <dt>Project location</dt><dd>{where(p) || "—"}</dd>
              <dt>Tentative start</dt><dd>{fmtDate(p.tentativeStart)}</dd>
              {"rate" in p && <><dt>Rate</dt><dd>{fmtRate(p.rate)}</dd></>}
              <dt>Recruiter</dt><dd>{p.recruiter.name} · {p.team.name}</dd>
              <dt>Location</dt><dd>{p.location.name}</dd>
              <dt>Created</dt><dd>{fmtDateTime(p.createdAt)}</dd>
              <dt>Last status change</dt><dd>{fmtDateTime(p.statusChangedAt)}</dd>
            </dl>

            <p role="status" aria-live="polite" className="livemsg">{message}</p>
            {error && <p className="banner error" role="alert">{error}</p>}

            {transitions.length > 0 && (
              <section className="manageblock" aria-labelledby={`${hid}-st`}>
                <h3 id={`${hid}-st`}>Status</h3>
                <div className="rowactions" role="group" aria-labelledby={`${hid}-st`}>
                  {forward.map((t) => (
                    <button key={t} type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === t || undefined}
                      onClick={() => void move(t)}>Move to {pipelineLabel(t)}</button>
                  ))}
                  {exits.map((t) => (
                    <button key={t} type="button" className="btn sm danger" disabled={busy !== null} onClick={() => setExit(t)}>
                      {t === "backout" ? "Mark backout…" : "Mark BGC failed…"}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="manageblock" aria-labelledby={`${hid}-c`}>
              <h3 id={`${hid}-c`}>Contacts</h3>
              {!full ? <p className="muted">Loading contacts…</p> : !p.contacts?.length ? <p className="muted">No contacts recorded.</p> : (
                <table className="mini" aria-labelledby={`${hid}-c`}>
                  <thead><tr><th>Kind</th><th>Name</th><th>Email</th><th>Phone</th></tr></thead>
                  <tbody>
                    {p.contacts.map((c, i) => (
                      <tr key={i}>
                        <td>{CONTACT_KIND_LABELS[c.kind] ?? c.kind}</td>
                        <td>{c.name}</td>
                        <td>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="muted">—</span>}</td>
                        <td>{c.phone ?? <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {(!full || p.checklist !== undefined) && (
              <section className="manageblock" aria-labelledby={`${hid}-k`}>
                <h3 id={`${hid}-k`}>Paperwork checklist</h3>
                {!full ? <p className="muted">Loading checklist…</p> : !p.checklist?.length ? (
                  <p className="muted">No paperwork checklist is set up for {PLACEMENT_TYPE_LABELS[p.placementType] ?? p.placementType} placements.</p>
                ) : (
                  <table className="mini" aria-labelledby={`${hid}-k`}>
                    <thead><tr><th>Document</th><th>Owner</th><th>Required</th><th>Status</th></tr></thead>
                    <tbody>
                      {p.checklist.map((c) => (
                        <tr key={c.docType}>
                          <td>{docTypeLabel(c.docType)}</td>
                          <td>{ROLE_LABELS[c.ownerRole as Role] ?? pipelineLabel(c.ownerRole)}</td>
                          <td>{c.required ? "Required" : "Optional"}</td>
                          <td>{pipelineLabel(c.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            )}

            <section className="manageblock" aria-labelledby={`${hid}-a`}>
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

            {canReadDocuments && <DocumentsSection owner={{ kind: "placement", id }} title="Placement documents" />}
          </>
        )}
      </Drawer>

      {p && exit && (
        <ExitDialog placement={p} to={exit} onClose={() => setExit(null)}
          onDone={() => { const t = exit; setExit(null); announce(`Placement marked ${pipelineLabel(t)}.`); refresh(); }} />
      )}
    </>
  );
}

/** Backout / BGC failed: confirm with a required reason (sent as `reason`). */
function ExitDialog({ placement, to, onClose, onDone }: { placement: Placement; to: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [fieldErr, setFieldErr] = useState("");
  const submit = useSubmit((e) => pipelineError(e, "placement"));
  const label = to === "backout" ? "Mark backout" : "Mark BGC failed";
  useEffect(() => setFieldErr(""), [reason]);
  return (
    <Dialog title={`${label} for ${placement.candidate.name}?`} onClose={onClose}>
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
