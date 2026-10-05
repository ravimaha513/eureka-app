import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download, FolderOpen, FolderPlus, Globe, History, Lock, Search, Settings2, Shield, Trash2, Upload, Users, X, ScrollText,
} from "lucide-react";
import {
  DATAHUB_LEVELS, DATAHUB_LEVEL_LABELS, DOCUMENT_CONTENT_TYPES, ROLES, ROLE_LABELS, datahubFolderNameProblem,
  type DatahubLevel, type Role,
} from "@eureka/shared";
import { ConfirmDialog, Dialog, DialogActions } from "../admin/Dialog";
import { documentKeys, documentTypeOf, isStepUpRequired } from "../documents/documentsApi";
import { StepUpDialog } from "../documents/StepUpDialog";
import { useLookups } from "../lookups";
import { browser, fmtBytes } from "../sales/resumesApi";
import { Field, useFocusAfterFailure } from "../sales/ui";
import {
  datahubApi, datahubError, datahubFileProblem, datahubKeys, newIdempotencyKey, scanStatusText, storage,
  type FileItem, type Folder, type FolderInput, type Person, type Version,
} from "./datahubApi";

export const DATAHUB_POLL_MS = 3000;
const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const ACCEPT = [".pdf", ".docx", ".png", ".jpg", ".jpeg", ...Object.keys(DOCUMENT_CONTENT_TYPES)].join(",");
const LEVEL_ICONS = { internal: Globe, confidential: Lock, restricted: Shield } as const;
const levelOption = (l: DatahubLevel) => `${DATAHUB_LEVEL_LABELS[l].label} – ${DATAHUB_LEVEL_LABELS[l].audience}`;

/** Globe (Internal), lock (Confidential), shield (Restricted); the level name is announced. */
export function LevelIcon({ level, size = 16 }: { level: DatahubLevel; size?: number }) {
  const Icon = LEVEL_ICONS[level];
  return <span className={`dh-level dh-${level}`} title={DATAHUB_LEVEL_LABELS[level].label}>
    <Icon size={size} aria-hidden="true" /><span className="sr-only">{DATAHUB_LEVEL_LABELS[level].label}</span>
  </span>;
}

const StatusPill = ({ v }: { v: Pick<Version, "status"> }) => <span className={`badge resume-${v.status}`}>{scanStatusText(v)}</span>;

// ---------------------------------------------------------------- pickers

