import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { fmtDate, useFocusAfterFailure } from "../sales/ui";
import { BatchFormDialog } from "./TrainingsPage";
import { fmtMinutes, lmsApi, lmsError, lmsKeys, type BatchCourse, type CourseProgress, type LookupUser, type StudentProgress } from "./lmsApi";
import { BatchStatusChip, ProgressBar, Stat } from "./ui";

type Tab = "courses" | "students";
type Modal = null | "edit" | "archive" | "delete" | "addCourse" | "addStudent" | { removeCourse: BatchCourse } | { removeStudent: StudentProgress };

export function BatchDetailView({ id, onBack, onNotice }: { id: string; onBack: () => void; onNotice: (m: string) => void }) {
  const qc = useQueryClient();
  const tabsId = useId();
  const [tab, setTab] = useState<Tab>("courses");
  const [modal, setModal] = useState<Modal>(null);
  const [message, setMessage] = useState("");
  const q = useQuery({ queryKey: lmsKeys.batch(id), queryFn: () => lmsApi.batch(id) });
  const b = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: lmsKeys.all });
  const done = (m: string) => { setModal(null); setMessage(m); void refresh(); };
  const totalMinutes = b?.courses.reduce((s, c) => s + c.totalMinutes, 0) ?? 0;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <button type="button" className="linkbtn" onClick={onBack}>Trainings</button>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{b?.name ?? "Batch"}</span>
      </nav>
      {q.isLoading ? <p className="empty">Loading…</p> : !b ? (
        <p className="empty error" role="alert">{lmsError(q.error)} <button type="button" className="btn sm" onClick={onBack}>Back to Trainings</button></p>
      ) : (
        <>
          <div className="pagehead">
            <div>
              <h1 tabIndex={-1}>{b.name}</h1>
              <p className="sub"><BatchStatusChip status={b.status} /> {fmtDate(b.startDate)} – {fmtDate(b.endDate)} · {fmtMinutes(totalMinutes)} of content</p>
            </div>
            <div className="rowactions" style={{ marginLeft: "auto" }}>
              <button type="button" className="btn" onClick={() => setModal("edit")}>Edit</button>
              <button type="button" className="btn" onClick={() => setModal("archive")}>Archive</button>
              <button type="button" className="btn danger" onClick={() => setModal("delete")}>Delete</button>
            </div>
          </div>
          <div className="lmsstats">
            <Stat label="Students">{b.studentCount}</Stat>
            <Stat label="Courses">{b.courseCount}</Stat>
            <Stat label="Start date">{fmtDate(b.startDate)}</Stat>
            <Stat label="Batch year">{b.year}</Stat>
          </div>
          <p role="status" aria-live="polite" className="livemsg">{message}</p>
          <div className="lmstabs" role="tablist" aria-label="Batch sections">
            {([["courses", "View Courses"], ["students", "View Students"]] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" className="tab" id={`${tabsId}-${k}`} aria-selected={tab === k} aria-controls={`${tabsId}-p`}
                tabIndex={tab === k ? 0 : -1} onClick={() => setTab(k)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    const nx = k === "courses" ? "students" : "courses";
                    setTab(nx); document.getElementById(`${tabsId}-${nx}`)?.focus();
                  }
                }}>{label}</button>
            ))}
          </div>
          <div role="tabpanel" id={`${tabsId}-p`} aria-labelledby={`${tabsId}-${tab}`}>
            {tab === "courses"
              ? <CoursesTab courses={b.courses} onAdd={() => setModal("addCourse")} onRemove={(c) => setModal({ removeCourse: c })} />
              : <StudentsTab batchId={id} onAdd={() => setModal("addStudent")} onRemove={(s) => setModal({ removeStudent: s })} />}
          </div>

          {modal === "edit" && <BatchFormDialog batch={b} onClose={() => setModal(null)} onSaved={() => done("Batch updated.")} />}
          {modal === "archive" && (
            <ConfirmDialog title={`Archive ${b.name}?`} confirmLabel="Archive" onClose={() => setModal(null)} formatError={lmsError}
              action={() => lmsApi.updateBatch(id, { archived: true })}
              onDone={() => { onNotice(`Batch ${b.name} archived.`); void refresh(); onBack(); }}>
              The batch leaves the list. Students keep their progress records.
            </ConfirmDialog>
          )}
          {modal === "delete" && (
            <ConfirmDialog title={`Delete ${b.name}?`} confirmLabel="Delete batch" danger onClose={() => setModal(null)} formatError={lmsError}
              action={() => lmsApi.deleteBatch(id)}
              onDone={() => { onNotice(`Batch ${b.name} deleted.`); void refresh(); onBack(); }}>
              This cannot be undone. A batch that already has student progress can't be deleted; archive it instead.
            </ConfirmDialog>
          )}
          {modal === "addCourse" && <AddCourseDialog assigned={b.courses.map((c) => c.id)} onClose={() => setModal(null)} onDone={(n) => done(`${n} ${n === 1 ? "course" : "courses"} added.`)} batchId={id} />}
          {modal === "addStudent" && <AddStudentDialog batchId={id} onClose={() => setModal(null)} onDone={(n) => done(`${n} ${n === 1 ? "student" : "students"} added.`)} />}
          {typeof modal === "object" && modal !== null && "removeCourse" in modal && (
            <ConfirmDialog title={`Remove ${modal.removeCourse.title} from this batch?`} confirmLabel="Remove course" danger onClose={() => setModal(null)} formatError={lmsError}
              action={() => lmsApi.setBatchCourses(id, b.courses.filter((c) => c.id !== modal.removeCourse.id).map((c) => c.id))}
              onDone={() => done("Course removed.")}>The course stays in the catalogue.</ConfirmDialog>
          )}
          {typeof modal === "object" && modal !== null && "removeStudent" in modal && (
            <ConfirmDialog title={`Remove ${modal.removeStudent.name} from this batch?`} confirmLabel="Remove student" danger onClose={() => setModal(null)} formatError={lmsError}
              action={() => lmsApi.removeStudent(id, modal.removeStudent.userId)}
              onDone={() => done("Student removed.")}>Their progress in this batch is removed with them.</ConfirmDialog>
          )}
        </>
      )}
    </>
  );
}

