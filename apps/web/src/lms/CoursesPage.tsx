import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { DialogActions, useSubmit } from "../admin/Dialog";
import { Drawer, Field, useFocusAfterFailure } from "../sales/ui";
import { fmtMinutes, lmsApi, lmsError, lmsKeys, type CourseSummary } from "./lmsApi";

interface ModuleDraft { key: number; id?: string; title: string; minutes: string }

/** Courses: catalogue list with a create/edit drawer holding the ordered modules. */
export function CoursesPage() {
  const qc = useQueryClient();
  const sid = useId();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<CourseSummary | "new" | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => { const t = setTimeout(() => setSearch(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const filters = { q: search, archived };
  const q = useQuery({ queryKey: lmsKeys.courses(filters), queryFn: () => lmsApi.courses(filters) });
  const items = q.data?.items ?? [];

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Courses</h1>
          <p className="sub">The course catalogue. A course is an ordered list of modules; assign courses to training batches.</p>
        </div>
        <button type="button" className="btn primary" style={{ marginLeft: "auto" }} onClick={() => setEditing("new")}>Add Course</button>
      </div>
      <form className="toolbar" role="search" aria-label="Course filters" onSubmit={(e) => e.preventDefault()}>
        <div className="field inline">
          <label htmlFor={`${sid}-q`}>Search courses</label>
          <input id={`${sid}-q`} type="search" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
        </div>
        <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
      </form>
      <p role="status" aria-live="polite" className="livemsg">{notice}</p>
      <div className="card tablewrap">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
          <p className="empty error" role="alert">{lmsError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
        ) : (
          <table aria-label="Courses">
            <thead><tr><th>Course</th><th>Modules</th><th>Duration</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.title}</b>{c.description && <span className="block muted">{c.description.length > 90 ? `${c.description.slice(0, 90)}…` : c.description}</span>}</td>
                  <td>{c.moduleCount}</td>
                  <td>{fmtMinutes(c.totalMinutes)}</td>
                  <td>{c.archivedAt ? <span className="badge">Archived</span> : <span className="badge active">Active</span>}</td>
                  <td className="rowactions"><button type="button" className="btn sm" aria-label={`Edit course ${c.title}`} onClick={() => setEditing(c)}>Edit</button></td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={5} className="empty">{search ? "No courses match this search." : "No courses yet. Add the first one."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <CourseDrawer course={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => {
          setEditing(null); setNotice(m); void qc.invalidateQueries({ queryKey: lmsKeys.all });
        }} />
      )}
    </>
  );
}

let keySeq = 0;
const blank = (): ModuleDraft => ({ key: ++keySeq, title: "", minutes: "30" });

function CourseDrawer({ course, onClose, onSaved }: { course: CourseSummary | null; onClose: () => void; onSaved: (m: string) => void }) {
  const detail = useQuery({ queryKey: ["lms", "course", course?.id], queryFn: () => lmsApi.course(course!.id), enabled: course !== null });
  const [title, setTitle] = useState(course?.title ?? "");
  const [description, setDescription] = useState(course?.description ?? "");
  const [mods, setMods] = useState<ModuleDraft[]>([]);
  const [loaded, setLoaded] = useState(course === null);
  const [errs, setErrs] = useState<{ title?: string; mods: Record<number, string> }>({ mods: {} });
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(lmsError);
  useEffect(() => {
    if (loaded || !detail.data) return;
    setTitle(detail.data.title); setDescription(detail.data.description);
    setMods([...detail.data.modules].sort((a, b) => a.position - b.position).map((m) => ({ key: ++keySeq, id: m.id, title: m.title, minutes: String(m.durationMinutes) })));
    setLoaded(true);
  }, [detail.data, loaded]);

  const move = (i: number, d: number) => setMods((m) => {
    const n = [...m]; const j = i + d;
    if (j < 0 || j >= n.length) return m;
    [n[i], n[j]] = [n[j]!, n[i]!]; return n;
  });
  const patch = (key: number, p: Partial<ModuleDraft>) => setMods((m) => m.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const save = () => {
    const e: typeof errs = { mods: {} };
    const t = title.trim();
    if (!t) e.title = "Enter a course title."; else if (t.length > 160) e.title = "Use 160 characters or fewer.";
    if (description.length > 2000) e.title ??= "The description is too long (2000 characters at most).";
    for (const m of mods) {
      const n = Number(m.minutes);
      if (!m.title.trim()) e.mods[m.key] = "Enter a module title.";
      else if (m.minutes.trim() === "" || !Number.isInteger(n) || n < 0 || n > 6000) e.mods[m.key] = "Minutes must be a whole number from 0 to 6000.";
    }
    setErrs(e);
    if (e.title || Object.keys(e.mods).length) { failed(); return; }
    void submit.run(async () => {
      const list = mods.map((m) => ({ ...(m.id ? { id: m.id } : {}), title: m.title.trim(), durationMinutes: Number(m.minutes) }));
      if (course) {
        if (t !== course.title || description !== course.description) await lmsApi.updateCourse(course.id, { title: t, description }, course.version);
        await lmsApi.setModules(course.id, list);
        onSaved(`Course ${t} saved.`);
      } else {
        const c = await lmsApi.createCourse({ title: t, ...(description ? { description } : {}) });
        if (list.length) await lmsApi.setModules(c.id, list);
        onSaved(`Course ${t} created.`);
      }
    }).then(() => failed());
  };

  return (
    <Drawer title={course ? "Edit course" : "Add course"} onClose={onClose} wide closeLabel="Close course editor">
      {!loaded ? (detail.error ? <p className="error" role="alert">{lmsError(detail.error)}</p> : <p className="empty">Loading…</p>) : (
        <form ref={form} noValidate onSubmit={(ev) => { ev.preventDefault(); save(); }}>
          <Field label="Title" error={errs.title}>{(p) => <input {...p} value={title} maxLength={170} onChange={(e) => setTitle(e.target.value)} data-autofocus />}</Field>
          <div className="field">
            <label htmlFor="lms-desc">Description</label>
            <textarea id="lms-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend style={{ fontWeight: 600, marginBottom: 8 }}>Modules (in order)</legend>
            {mods.length === 0 && <p className="muted" style={{ marginBottom: 8 }}>No modules yet.</p>}
            {mods.map((m, i) => (
              <div key={m.key} role="group" aria-label={`Module ${i + 1}`}>
                <div className="modrow">
                  <Field label={`Module ${i + 1} title`} error={errs.mods[m.key]}>
                    {(p) => <input {...p} value={m.title} maxLength={160} onChange={(e) => patch(m.key, { title: e.target.value })} />}
                  </Field>
                  <div className="field">
                    <label htmlFor={`lms-min-${m.key}`}>Minutes</label>
                    <input id={`lms-min-${m.key}`} inputMode="numeric" value={m.minutes} aria-label={`Module ${i + 1} minutes`} onChange={(e) => patch(m.key, { minutes: e.target.value })} />
                  </div>
                  <div className="rowactions">
                    <button type="button" className="iconbtn" aria-label={`Move module ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={16} aria-hidden="true" /></button>
                    <button type="button" className="iconbtn" aria-label={`Move module ${i + 1} down`} disabled={i === mods.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} aria-hidden="true" /></button>
                    <button type="button" className="iconbtn" aria-label={`Remove module ${i + 1}`} onClick={() => setMods((x) => x.filter((y) => y.key !== m.key))}><Trash2 size={16} aria-hidden="true" /></button>
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="btn sm" onClick={() => setMods((m) => [...m, blank()])}>Add module</button>
          </fieldset>
          {course && (
            <div className="manageblock" style={{ marginTop: 12 }}>
              <h3>{course.archivedAt ? "Archived course" : "Archive"}</h3>
              <button type="button" className="btn sm" disabled={submit.busy} onClick={() => void submit.run(async () => {
                await lmsApi.updateCourse(course.id, { archived: !course.archivedAt }, course.version);
                onSaved(course.archivedAt ? `Course ${course.title} restored.` : `Course ${course.title} archived.`);
              })}>{course.archivedAt ? "Restore course" : "Archive course"}</button>
            </div>
          )}
          <DialogActions onCancel={onClose} submitLabel="Save course" busy={submit.busy} error={submit.error} />
        </form>
      )}
    </Drawer>
  );
}
