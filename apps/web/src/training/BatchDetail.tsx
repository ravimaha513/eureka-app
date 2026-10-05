import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, CalendarDays, ChevronDown, ChevronUp, GraduationCap, Pencil, Plus, Trash2, UserMinus, Users } from "lucide-react";
import type { Me } from "../api";
import { ConfirmDialog, Dialog } from "../admin/Dialog";
import { fmtDate } from "../sales/ui";
import { BatchDialog } from "./BatchDialog";
import {
  NEXT_STATUS, fmtMinutes, trainingApi, trainingError, trainingKeys,
  type AssignedCourse, type BatchDetail, type Student,
} from "./trainingApi";
import { BatchStatusPill, CoverArt, ProgressBar } from "./ui";

/** One batch: header card with stats, then View Courses / View Students (docs/training-api.md). */
export function BatchDetailView({ id, me, onBack, onDeleted }: {
  id: string; me: Me; onBack: () => void; onDeleted: (name: string) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: trainingKeys.batch(id), queryFn: () => trainingApi.batch(id) });
  const [tab, setTab] = useState<"courses" | "students">("courses");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusTo, setStatusTo] = useState<{ to: string; label: string } | null>(null);
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const tabsId = useId();
  useEffect(() => { if (q.data) heading.current?.focus(); }, [q.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => qc.invalidateQueries({ queryKey: trainingKeys.all });

  if (q.isLoading) return <p className="empty">Loading…</p>;
  if (q.error || !q.data) {
    return (
      <div>
        <button type="button" className="backbtn" onClick={onBack}>Back to Training Batches</button>
        <p className="empty error" role="alert">{trainingError(q.error)}</p>
      </div>
    );
  }
  const b = q.data;
  return (
    <>
      <nav className="tr-crumbs" aria-label="Breadcrumb">
        <button type="button" className="linkbtn" onClick={onBack}>Training Batches</button>
        <span aria-hidden="true"> › </span><span aria-current="page">{b.name}</span>
      </nav>
      <section className="card tr-head" aria-labelledby={`${tabsId}-h`}>
        <CoverArt cover={b.cover} caption="Training batch" />
        <div className="tr-headmain">
          <div className="tr-headtop">
            <h1 id={`${tabsId}-h`} ref={heading} tabIndex={-1}>{b.name}</h1>
            <BatchStatusPill status={b.status} />
            {b.actions.manage && (
              <div className="rowactions push">
                {(NEXT_STATUS[b.status] ?? []).map((s) => (
                  <button key={s.to} type="button" className={`btn sm${s.to === "cancelled" ? " danger" : ""}`} onClick={() => setStatusTo(s)}>{s.label}</button>
                ))}
                <button type="button" className="btn sm" onClick={() => setEditing(true)}><Pencil size={14} aria-hidden="true" />Edit</button>
                {b.actions.delete && <button type="button" className="btn sm danger" onClick={() => setDeleting(true)}><Trash2 size={14} aria-hidden="true" />Delete</button>}
              </div>
            )}
          </div>
          <p className="muted">{b.technology.name} · {b.location.name} · {b.trainer ? `Trainer: ${b.trainer.name}` : "No trainer yet"}</p>
          <ul className="tr-stats" aria-label="Batch figures">
            <li><Users size={18} aria-hidden="true" /><b>{b.students}</b><span>Students</span></li>
            <li><BookOpen size={18} aria-hidden="true" /><b>{b.courses}</b><span>Courses</span></li>
            <li><CalendarDays size={18} aria-hidden="true" /><b>{fmtDate(b.startDate)}</b><span>Start date{b.endDate ? ` (ends ${fmtDate(b.endDate)})` : ""}</span></li>
            <li><GraduationCap size={18} aria-hidden="true" /><b>{b.batchYear}</b><span>Batch year</span></li>
          </ul>
        </div>
      </section>
      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <div className="tabs tr-tabs" role="tablist" aria-label="Batch sections">
        <button type="button" role="tab" id={`${tabsId}-tc`} className="tab" aria-selected={tab === "courses"} aria-controls={`${tabsId}-pc`}
          onClick={() => setTab("courses")}><BookOpen size={15} aria-hidden="true" />&nbsp;View Courses</button>
        <button type="button" role="tab" id={`${tabsId}-ts`} className="tab" aria-selected={tab === "students"} aria-controls={`${tabsId}-ps`}
          onClick={() => setTab("students")}><Users size={15} aria-hidden="true" />&nbsp;View Students</button>
      </div>
      {tab === "courses" ? (
        <div role="tabpanel" id={`${tabsId}-pc`} aria-labelledby={`${tabsId}-tc`}>
          <CoursesPanel batch={b} onNotice={setNotice} />
        </div>
      ) : (
        <div role="tabpanel" id={`${tabsId}-ps`} aria-labelledby={`${tabsId}-ts`}>
          <StudentsPanel batch={b} onNotice={setNotice} />
        </div>
      )}

      {editing && <BatchDialog me={me} batch={b} onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); setNotice("Batch saved."); void refresh(); }} />}
      {statusTo && (
        <ConfirmDialog title={`${statusTo.label}?`} confirmLabel={statusTo.label} danger={statusTo.to === "cancelled"} formatError={trainingError}
          action={() => trainingApi.setStatus(b.id, statusTo.to)} onClose={() => setStatusTo(null)}
          onDone={() => { setStatusTo(null); setNotice("Batch status changed."); void refresh(); }}>
          <p>{statusTo.to === "cancelled" ? "A cancelled batch can't be reopened, and progress can no longer be recorded."
            : statusTo.to === "completed" ? "Progress can no longer be recorded once the batch is completed." : "The batch moves to In training."}</p>
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog title={`Delete ${b.name}?`} confirmLabel="Delete batch" danger formatError={trainingError}
          action={() => trainingApi.deleteBatch(b.id)} onClose={() => setDeleting(false)}
          onDone={() => { setDeleting(false); void refresh(); onDeleted(b.name); }}>
          <p>The batch has no students. Its course list goes with it. This can't be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function CoursesPanel({ batch, onNotice }: { batch: BatchDetail; onNotice: (s: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AssignedCourse | null>(null);
  const [error, setError] = useState("");
  const courses = batch.assignedCourses;
  const manage = batch.actions.manage;
  const refresh = () => qc.invalidateQueries({ queryKey: trainingKeys.all });
  const move = async (i: number, d: -1 | 1) => {
    const ids = courses.map((c) => c.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    setError("");
    try { await trainingApi.reorderCourses(batch.id, ids); onNotice(`${courses[i]!.title} moved ${d < 0 ? "up" : "down"}.`); await refresh(); }
    catch (e) { setError(trainingError(e)); }
  };
  return (
    <section className="card pad tr-panel" aria-label="Assigned courses">
      <div className="pagehead">
        <h2>Assigned Courses</h2>
        {manage && <button type="button" className="btn sm push" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />Add course</button>}
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      {courses.length === 0 ? <p className="empty">No courses assigned yet.</p> : (
        <ul className="tr-acc">
          {courses.map((c, i) => {
            const expanded = open.has(c.id);
            const panel = `tr-course-${c.id}`;
            return (
              <li key={c.id} className="tr-accitem">
                <div className="tr-accrow">
                  <button type="button" className="tr-acctoggle" aria-expanded={expanded} aria-controls={panel}
                    onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}>
                    <CoverArt cover={c.cover} size="sm" />
                    <span><b>{c.title}</b><small className="block muted">{c.modules.length} {c.modules.length === 1 ? "module" : "modules"} · {fmtMinutes(c.totalMinutes)}</small></span>
                    <ChevronDown size={18} aria-hidden="true" className="tr-caret" />
                  </button>
                  {manage && (
                    <span className="rowactions">
                      <button type="button" className="iconbtn" aria-label={`Move ${c.title} up`} disabled={i === 0} onClick={() => void move(i, -1)}><ChevronUp size={16} aria-hidden="true" /></button>
                      <button type="button" className="iconbtn" aria-label={`Move ${c.title} down`} disabled={i === courses.length - 1} onClick={() => void move(i, 1)}><ChevronDown size={16} aria-hidden="true" /></button>
                      <button type="button" className="iconbtn" aria-label={`Remove ${c.title}`} onClick={() => setRemoving(c)}><Trash2 size={16} aria-hidden="true" /></button>
                    </span>
                  )}
                </div>
                {expanded && (
                  <div id={panel} className="tr-accbody">
                    {c.description && <p className="muted tr-desc">{c.description}</p>}
                    {c.modules.length === 0 ? <p className="muted">No modules yet.</p> : (
                      <ol className="tr-modules">
                        {c.modules.map((m) => (
                          <li key={m.id}>
                            <span>{m.title}</span><span className="muted">{fmtMinutes(m.durationMinutes)}</span>
                            {m.resources.length > 0 && (
                              <span className="tr-links">{m.resources.map((u, k) => (
                                <a key={u} href={u} target="_blank" rel="noopener noreferrer">Resource {k + 1}<span className="sr-only"> for {m.title} (opens in a new tab)</span></a>
                              ))}</span>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {adding && <AddCourseDialog batch={batch} onClose={() => setAdding(false)}
        onAdded={(title) => { setAdding(false); onNotice(`${title} added.`); void refresh(); }} />}
      {removing && (
        <ConfirmDialog title={`Remove ${removing.title}?`} confirmLabel="Remove course" danger formatError={trainingError}
          action={() => trainingApi.removeCourse(batch.id, removing.id)} onClose={() => setRemoving(null)}
          onDone={() => { onNotice(`${removing.title} removed.`); setRemoving(null); void refresh(); }}>
          <p>Students' completions of its modules are kept and come back if the course is assigned again.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function AddCourseDialog({ batch, onClose, onAdded }: { batch: BatchDetail; onClose: () => void; onAdded: (title: string) => void }) {
  const q = useQuery({ queryKey: trainingKeys.courses(false), queryFn: () => trainingApi.courses(false) });
  const assigned = new Set(batch.assignedCourses.map((c) => c.id));
  const options = (q.data?.items ?? []).filter((c) => !assigned.has(c.id));
  const [courseId, setCourseId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  return (
    <Dialog title="Add course" onClose={onClose}>
      <form noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (!courseId) { setError("Choose a course."); return; }
        setBusy(true); setError("");
        try { await trainingApi.addCourse(batch.id, courseId); onAdded(options.find((c) => c.id === courseId)?.title ?? "Course"); }
        catch (err) { setError(trainingError(err)); } finally { setBusy(false); }
      }}>
        <div className="field">
          <label htmlFor={`${id}-c`}>Course</label>
          <select id={`${id}-c`} data-autofocus value={courseId} onChange={(e) => setCourseId(e.target.value)} disabled={q.isLoading}>
            <option value="" disabled>{q.isLoading ? "Loading…" : options.length ? "Choose…" : "No other courses in the library"}</option>
            {options.map((c) => <option key={c.id} value={c.id}>{c.title} ({c.modules} modules · {fmtMinutes(c.totalMinutes)})</option>)}
          </select>
        </div>
        {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Working…" : "Add course"}</button>
        </div>
      </form>
    </Dialog>
  );
}

function StudentsPanel({ batch, onNotice }: { batch: BatchDetail; onNotice: (s: string) => void }) {
  const qc = useQueryClient();
  const id = useId();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => { const t = setTimeout(() => setSearch(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const q = useQuery({ queryKey: trainingKeys.students(batch.id, search), queryFn: () => trainingApi.students(batch.id, search) });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Student | null>(null);
  const [error, setError] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: trainingKeys.all });
  const manage = batch.actions.manage;
  const items = q.data?.items ?? [];

  const toggle = async (s: Student, moduleId: string, title: string, completed: boolean) => {
    setError("");
    try {
      await trainingApi.setModule(batch.id, s.candidateId, moduleId, completed);
      onNotice(`${title} marked ${completed ? "complete" : "not complete"} for ${s.name}.`);
      await qc.invalidateQueries({ queryKey: ["training", "students", batch.id] });
    } catch (e) { setError(trainingError(e)); }
  };

  return (
    <section className="card pad tr-panel" aria-label="Students">
      <div className="pagehead">
        <h2>Enrolled Students</h2>
        <div className="toolbar push">
          <div className="field inline">
            <label htmlFor={`${id}-q`}>Search students</label>
            <input id={`${id}-q`} type="search" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
          </div>
          {manage && <button type="button" className="btn sm" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />Add student</button>}
        </div>
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="empty error" role="alert">{trainingError(q.error)}</p>
        : items.length === 0 ? <p className="empty">{search ? "No students match this search." : "No students in this batch yet."}</p> : (
          <ul className="tr-acc" aria-label="Students and progress">
            {items.map((s) => {
              const expanded = open.has(s.candidateId);
              const panel = `tr-st-${s.candidateId}`;
              const done = new Map(s.completions.map((c) => [c.moduleId, c]));
              return (
                <li key={s.candidateId} className="tr-accitem">
                  <div className="tr-accrow">
                    <button type="button" className="tr-acctoggle" aria-expanded={expanded} aria-controls={panel}
                      onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(s.candidateId)) n.delete(s.candidateId); else n.add(s.candidateId); return n; })}>
                      <span className="tr-stname"><b>{s.name}</b><small className="block muted">{s.technology} · {fmtMinutes(s.completedMinutes)} of {fmtMinutes(s.totalMinutes)}</small></span>
                      <ChevronDown size={18} aria-hidden="true" className="tr-caret" />
                    </button>
                    <ProgressBar percent={s.percent} label={`Overall progress of ${s.name}`} />
                    {manage && (
                      <button type="button" className="iconbtn" aria-label={`Remove ${s.name} from the batch`} onClick={() => setRemoving(s)}>
                        <UserMinus size={16} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <div id={panel} className="tr-accbody">
                      {batch.assignedCourses.length === 0 ? <p className="muted">No courses assigned yet.</p> : batch.assignedCourses.map((c) => {
                        const cp = s.courses.find((x) => x.courseId === c.id);
                        return (
                          <div key={c.id} className="tr-stcourse">
                            <div className="tr-stcoursehead">
                              <b>{c.title}</b>
                              <ProgressBar percent={cp?.percent ?? 0} label={`${c.title} progress of ${s.name}`} />
                            </div>
                            <ul className="tr-checks">
                              {c.modules.map((m) => {
                                const d = done.get(m.id);
                                return (
                                  <li key={m.id}>
                                    <label className="check">
                                      <input type="checkbox" checked={Boolean(d)} disabled={!batch.actions.updateProgress}
                                        onChange={(e) => void toggle(s, m.id, m.title, e.target.checked)} />
                                      {" "}{m.title} <span className="muted">({fmtMinutes(m.durationMinutes)})</span>
                                    </label>
                                    {d && <small className="muted"> Completed {fmtDate(d.completedAt)}{d.completedBy.name ? ` by ${d.completedBy.name}` : ""}</small>}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      {adding && <AddStudentDialog batch={batch} onClose={() => setAdding(false)}
        onAdded={(name) => { onNotice(`${name} added to the batch.`); void refresh(); }} />}
      {removing && (
        <ConfirmDialog title={`Remove ${removing.name}?`} confirmLabel="Remove student" danger formatError={trainingError}
          action={() => trainingApi.removeStudent(batch.id, removing.candidateId)} onClose={() => setRemoving(null)}
          onDone={() => { onNotice(`${removing.name} removed from the batch.`); setRemoving(null); void refresh(); }}>
          <p>Their recorded progress is kept and comes back if they rejoin this batch.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function AddStudentDialog({ batch, onClose, onAdded }: { batch: BatchDetail; onClose: () => void; onAdded: (name: string) => void }) {
  const qc = useQueryClient();
  const id = useId();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => { const t = setTimeout(() => setSearch(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const q = useQuery({ queryKey: ["training", "eligible", batch.id, search], queryFn: () => trainingApi.eligible(batch.id, search) });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Dialog title="Add student" onClose={onClose}>
      <p className="hint">Candidates at {batch.location.name}. Adding someone from another batch moves them here.</p>
      <div className="field">
        <label htmlFor={`${id}-q`}>Search candidates</label>
        <input id={`${id}-q`} data-autofocus type="search" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
      </div>
      {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
      {q.isLoading ? <p className="muted">Loading…</p> : (
        <ul className="tr-pick" aria-label="Candidates">
          {(q.data?.items ?? []).map((c) => (
            <li key={c.candidateId}>
              <span><b>{c.name}</b><small className="block muted">{c.technology}{c.currentBatch ? ` · now in ${c.currentBatch.name}` : ""}</small></span>
              <button type="button" className="btn sm" disabled={busy !== null} aria-label={`Add ${c.name}`} onClick={async () => {
                setBusy(c.candidateId); setError("");
                try {
                  await trainingApi.addStudent(batch.id, c.candidateId);
                  onAdded(c.name);
                  await qc.invalidateQueries({ queryKey: ["training", "eligible", batch.id] });
                } catch (e) { setError(trainingError(e)); } finally { setBusy(null); }
              }}>{busy === c.candidateId ? "Adding…" : "Add"}</button>
            </li>
          ))}
          {q.data?.items.length === 0 && <li className="muted">No candidates found.</li>}
        </ul>
      )}
      <div className="actions"><button type="button" className="btn" onClick={onClose}>Done</button></div>
    </Dialog>
  );
}
