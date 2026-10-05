import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import type { Me } from "../api";
import { ConfirmDialog, Dialog, DialogActions } from "../admin/Dialog";
import { useLookups } from "../lookups";
import { Drawer, Field, useFocusAfterFailure } from "../sales/ui";
import { fieldErrors } from "../sales/errors";
import {
  fmtMinutes, trainingApi, trainingError, trainingKeys, type Cover, type CourseDetail, type CourseModule,
} from "./trainingApi";
import { CoverArt, CoverPicker } from "./ui";

/** Course library (docs/training-api.md TR-4): org catalog; managers of the owning location edit. */
export function CoursesPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const id = useId();
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const q = useQuery({ queryKey: trainingKeys.courses(archived), queryFn: () => trainingApi.courses(archived) });
  const items = q.data?.items ?? [];
  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Courses</h1>
          <p className="sub">The course library: ordered modules with durations. Assign courses to batches from a batch.</p>
        </div>
        <div className="toolbar push">
          <label className="check" htmlFor={`${id}-a`}>
            <input id={`${id}-a`} type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
          </label>
          {q.data?.canCreate && <button type="button" className="btn primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />Add course</button>}
        </div>
      </div>
      <p role="status" aria-live="polite" className="livemsg">{notice}</p>
      {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="empty error" role="alert">{trainingError(q.error)}</p>
        : items.length === 0 ? <div className="card"><p className="empty">No courses yet.</p></div> : (
          <ul className="tr-grid" aria-label="Courses">
            {items.map((c) => (
              <li key={c.id} className="card tr-card">
                <CoverArt cover={c.cover} caption="Course" />
                <h2 className="tr-title">{c.title}</h2>
                <div>{c.archived && <span className="badge tr-cancelled">Archived</span>} <span className="muted">{c.location.name}</span></div>
                <div className="tr-meta">
                  <span><b>{c.modules}</b><small>Modules</small></span>
                  <span><b>{fmtMinutes(c.totalMinutes)}</b><small>Duration</small></span>
                  <span><b>{c.batches}</b><small>Batches</small></span>
                </div>
                <div className="tr-foot">
                  <span />
                  <button type="button" className="btn sm" aria-label={`Open course ${c.title}`} onClick={() => setOpenId(c.id)}>Open</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      {creating && <CourseDialog me={me} onClose={() => setCreating(false)} onSaved={(cid) => {
        setCreating(false); setNotice("Course created."); void qc.invalidateQueries({ queryKey: trainingKeys.all }); setOpenId(cid);
      }} />}
      {openId && <CourseDrawer id={openId} onClose={() => setOpenId(null)} onNotice={setNotice}
        onDeleted={(t) => { setOpenId(null); setNotice(`${t} deleted.`); }} />}
    </>
  );
}

function CourseDialog({ me, course, onClose, onSaved }: { me?: Me; course?: CourseDetail; onClose: () => void; onSaved: (id: string) => void }) {
  const lookups = useLookups();
  const mine = new Set((me?.roles ?? []).map((r) => r.locationId).filter(Boolean));
  const locations = (lookups.data?.locations ?? []).filter((l) => mine.size === 0 || mine.has(l.id));
  const [title, setTitle] = useState(course?.title ?? "");
  const [description, setDescription] = useState(course?.description ?? "");
  const [locationId, setLocationId] = useState("");
  const [cover, setCover] = useState<Cover>(course?.cover ?? { color: "indigo", icon: "book" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  return (
    <Dialog title={course ? `Edit ${course.title}` : "Add course"} onClose={onClose}>
      <form ref={form} noValidate onSubmit={async (e) => {
        e.preventDefault();
        const err: Record<string, string> = {};
        if (!title.trim()) err.title = "Enter a title.";
        if (!course && locations.length > 1 && !locationId) err.locationId = "Choose the location that owns the course.";
        setErrors(err); setFormError("");
        if (Object.keys(err).length) { failed(); return; }
        setBusy(true);
        try {
          const body = { title: title.trim(), description: description.trim() || null, coverColor: cover.color, coverIcon: cover.icon };
          if (course) { await trainingApi.updateCourse(course.id, course.rowVersion, body); onSaved(course.id); }
          else onSaved((await trainingApi.createCourse({ ...body, ...(locationId ? { locationId } : {}) })).id);
        } catch (x) {
          const { _form, ...f } = fieldErrors(x, ["title", "description", "locationId"]);
          setErrors(f); setFormError(_form ?? trainingError(x)); failed();
        } finally { setBusy(false); }
      }}>
        <Field label="Title" error={errors.title}>
          {(p) => <input {...p} data-autofocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Description (optional)" error={errors.description}>
          {(p) => <textarea {...p} rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        {!course && locations.length > 1 && (
          <Field label="Owning location" error={errors.locationId} hint="Training managers of this location can edit the course.">
            {(p) => (
              <select {...p} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="" disabled>Choose…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
          </Field>
        )}
        <CoverPicker value={cover} onChange={setCover} />
        <DialogActions onCancel={onClose} submitLabel={course ? "Save" : "Create course"} busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}

function CourseDrawer({ id, onClose, onNotice, onDeleted }: {
  id: string; onClose: () => void; onNotice: (s: string) => void; onDeleted: (title: string) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: trainingKeys.course(id), queryFn: () => trainingApi.course(id) });
  const [editing, setEditing] = useState(false);
  const [moduleEdit, setModuleEdit] = useState<CourseModule | "new" | null>(null);
  const [removing, setRemoving] = useState<CourseModule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: trainingKeys.all });
  const c = q.data;
  const dialogOpen = editing || moduleEdit !== null || removing !== null || deleting;
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setError("");
    try { await fn(); onNotice(msg); await refresh(); } catch (e) { setError(trainingError(e)); }
  };
  return (
    <>
    <Drawer title={c ? c.title : "Course"} onClose={onClose} suspended={dialogOpen} wide closeLabel="Close course">
      {q.isLoading ? <p className="empty">Loading…</p> : !c ? <p className="empty error" role="alert">{trainingError(q.error)}</p> : (
        <div className="tr-drawer">
          <div className="tr-coursehead">
            <CoverArt cover={c.cover} size="sm" />
            <div>
              <p className="muted">{c.location.name} · {c.modules.length} modules · {fmtMinutes(c.totalMinutes)}{c.archived ? " · Archived" : ""}</p>
              {c.description && <p className="tr-desc">{c.description}</p>}
            </div>
          </div>
          {error && <p className="banner error" role="alert">{error}</p>}
          {c.canEdit && (
            <div className="rowactions">
              <button type="button" className="btn sm" onClick={() => setEditing(true)}><Pencil size={14} aria-hidden="true" />Edit course</button>
              <button type="button" className="btn sm" onClick={() => void run(() => trainingApi.updateCourse(c.id, c.rowVersion, { archived: !c.archived }),
                c.archived ? `${c.title} restored.` : `${c.title} archived.`)}>{c.archived ? "Restore" : "Archive"}</button>
              <button type="button" className="btn sm danger" onClick={() => setDeleting(true)}><Trash2 size={14} aria-hidden="true" />Delete</button>
            </div>
          )}
          <div className="pagehead">
            <h3>Modules</h3>
            {c.canEdit && <button type="button" className="btn sm push" onClick={() => setModuleEdit("new")}><Plus size={14} aria-hidden="true" />Add module</button>}
          </div>
          {c.modules.length === 0 ? <p className="muted">No modules yet.</p> : (
            <ol className="tr-modules editable">
              {c.modules.map((m, i) => (
                <li key={m.id}>
                  <span><b>{m.title}</b> <span className="muted">{fmtMinutes(m.durationMinutes)}{m.resources.length ? ` · ${m.resources.length} links` : ""}</span></span>
                  {c.canEdit && (
                    <span className="rowactions">
                      <button type="button" className="iconbtn" aria-label={`Move ${m.title} up`} disabled={i === 0}
                        onClick={() => { const ids = c.modules.map((x) => x.id); [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!]; void run(() => trainingApi.reorderModules(c.id, ids), `${m.title} moved up.`); }}>
                        <ChevronUp size={16} aria-hidden="true" /></button>
                      <button type="button" className="iconbtn" aria-label={`Move ${m.title} down`} disabled={i === c.modules.length - 1}
                        onClick={() => { const ids = c.modules.map((x) => x.id); [ids[i + 1], ids[i]] = [ids[i]!, ids[i + 1]!]; void run(() => trainingApi.reorderModules(c.id, ids), `${m.title} moved down.`); }}>
                        <ChevronDown size={16} aria-hidden="true" /></button>
                      <button type="button" className="iconbtn" aria-label={`Edit ${m.title}`} onClick={() => setModuleEdit(m)}><Pencil size={16} aria-hidden="true" /></button>
                      <button type="button" className="iconbtn" aria-label={`Delete ${m.title}`} onClick={() => setRemoving(m)}><Trash2 size={16} aria-hidden="true" /></button>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Drawer>
      {c && editing && <CourseDialog course={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onNotice("Course saved."); void refresh(); }} />}
      {c && moduleEdit && <ModuleDialog course={c} module={moduleEdit === "new" ? undefined : moduleEdit} onClose={() => setModuleEdit(null)}
        onSaved={(t) => { setModuleEdit(null); onNotice(`${t} saved.`); void refresh(); }} />}
      {c && removing && (
        <ConfirmDialog title={`Delete ${removing.title}?`} confirmLabel="Delete module" danger formatError={trainingError}
          action={() => trainingApi.deleteModule(c.id, removing.id)} onClose={() => setRemoving(null)}
          onDone={() => { onNotice(`${removing.title} deleted.`); setRemoving(null); void refresh(); }}>
          <p>Modules that students have completed can't be deleted.</p>
        </ConfirmDialog>
      )}
      {c && deleting && (
        <ConfirmDialog title={`Delete ${c.title}?`} confirmLabel="Delete course" danger formatError={trainingError}
          action={() => trainingApi.deleteCourse(c.id)} onClose={() => setDeleting(false)}
          onDone={() => { setDeleting(false); void refresh(); onDeleted(c.title); }}>
          <p>Only a course that no batch uses can be deleted; archive it otherwise.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function ModuleDialog({ course, module, onClose, onSaved }: {
  course: CourseDetail; module?: CourseModule; onClose: () => void; onSaved: (title: string) => void;
}) {
  const [title, setTitle] = useState(module?.title ?? "");
  const [minutes, setMinutes] = useState(module ? String(module.durationMinutes) : "");
  const [links, setLinks] = useState((module?.resources ?? []).join("\n"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  return (
    <Dialog title={module ? `Edit ${module.title}` : "Add module"} onClose={onClose}>
      <form ref={form} noValidate onSubmit={async (e) => {
        e.preventDefault();
        const err: Record<string, string> = {};
        const n = Number(minutes);
        const resources = links.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        if (!title.trim()) err.title = "Enter a title.";
        if (!(Number.isInteger(n) && n >= 1 && n <= 10000)) err.durationMinutes = "Use whole minutes from 1 to 10000.";
        if (resources.length > 10) err.resources = "Add at most 10 links.";
        else if (resources.some((u) => !/^https:\/\/\S+$/.test(u))) err.resources = "Each link must start with https://.";
        setErrors(err); setFormError("");
        if (Object.keys(err).length) { failed(); return; }
        setBusy(true);
        try {
          const body = { title: title.trim(), durationMinutes: n, resources };
          if (module) await trainingApi.updateModule(course.id, module.id, module.rowVersion, body);
          else await trainingApi.addModule(course.id, body);
          onSaved(body.title);
        } catch (x) {
          const { _form, ...f } = fieldErrors(x, ["title", "durationMinutes", "resources"]);
          setErrors(f); setFormError(_form ?? trainingError(x)); failed();
        } finally { setBusy(false); }
      }}>
        <Field label="Module title" error={errors.title}>
          {(p) => <input {...p} data-autofocus value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Duration (minutes)" error={errors.durationMinutes}>
          {(p) => <input {...p} type="number" min={1} max={10000} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />}
        </Field>
        <Field label="Resource links (optional)" error={errors.resources} hint="One https:// link per line, up to 10.">
          {(p) => <textarea {...p} rows={3} value={links} onChange={(e) => setLinks(e.target.value)} spellCheck={false} />}
        </Field>
        <DialogActions onCancel={onClose} submitLabel={module ? "Save" : "Add module"} busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