/** Searchable multi-select of catalog roles (Confidential folders). */
function RolePicker({ value, onChange, error }: { value: Role[]; onChange: (r: Role[]) => void; error?: string }) {
  const [q, setQ] = useState("");
  const listId = useId();
  const matches = ROLES.filter((r) => r !== "org_admin" && ROLE_LABELS[r].toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Field label="Role" error={error} hint="People holding any of these roles can open the folder.">
      {(p) => (
        <div className="dh-picker">
          {value.length > 0 && (
            <ul className="chips" aria-label="Chosen roles">
              {value.map((r) => (
                <li key={r} className="chip">{ROLE_LABELS[r]}
                  <button type="button" className="chipx" aria-label={`Remove ${ROLE_LABELS[r]}`} onClick={() => onChange(value.filter((x) => x !== r))}>×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="dh-searchbox"><Search size={15} aria-hidden="true" />
            <input {...p} type="search" placeholder="Eg. Employee, Manager…" value={q} onChange={(e) => setQ(e.target.value)} aria-controls={listId} autoComplete="off" />
          </div>
          <ul id={listId} className="dh-options" aria-label="Roles">
            {matches.map((r) => (
              <li key={r}><label className="check">
                <input type="checkbox" checked={value.includes(r)}
                  onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
                {ROLE_LABELS[r]}
              </label></li>
            ))}
            {matches.length === 0 && <li className="muted">No role matches.</li>}
          </ul>
        </div>
      )}
    </Field>
  );
}

/** Searchable people picker (active staff) for Restricted folders. */
function PeoplePicker({ value, onChange, label = "People", hint, error }: {
  value: Person[]; onChange: (p: Person[]) => void; label?: string; hint?: string; error?: string;
}) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  const people = useQuery({ queryKey: datahubKeys.people(term), queryFn: () => datahubApi.people(term) });
  const listId = useId();
  const chosen = new Set(value.map((p) => p.id));
  return (
    <Field label={label} error={error} hint={hint ?? "Only these people can open the folder."}>
      {(p) => (
        <div className="dh-picker">
          {value.length > 0 && (
            <ul className="chips" aria-label="Chosen people">
              {value.map((m) => (
                <li key={m.id} className="chip">{m.name}
                  <button type="button" className="chipx" aria-label={`Remove ${m.name}`} onClick={() => onChange(value.filter((x) => x.id !== m.id))}>×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="dh-searchbox"><Search size={15} aria-hidden="true" />
            <input {...p} type="search" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} aria-controls={listId} autoComplete="off" />
          </div>
          <ul id={listId} className="dh-options" aria-label="People">
            {(people.data?.items ?? []).filter((x) => !chosen.has(x.id)).map((x) => (
              <li key={x.id}><button type="button" className="linkish" onClick={() => onChange([...value, x])}>Add {x.name}</button></li>
            ))}
            {people.isLoading && <li className="muted">Loading…</li>}
            {people.data && people.data.items.length === 0 && <li className="muted">Nobody matches.</li>}
          </ul>
        </div>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------- folder dialog

/**
 * "Create New Folder" (reference dialog: Folder name, Security level, Role,
 * Description) and folder settings. Confidential asks for roles; Restricted
 * asks for people. A location is asked only when the caller manages folders
 * of a location, not organisation-wide.
 */
function FolderDialog({ folder, parent, createScope, onClose, onSaved }: {
  folder?: Folder; parent?: Folder | null; createScope: { org: boolean; locationIds: string[] };
  onClose: () => void; onSaved: (id: string) => void;
}) {
  const editing = folder !== undefined;
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const lookups = useLookups();
  const [name, setName] = useState(folder?.name ?? "");
  const [level, setLevel] = useState<DatahubLevel>(folder?.level ?? "internal");
  const [roles, setRoles] = useState<Role[]>(folder?.roleKeys ?? []);
  const [people, setPeople] = useState<Person[]>([]);
  const [description, setDescription] = useState(folder?.description ?? "");
  const [membersCanUpload, setMembersCanUpload] = useState(folder?.membersCanUpload ?? false);
  const needsLocation = !editing && !parent && !createScope.org;
  const [locationId, setLocationId] = useState(needsLocation && createScope.locationIds.length === 1 ? createScope.locationIds[0]! : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(newIdempotencyKey());
  const locations = (lookups.data?.locations ?? []).filter((l) => createScope.locationIds.includes(l.id));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    const errs: Record<string, string> = {};
    const nameProblem = datahubFolderNameProblem(trimmed);
    if (nameProblem) errs.name = nameProblem;
    if (level === "confidential" && roles.length === 0) errs.roles = "Choose at least one role.";
    if (description.trim().length > 500) errs.description = "Use at most 500 characters.";
    if (needsLocation && !locationId) errs.location = "Choose a location.";
    setErrors(errs);
    setError("");
    if (Object.keys(errs).length) { failed(); return; }
    setBusy(true);
    try {
      const body: FolderInput = {
        name: trimmed, level, description: description.trim() || null,
        ...(level === "confidential" ? { roleKeys: roles } : editing && folder.level === "confidential" ? { roleKeys: [] } : {}),
        ...(level === "restricted" && people.length ? { memberIds: people.map((p) => p.id) } : {}),
      };
      if (editing) {
        await datahubApi.updateFolder(folder.id, folder.rowVersion, { ...body, membersCanUpload });
        onSaved(folder.id);
      } else {
        const r = await datahubApi.createFolder({ ...body, parentId: parent?.id ?? null, ...(needsLocation ? { locationId } : {}) }, key.current);
        onSaved(r.id);
      }
    } catch (err) {
      setError(datahubError(err));
      failed();
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? "Folder settings" : parent ? `New subfolder in ${parent.name}` : "Create New Folder";
  return (
    <Dialog title={title} onClose={onClose}>
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="dh-form">
        <div className="grid2">
          <Field label="Folder name *" error={errors.name}>
            {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-autofocus placeholder="Eg. Java Resumes" />}
          </Field>
          <Field label="Security level" hint={DATAHUB_LEVEL_LABELS[level].help}>
            {(p) => (
              <select {...p} value={level} onChange={(e) => setLevel(e.target.value as DatahubLevel)}>
                {DATAHUB_LEVELS.map((l) => <option key={l} value={l}>{levelOption(l)}</option>)}
              </select>
            )}
          </Field>
        </div>
        {level === "confidential" && <RolePicker value={roles} onChange={setRoles} error={errors.roles} />}
        {level === "restricted" && (
          <PeoplePicker value={people} onChange={setPeople}
            label={editing && folder.level === "restricted" ? "Add people" : "People"}
            hint={editing && folder.level === "restricted" ? "Current members are managed under Members." : undefined} />
        )}
        {needsLocation && (
          <Field label="Location" error={errors.location} hint="You manage folders of this location.">
            {(p) => (
              <select {...p} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">Choose…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
          </Field>
        )}
        <Field label="Description (Optional)" error={errors.description}>
          {(p) => <textarea {...p} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Enter folder description" />}
        </Field>
        {editing && (
          <label className="check dh-check"><input type="checkbox" checked={membersCanUpload} onChange={(e) => setMembersCanUpload(e.target.checked)} />
            Members can upload</label>
        )}
        {editing && folder.level === "restricted" && level !== "restricted" && (
          <p className="note warn">Lowering the level removes the folder's member list.</p>
        )}
        <DialogActions onCancel={onClose} submitLabel={editing ? "Save" : "Create Folder"} busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- upload dialog

function UploadDialog({ folders, initialFolderId, onClose, onUploaded }: {
  folders: Folder[]; initialFolderId: string | null; onClose: () => void; onUploaded: (folderId: string, name: string, version: number) => void;
}) {
  const targets = folders.filter((f) => f.actions.upload);
  const [folderId, setFolderId] = useState(initialFolderId && targets.some((t) => t.id === initialFolderId) ? initialFolderId : targets[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const progressId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const p = !folderId ? "Choose a folder." : !file ? "Choose a file to upload." : datahubFileProblem(file);
    setProblem(p ?? "");
    if (p || !file) { failed(); return; }
    setProgress(0);
    try {
      const r = await datahubApi.requestUpload(folderId, file.name.trim(), documentTypeOf(file)!, file.size);
      await storage.post(r.upload, file, setProgress);
      setProgress(1);
      onUploaded(folderId, file.name.trim(), r.version);
    } catch (err) {
      setProgress(null);
      setError(datahubError(err));
      failed();
    }
  };

  return (
    <Dialog title="Upload a file" onClose={onClose}>
      {targets.length === 0 ? (
        <>
          <p className="muted">You can't upload to any folder. Folder managers can turn on "Members can upload".</p>
          <div className="actions"><button type="button" className="btn" onClick={onClose} data-autofocus>Close</button></div>
        </>
      ) : (
        <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate>
          <Field label="Folder">
            {(p) => (
              <select {...p} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                {targets.map((f) => <option key={f.id} value={f.id}>{f.name} ({DATAHUB_LEVEL_LABELS[f.level].label})</option>)}
              </select>
            )}
          </Field>
          <Field label="File" error={problem} hint="PDF, Word (.docx), PNG or JPEG, up to 15 MB. A file with the same name as an existing one becomes its next version.">
            {(p) => <input {...p} type="file" accept={ACCEPT} data-autofocus onChange={(e) => { setFile(e.target.files?.[0] ?? null); setProblem(""); }} />}
          </Field>
          {progress !== null && (
            <div className="dh-progress">
              <label htmlFor={progressId}>{progress < 1 ? "Uploading…" : "Uploaded. Scanning for malware…"}</label>
              <progress id={progressId} max={100} value={Math.round(progress * 100)}>{Math.round(progress * 100)}%</progress>
            </div>
          )}
          <DialogActions onCancel={onClose} submitLabel="Upload" busy={progress !== null && progress < 1} error={error} />
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- small dialogs

function VersionsDialog({ file, onClose, onDownload }: { file: FileItem; onClose: () => void; onDownload: (v: Version) => void }) {
  const q = useQuery({ queryKey: datahubKeys.versions(file.id), queryFn: () => datahubApi.versions(file.id) });
  return (
    <Dialog title={`Version history: ${file.name}`} onClose={onClose}>
      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error" role="alert">{datahubError(q.error)}</p>
        : (
          <div className="tablewrap"><table className="mini" aria-label="Versions, newest first">
            <thead><tr><th scope="col">Version</th><th scope="col">Uploaded</th><th scope="col">Size</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {q.data!.items.map((v) => (
                <tr key={v.id}>
                  <td>v{v.version}</td>
                  <td><time dateTime={v.createdAt}>{fmt(v.createdAt)}</time>{v.uploadedBy.name ? ` · ${v.uploadedBy.name}` : ""}</td>
                  <td>{fmtBytes(v.sizeBytes)}</td>
                  <td><StatusPill v={v} /></td>
                  <td>{v.status === "clean" && (
                    <button type="button" className="btn sm" onClick={() => onDownload(v)}>Download<span className="sr-only"> version {v.version}</span></button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      <div className="actions"><button type="button" className="btn" onClick={onClose} data-autofocus>Close</button></div>
    </Dialog>
  );
}

function MembersDialog({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: datahubKeys.members(folder.id), queryFn: () => datahubApi.members(folder.id) });
  const [error, setError] = useState("");
  const [adding, setAdding] = useState<Person[]>([]);
  const change = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: datahubKeys.members(folder.id) });
      await qc.invalidateQueries({ queryKey: datahubKeys.folders });
      await qc.invalidateQueries({ queryKey: datahubKeys.files(folder.id) });
    } catch (e) { setError(datahubError(e)); }
  };
  return (
    <Dialog title={`Members: ${folder.name}`} onClose={onClose}>
      <p className="muted">Only these people can open files in this restricted folder. Every download asks them to confirm it's them.</p>
      {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
      {q.isLoading ? <p className="muted">Loading…</p> : (
        <ul className="members" aria-label="Members">
          {(q.data?.items ?? []).map((m) => (
            <li key={m.id}>{m.name ?? m.id}
              <button type="button" className="btn sm danger" onClick={() => void change(() => datahubApi.removeMember(folder.id, m.id))}>
                Remove<span className="sr-only"> {m.name}</span></button>
            </li>
          ))}
          {q.data?.items.length === 0 && <li className="muted">No members yet.</li>}
        </ul>
      )}
      <PeoplePicker label="Add people" hint="Added at once; the change is audited." value={adding}
        onChange={(next) => {
          const added = next.filter((p) => !adding.some((a) => a.id === p.id));
          setAdding([]);
          for (const p of added) void change(() => datahubApi.addMember(folder.id, p.id));
        }} />
      <div className="actions"><button type="button" className="btn" onClick={onClose} data-autofocus>Close</button></div>
    </Dialog>
  );
}

function AccessLogDialog({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const q = useQuery({ queryKey: datahubKeys.log(folder.id), queryFn: () => datahubApi.accessLog(folder.id) });
  return (
    <Dialog title={`Access log: ${folder.name}`} onClose={onClose}>
      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error" role="alert">{datahubError(q.error)}</p>
        : !q.data?.items.length ? <p className="muted">Nobody has downloaded a file from this folder yet.</p>
        : (
          <div className="tablewrap"><table className="mini" aria-label="Access log, newest first">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">File</th><th scope="col">Confirmed</th></tr></thead>
            <tbody>
              {q.data.items.map((a) => (
                <tr key={a.id}>
                  <td><time dateTime={a.at}>{fmt(a.at)}</time></td>
                  <td>{a.user.name ?? a.user.id}</td>
                  <td>{a.fileName ?? "Hidden file"} · v{a.version}</td>
                  <td>{a.steppedUp ? "Signed in again" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      <div className="actions"><button type="button" className="btn" onClick={onClose} data-autofocus>Close</button></div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- page

type Modal =
  | { kind: "create"; parent: Folder | null }
  | { kind: "edit"; folder: Folder }
  | { kind: "upload" }
  | { kind: "versions"; file: FileItem }
  | { kind: "members"; folder: Folder }
  | { kind: "log"; folder: Folder }
  | { kind: "deleteFile"; file: FileItem }
  | { kind: "deleteFolder"; folder: Folder }
  | { kind: "stepUp"; versionId: string; label: string };

/**
 * DataHub (docs/datahub-api.md): organisation folders on the left, the
 * selected folder's files on the right; search across the folders the user
 * can read. Uploads go straight to storage and open after the malware scan;
 * files in Restricted folders open after "Confirm it's you" and every
 * download is in the folder's access log. Panels stack on phones.
 */
export function DataHubPage({ pollMs = DATAHUB_POLL_MS }: { pollMs?: number }) {
  const qc = useQueryClient();
  const folders = useQuery({ queryKey: datahubKeys.folders, queryFn: datahubApi.folders });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const watching = useRef(new Map<string, string>());
  const filesHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { const t = setTimeout(() => setTerm(query.trim()), 250); return () => clearTimeout(t); }, [query]);

  const items = folders.data?.items ?? [];
  const selected = items.find((f) => f.id === selectedId) ?? null;
  const tree = useMemo(() => {
    const ids = new Set(items.map((f) => f.id));
    const roots = items.filter((f) => !f.parentId || !ids.has(f.parentId));
    return roots.map((r) => ({ folder: r, children: items.filter((c) => c.parentId === r.id) }));
  }, [items]);

  const files = useQuery({
    queryKey: datahubKeys.files(selectedId ?? ""),
    queryFn: () => datahubApi.files(selectedId!),
    enabled: selected !== null && selected.actions.read,
    refetchInterval: (q) => (q.state.data?.items.some((f) => f.latestVersion.status === "pending") ? pollMs : false),
  });
  const search = useQuery({ queryKey: datahubKeys.search(term), queryFn: () => datahubApi.search(term), enabled: term.length > 0 });

  // Announce scan results of uploads made in this session.
  useEffect(() => {
    for (const f of files.data?.items ?? []) {
      const want = watching.current.get(f.id);
      if (!want || f.latestVersion.id !== want || f.latestVersion.status === "pending") continue;
      watching.current.delete(f.id);
      setMessage(f.latestVersion.status === "clean" ? `${f.name} is ready.` : `${f.name} was not accepted: ${scanStatusText(f.latestVersion)}.`);
    }
  }, [files.data]);

  // Back from Google: say so if the step-up did not go through.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("stepUp") === "failed") {
      setError("Could not confirm it's you, so restricted files stay closed. Try again.");
    }
  }, []);

  const select = (id: string) => {
    setSelectedId(id); setQuery(""); setTerm(""); setMessage(""); setError("");
    // On phones the file list is below the folders: bring it into view.
    requestAnimationFrame(() => filesHeading.current?.scrollIntoView?.({ block: "start" }));
  };
  const refresh = async (folderId?: string | null) => {
    await qc.invalidateQueries({ queryKey: datahubKeys.folders });
    if (folderId) await qc.invalidateQueries({ queryKey: datahubKeys.files(folderId) });
    await qc.invalidateQueries({ queryKey: ["datahub", "search"] });
  };

  const download = async (versionId: string, label: string) => {
    setMessage(""); setError(""); setBusy(versionId);
    try {
      const { url } = await datahubApi.downloadLink(versionId);
      browser.download(url);
      setMessage(`Downloading ${label}.`);
    } catch (e) {
      if (isStepUpRequired(e)) setModal({ kind: "stepUp", versionId, label });
      else setError(datahubError(e));
    } finally {
      setBusy(null);
    }
  };

  const createScope = folders.data?.createScope ?? { org: false, locationIds: [] };
  const canUploadSomewhere = items.some((f) => f.actions.upload);

  return (
    <div className="datahub">
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>DataHub</h1>
          <p className="sub">Secure document management and collaboration</p>
        </div>
        <div className="push dh-headactions">
          {folders.data?.canCreate && (
            <button type="button" className="btn dh-iconbtn" aria-label="New folder" title="New folder" onClick={() => setModal({ kind: "create", parent: null })}>
              <FolderPlus size={18} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="btn primary dh-iconbtn" aria-label="Upload" title="Upload" disabled={!canUploadSomewhere}
            onClick={() => setModal({ kind: "upload" })}>
            <Upload size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div role="search" aria-label="DataHub search" className="dh-search">
        <Search size={16} aria-hidden="true" />
        <input type="search" aria-label="Search documents" placeholder="Search documents…" value={query} maxLength={100}
          onChange={(e) => setQuery(e.target.value)} />
        {query && <button type="button" className="iconbtn" aria-label="Clear search" onClick={() => { setQuery(""); setTerm(""); }}><X size={16} aria-hidden="true" /></button>}
      </div>

      <p aria-live="polite" aria-atomic="true" className="livemsg">{message}</p>
      {error && <p className="banner error formerr" role="alert" tabIndex={-1}>{error}</p>}

      {term ? (
        <section className="card pad" aria-label="Search results">
          <h2>Results for “{term}”</h2>
          {search.isLoading ? <p className="muted">Searching…</p>
            : search.error ? <p className="error">{datahubError(search.error)}</p>
            : !search.data || (search.data.folders.length === 0 && search.data.files.length === 0) ? <p className="muted">Nothing matches in the folders you can open.</p>
            : (
              <>
                {search.data.folders.length > 0 && (
                  <ul className="dh-results" aria-label="Matching folders">
                    {search.data.folders.map((f) => (
                      <li key={f.id}><button type="button" className="linkish" onClick={() => select(f.id)}>
                        <LevelIcon level={f.level} /> {f.name}</button></li>
                    ))}
                  </ul>
                )}
                {search.data.files.length > 0 && (
                  <div className="tablewrap"><table aria-label="Matching files">
                    <thead><tr><th scope="col">Name</th><th scope="col">Folder</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {search.data.files.map((f) => (
                        <tr key={f.id}>
                          <td className="wrap">{f.name}</td>
                          <td><button type="button" className="linkish" onClick={() => select(f.folderId)}><LevelIcon level={f.level} /> {f.folderName}</button></td>
                          <td>v{f.latestVersion.version}</td>
                          <td><StatusPill v={f.latestVersion} /></td>
                          <td className="rowactions">{f.latestVersion.status === "clean" && (
                            <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void download(f.latestVersion.id, f.name)}>
                              <Download size={14} aria-hidden="true" /> Download<span className="sr-only"> {f.name}</span></button>
                          )}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
              </>
            )}
        </section>
      ) : (
        <div className="dh-layout">
          <section className="card dh-folders" aria-labelledby="dh-folders-h">
            <h2 id="dh-folders-h" className="dh-paneltitle">Folders</h2>
            {folders.isLoading ? <p className="muted">Loading…</p>
              : folders.error ? <p className="error">{datahubError(folders.error)}</p>
              : items.length === 0 ? (
                <div className="dh-empty"><FolderOpen size={28} aria-hidden="true" /><p>No folders yet</p></div>
              ) : (
                <ul className="dh-tree" aria-label="Folders">
                  {tree.map(({ folder, children }) => (
                    <li key={folder.id}>
                      <FolderButton folder={folder} current={folder.id === selectedId} onSelect={select} />
                      {children.length > 0 && (
                        <ul className="dh-sub">
                          {children.map((c) => <li key={c.id}><FolderButton folder={c} current={c.id === selectedId} onSelect={select} /></li>)}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section className="card dh-files" aria-labelledby="dh-files-h">
            {!selected ? (
              <>
                <h2 id="dh-files-h" ref={filesHeading} className="sr-only">Documents</h2>
                <div className="dh-empty"><FolderOpen size={36} aria-hidden="true" /><p>Select a folder to view documents</p></div>
              </>
            ) : (
              <>
                <div className="dh-folderhead">
                  <div className="dh-foldertitle">
                    <LevelIcon level={selected.level} size={18} />
                    <div>
                      <h2 id="dh-files-h" ref={filesHeading}>{selected.name}</h2>
                      <p className="muted">{levelOption(selected.level)}
                        {selected.level === "confidential" && ` · ${selected.roleKeys.map((r) => ROLE_LABELS[r] ?? r).join(", ")}`}
                        {selected.memberCount !== null && ` · ${selected.memberCount} ${selected.memberCount === 1 ? "member" : "members"}`}
                      </p>
                      {selected.description && <p className="dh-desc">{selected.description}</p>}
                    </div>
                  </div>
                  <div className="rowactions">
                    {selected.actions.upload && <button type="button" className="btn sm primary" onClick={() => setModal({ kind: "upload" })}><Upload size={14} aria-hidden="true" /> Upload to folder</button>}
                    {selected.actions.createSubfolder && <button type="button" className="btn sm" onClick={() => setModal({ kind: "create", parent: selected })}><FolderPlus size={14} aria-hidden="true" /> Subfolder</button>}
                    {selected.actions.manage && <button type="button" className="btn sm" onClick={() => setModal({ kind: "edit", folder: selected })}><Settings2 size={14} aria-hidden="true" /> Settings</button>}
                    {selected.actions.manage && selected.level === "restricted" && <button type="button" className="btn sm" onClick={() => setModal({ kind: "members", folder: selected })}><Users size={14} aria-hidden="true" /> Members</button>}
                    {selected.actions.manage && <button type="button" className="btn sm" onClick={() => setModal({ kind: "log", folder: selected })}><ScrollText size={14} aria-hidden="true" /> Access log</button>}
                    {selected.actions.manage && <button type="button" className="btn sm danger" onClick={() => setModal({ kind: "deleteFolder", folder: selected })}><Trash2 size={14} aria-hidden="true" /> Delete folder</button>}
                  </div>
                </div>
                {!selected.actions.read ? (
                  <p className="note warn">You manage this restricted folder but aren't one of its members, so its files are hidden. Add yourself under Members to see them (the change is audited).</p>
                ) : files.isLoading ? <p className="muted">Loading…</p>
                  : files.error ? <p className="error">{datahubError(files.error)}</p>
                  : !files.data?.items.length ? <div className="dh-empty"><p>No documents in this folder yet.</p></div>
                  : (
                    <div className="tablewrap"><table aria-label={`Files in ${selected.name}`}>
                      <thead><tr>
                        <th scope="col">Name</th><th scope="col">Version</th><th scope="col">Size</th><th scope="col">Uploaded by</th>
                        <th scope="col">Date</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th>
                      </tr></thead>
                      <tbody>
                        {files.data.items.map((f) => (
                          <tr key={f.id}>
                            <td className="wrap dh-name">{f.name}</td>
                            <td>v{f.latestVersion.version}</td>
                            <td>{fmtBytes(f.latestVersion.sizeBytes)}</td>
                            <td>{f.latestVersion.uploadedBy.name ?? "—"}</td>
                            <td><time dateTime={f.latestVersion.createdAt}>{fmt(f.latestVersion.createdAt)}</time></td>
                            <td><StatusPill v={f.latestVersion} /></td>
                            <td className="rowactions">
                              <button type="button" className="iconbtn" aria-label={`Download ${f.name}`} title="Download"
                                disabled={!f.actions.download || busy !== null} onClick={() => void download(f.latestVersion.id, f.name)}>
                                <Download size={16} aria-hidden="true" />
                              </button>
                              <button type="button" className="iconbtn" aria-label={`Version history of ${f.name}`} title="Version history"
                                onClick={() => setModal({ kind: "versions", file: f })}>
                                <History size={16} aria-hidden="true" />
                              </button>
                              {f.actions.delete && (
                                <button type="button" className="iconbtn" aria-label={`Delete ${f.name}`} title="Delete" onClick={() => setModal({ kind: "deleteFile", file: f })}>
                                  <Trash2 size={16} aria-hidden="true" />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  )}
              </>
            )}
          </section>
        </div>
      )}

      {(modal?.kind === "create" || modal?.kind === "edit") && (
        <FolderDialog folder={modal.kind === "edit" ? modal.folder : undefined} parent={modal.kind === "create" ? modal.parent : null}
          createScope={createScope} onClose={() => setModal(null)}
          onSaved={(id) => { setModal(null); void refresh(id); setSelectedId(id); setMessage(modal.kind === "edit" ? "Folder settings saved." : "Folder created."); }} />
      )}
      {modal?.kind === "upload" && (
        <UploadDialog folders={items} initialFolderId={selectedId} onClose={() => setModal(null)}
          onUploaded={(folderId, name, version) => {
            setModal(null);
            setSelectedId(folderId);
            setMessage(`Uploaded ${name}${version > 1 ? ` as version ${version}` : ""}. Scanning for malware; it opens once the scan passes.`);
            void (async () => {
              await refresh(folderId);
              const list = qc.getQueryData<{ items: FileItem[] }>(datahubKeys.files(folderId));
              const f = list?.items.find((x) => x.name.toLowerCase() === name.toLowerCase());
              if (f) watching.current.set(f.id, f.latestVersion.id);
            })();
          }} />
      )}
      {modal?.kind === "versions" && (
        <VersionsDialog file={modal.file} onClose={() => setModal(null)}
          onDownload={(v) => { const label = `${modal.file.name} (version ${v.version})`; setModal(null); void download(v.id, label); }} />
      )}
      {modal?.kind === "members" && <MembersDialog folder={modal.folder} onClose={() => setModal(null)} />}
      {modal?.kind === "log" && <AccessLogDialog folder={modal.folder} onClose={() => setModal(null)} />}
      {modal?.kind === "deleteFile" && (
        <ConfirmDialog title={`Delete ${modal.file.name}?`} confirmLabel="Delete" danger formatError={datahubError}
          action={() => datahubApi.deleteFile(modal.file.id)} onClose={() => setModal(null)}
          onDone={() => { const f = modal.file; setModal(null); setMessage(`${f.name} deleted.`); void refresh(f.folderId); }}>
          <p>All {modal.file.versionCount} {modal.file.versionCount === 1 ? "version" : "versions"} will be removed from the folder.</p>
        </ConfirmDialog>
      )}
      {modal?.kind === "deleteFolder" && (
        <ConfirmDialog title={`Delete ${modal.folder.name}?`} confirmLabel="Delete folder" danger formatError={datahubError}
          action={() => datahubApi.deleteFolder(modal.folder.id, modal.folder.rowVersion)} onClose={() => setModal(null)}
          onDone={() => { setModal(null); setSelectedId(null); setMessage("Folder deleted."); void refresh(); }}>
          <p>Only an empty folder can be deleted.</p>
        </ConfirmDialog>
      )}
      {modal?.kind === "stepUp" && (
        <StepUpDialog message="This file is in a restricted folder." onClose={() => setModal(null)}
          onConfirmed={() => {
            const { versionId, label } = modal;
            setModal(null);
            void qc.invalidateQueries({ queryKey: documentKeys.stepUp });
            void download(versionId, label).then(() => qc.invalidateQueries({ queryKey: ["datahub", "log"] }));
          }} />
      )}
    </div>
  );
}

function FolderButton({ folder, current, onSelect }: { folder: Folder; current: boolean; onSelect: (id: string) => void }) {
  return (
    <button type="button" className="dh-folder" aria-current={current ? "true" : undefined} onClick={() => onSelect(folder.id)}>
      <LevelIcon level={folder.level} />
      <span className="dh-foldername">{folder.name}</span>
      {folder.actions.read && <span className="dh-count" aria-label={`${folder.fileCount} files`}>{folder.fileCount}</span>}
    </button>
  );
}