function Toggle({ open, onClick, controls, children }: { open: boolean; onClick: () => void; controls: string; children: React.ReactNode }) {
  return (
    <button type="button" className="lmstoggle" aria-expanded={open} aria-controls={controls} onClick={onClick}>
      {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}{children}
    </button>
  );
}

function CoursesTab({ courses, onAdd, onRemove }: { courses: BatchCourse[]; onAdd: () => void; onRemove: (c: BatchCourse) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card" aria-label="Assigned courses">
      <div className="rowactions" style={{ padding: 12, justifyContent: "flex-end" }}>
        <button type="button" className="btn primary sm" onClick={onAdd}>Add Course</button>
      </div>
      {courses.length === 0 ? <p className="empty">No courses assigned yet.</p> : (
        <ul className="lmslist">
          {courses.map((c) => (
            <li key={c.id}>
              <div className="lmsrow">
                <Toggle open={open === c.id} controls={`mods-${c.id}`} onClick={() => setOpen(open === c.id ? null : c.id)}>{c.title}</Toggle>
                <span className="muted">{c.moduleCount} {c.moduleCount === 1 ? "module" : "modules"} · {fmtMinutes(c.totalMinutes)}</span>
                <button type="button" className="btn sm danger" onClick={() => onRemove(c)} aria-label={`Remove course ${c.title}`}>Remove</button>
              </div>
              {open === c.id && <CourseModules id={`mods-${c.id}`} courseId={c.id} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CourseModules({ id, courseId }: { id: string; courseId: string }) {
  const q = useQuery({ queryKey: ["lms", "course", courseId], queryFn: () => lmsApi.course(courseId) });
  return (
    <div id={id} className="lmsnest">
      {q.isLoading ? <p className="muted" style={{ padding: 10 }}>Loading modules…</p> : q.error ? <p className="error" role="alert" style={{ padding: 10 }}>{lmsError(q.error)}</p> : (
        <ol className="lmslist">
          {q.data!.modules.map((m) => <li key={m.id} className="lmsrow"><span style={{ flex: 1 }}>{m.title}</span><span className="muted">{fmtMinutes(m.durationMinutes)}</span></li>)}
          {q.data!.modules.length === 0 && <li className="lmsrow muted">This course has no modules yet.</li>}
        </ol>
      )}
    </div>
  );
}

function StudentsTab({ batchId, onAdd, onRemove }: { batchId: string; onAdd: () => void; onRemove: (s: StudentProgress) => void }) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const sid = useId();
  useEffect(() => { const t = setTimeout(() => setSearch(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const q = useQuery({ queryKey: lmsKeys.students(batchId, search), queryFn: () => lmsApi.students(batchId, search) });
  const items = q.data?.items ?? [];
  return (
    <section className="card" aria-label="Students">
      <div className="toolbar" style={{ padding: 12, justifyContent: "space-between" }}>
        <div className="field inline">
          <label htmlFor={`${sid}-q`}>Search students</label>
          <input id={`${sid}-q`} type="search" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
        </div>
        <button type="button" className="btn primary sm" onClick={onAdd}>Add Student</button>
      </div>
      {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="empty error" role="alert">{lmsError(q.error)}</p> : items.length === 0 ? (
        <p className="empty">{search ? "No students match this search." : "No students enrolled yet."}</p>
      ) : (
        <ul className="lmslist">
          {items.map((s) => (
            <li key={s.userId}>
              <div className="lmsrow">
                <Toggle open={open === s.userId} controls={`st-${s.userId}`} onClick={() => setOpen(open === s.userId ? null : s.userId)}>
                  <span>{s.name}<small className="block muted" style={{ fontWeight: 400 }}>{s.email}</small></span>
                </Toggle>
                <ProgressBar percent={s.percent} label={`${s.name} overall progress`} />
                <button type="button" className="btn sm danger" onClick={() => onRemove(s)} aria-label={`Remove student ${s.name}`}>Remove</button>
              </div>
              {open === s.userId && (
                <div id={`st-${s.userId}`} className="lmsnest">
                  {s.courses.length === 0 && <p className="muted" style={{ padding: 10 }}>No courses assigned to this batch yet.</p>}
                  {s.courses.map((c) => <StudentCourse key={c.courseId} uid={s.userId} student={s.name} course={c} />)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StudentCourse({ uid, student, course }: { uid: string; student: string; course: CourseProgress }) {
  const [open, setOpen] = useState(false);
  const cid = `sc-${uid}-${course.courseId}`;
  return (
    <div>
      <div className="lmsrow">
        <Toggle open={open} controls={cid} onClick={() => setOpen(!open)}>{course.title}</Toggle>
        <ProgressBar percent={course.percent} label={`${student}, ${course.title} progress`} small />
      </div>
      {open && (
        <ul id={cid} className="lmslist lmsnest">
          {course.modules.map((m) => (
            <li key={m.moduleId} className="lmsrow">
              <span style={{ flex: "1 1 200px" }}>{m.title}<small className="block muted">{fmtMinutes(m.durationMinutes)}</small></span>
              <ProgressBar percent={m.percent} label={`${student}, ${m.title} progress`} small />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddCourseDialog({ batchId, assigned, onClose, onDone }: { batchId: string; assigned: string[]; onClose: () => void; onDone: (n: number) => void }) {
  const q = useQuery({ queryKey: lmsKeys.courses({}), queryFn: () => lmsApi.courses() });
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(lmsError);
  const avail = (q.data?.items ?? []).filter((c) => !c.archivedAt && !assigned.includes(c.id));
  return (
    <Dialog title="Add Course" onClose={onClose}>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        if (picked.length === 0) { setErr("Choose at least one course."); failed(); return; }
        setErr("");
        void submit.run(async () => { await lmsApi.setBatchCourses(batchId, [...assigned, ...picked]); onDone(picked.length); }).then(() => failed());
      }}>
        {q.isLoading ? <p className="muted">Loading courses…</p> : q.error ? <p className="error formerr" role="alert" tabIndex={-1}>{lmsError(q.error)}</p> : avail.length === 0 ? (
          <p className="dialogbody">Every active course is already in this batch. Create more under Courses.</p>
        ) : (
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="sr-only">Courses to add</legend>
            <ul className="lmspick">
              {avail.map((c) => (
                <li key={c.id}>
                  <label>
                    <input type="checkbox" checked={picked.includes(c.id)} data-autofocus={c === avail[0] ? true : undefined}
                      aria-invalid={err ? true : undefined}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                    <span>{c.title}<small className="block muted">{c.moduleCount} modules · {fmtMinutes(c.totalMinutes)}</small></span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        {err && <p className="error fielderr" role="alert">{err}</p>}
        <DialogActions onCancel={onClose} submitLabel="Add courses" busy={submit.busy} disabled={avail.length === 0} error={submit.error} />
      </form>
    </Dialog>
  );
}

function AddStudentDialog({ batchId, onClose, onDone }: { batchId: string; onClose: () => void; onDone: (n: number) => void }) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<Map<string, LookupUser>>(new Map());
  const [err, setErr] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(lmsError);
  const sid = useId();
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const q = useQuery({ queryKey: ["lms", "lookup", term], queryFn: () => lmsApi.lookupStudents(term), enabled: term.length >= 2 });
  const results = q.data?.items ?? [];
  return (
    <Dialog title="Add Student" onClose={onClose}>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        if (picked.size === 0) { setErr("Choose at least one student."); failed(); return; }
        setErr("");
        void submit.run(async () => { const r = await lmsApi.addStudents(batchId, [...picked.keys()]); onDone(r?.added ?? picked.size); }).then(() => failed());
      }}>
        <div className="field">
          <label htmlFor={`${sid}-q`}>Find people by name or email</label>
          <input id={`${sid}-q`} type="search" value={text} onChange={(e) => setText(e.target.value)} data-autofocus aria-invalid={err ? true : undefined} />
        </div>
        <p role="status" aria-live="polite" className="muted" style={{ marginBottom: 6 }}>
          {term.length < 2 ? "Type at least two letters." : q.isLoading ? "Searching…" : q.error ? lmsError(q.error) : `${results.length} ${results.length === 1 ? "person" : "people"} found.`}
        </p>
        {results.length > 0 && (
          <ul className="lmspick" aria-label="Search results">
            {results.map((u) => (
              <li key={u.userId}>
                <label>
                  <input type="checkbox" checked={picked.has(u.userId)} onChange={(e) => {
                    const m = new Map(picked);
                    if (e.target.checked) m.set(u.userId, u); else m.delete(u.userId);
                    setPicked(m);
                  }} />
                  <span>{u.name}<small className="block muted">{u.email}</small></span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {picked.size > 0 && (
          <ul className="chips" aria-label="Selected students" style={{ marginBottom: 12 }}>
            {[...picked.values()].map((u) => (
              <li key={u.userId} className="chip">{u.name}
                <button type="button" className="chipx" aria-label={`Unselect ${u.name}`} onClick={() => { const m = new Map(picked); m.delete(u.userId); setPicked(m); }}>×</button>
              </li>
            ))}
          </ul>
        )}
        {err && <p className="error fielderr" role="alert">{err}</p>}
        <DialogActions onCancel={onClose} submitLabel={`Add ${picked.size || ""} ${picked.size === 1 ? "student" : "students"}`.replace(/\s+/g, " ")} busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}
