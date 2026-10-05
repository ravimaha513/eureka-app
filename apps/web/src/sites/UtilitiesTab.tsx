import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, KeyRound, Link2, Pencil, Plus, UserRound, Hash, Building } from "lucide-react";
import { Dialog, useSubmit } from "../admin/Dialog";
import { StepUpDialog } from "../documents/StepUpDialog";
import { documentKeys, isStepUpRequired } from "../documents/documentsApi";
import { Field, useFocusAfterFailure } from "../sales/ui";
import {
  UTILITY_LABELS, UTILITY_TYPES, siteKeys, sitesApi, sitesError, utilityLabel,
  type SiteKind, type SiteStatus, type Utility, type UtilityType,
} from "./sitesApi";
import { IconInput, Layer, StatusPill } from "./ui";

/** A revealed password is hidden again after this long. */
export const PASSWORD_VISIBLE_MS = 30_000;

/** Clipboard hook the tests replace. */
export const clipboard = {
  write: (text: string) => (navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error("Copy is not available in this browser."))),
  /** Empties the clipboard if it still holds `text` (skipped silently when the browser will not let us read it). */
  clearIf: async (text: string) => {
    try { if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText(""); } catch { /* not allowed: leave it */ }
  },
};

/**
 * Utilities of a company or facility. The portal password is never listed: "Reveal"
 * asks the server (audited, needs utility.secret:read and a fresh "Confirm it's you"),
 * shows it for 30 seconds with a copy button, then hides it.
 */
export function UtilitiesTab({ kind, ownerId, canManage, canReveal }: { kind: SiteKind; ownerId: string; canManage: boolean; canReveal: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: siteKeys.utilities(kind, ownerId), queryFn: () => sitesApi.utilities(kind, ownerId) });
  const [editing, setEditing] = useState<Utility | "new" | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; password: string } | null>(null);
  const [stepUpFor, setStepUpFor] = useState<Utility | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setRevealed(null);
  };

  const reveal = async (u: Utility) => {
    setError(""); setMessage(""); setBusy(u.id);
    try {
      const { password } = await sitesApi.revealPassword(u.id);
      if (timer.current) clearTimeout(timer.current);
      setRevealed({ id: u.id, password });
      timer.current = setTimeout(hide, PASSWORD_VISIBLE_MS);
      setMessage(`${utilityLabel(u.utilityType)} password shown. It hides again in 30 seconds.`);
    } catch (err) {
      if (isStepUpRequired(err)) setStepUpFor(u);
      else setError(sitesError(err, "utility"));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (u: Utility, password: string) => {
    try {
      await clipboard.write(password);
      setTimeout(() => void clipboard.clearIf(password), PASSWORD_VISIBLE_MS);
      setMessage(`${utilityLabel(u.utilityType)} password copied. The clipboard is cleared in 30 seconds.`);
    }
    catch (err) { setError(err instanceof Error ? err.message : "Could not copy."); }
  };

  const items = q.data?.items ?? [];
  return (
    <div className="tabpanel">
      <div className="panelhead">
        <h3>Utilities</h3>
        {canManage && (
          <button type="button" className="btn primary sm" onClick={() => setEditing("new")}><Plus size={15} aria-hidden="true" />Add utility</button>
        )}
      </div>
      <p aria-live="polite" aria-atomic="true" className="livemsg">{message}</p>
      {error && <p className="banner error formerr" role="alert" tabIndex={-1}>{error}</p>}
      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error" role="alert">{sitesError(q.error, "utility")}</p>
        : items.length === 0 ? <p className="muted">No utilities yet.</p>
        : (
          <div className="tablewrap roundtable"><table aria-label="Utilities">
            <thead><tr>
              <th scope="col">Utility</th><th scope="col">Account</th><th scope="col">Username</th><th scope="col">Password</th>
              <th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((u) => {
                const label = utilityLabel(u.utilityType);
                const shown = revealed?.id === u.id ? revealed.password : null;
                return (
                  <tr key={u.id}>
                    <td>
                      <b>{label}</b>
                      <span className="block">{u.serviceProvider}</span>
                      {u.websiteUrl && <a className="block small" href={u.websiteUrl} target="_blank" rel="noopener noreferrer">Portal<span className="sr-only"> for {label} (opens in a new tab)</span></a>}
                    </td>
                    <td>{u.accountNumber ?? <span className="muted">—</span>}</td>
                    <td>{u.username ?? <span className="muted">—</span>}</td>
                    <td>
                      {!u.hasPassword ? <span className="muted">Not stored</span>
                        : shown !== null ? (
                          <span className="secret">
                            <code>{shown}</code>
                            <button type="button" className="iconbtn sm" onClick={() => void copy(u, shown)} aria-label={`Copy password for ${label}`}><Copy size={15} aria-hidden="true" /></button>
                            <button type="button" className="iconbtn sm" onClick={hide} aria-label={`Hide password for ${label}`}><EyeOff size={15} aria-hidden="true" /></button>
                          </span>
                        ) : (
                          <span className="secret">
                            <span className="masked" aria-label="Password hidden">••••••••</span>
                            {canReveal && (
                              <button type="button" className="iconbtn sm" disabled={busy !== null} aria-busy={busy === u.id || undefined}
                                onClick={() => void reveal(u)} aria-label={`Reveal password for ${label}`}><Eye size={15} aria-hidden="true" /></button>
                            )}
                          </span>
                        )}
                    </td>
                    <td><StatusPill status={u.status} /></td>
                    <td className="rowactions">
                      {canManage && (
                        <button type="button" className="iconbtn sm" onClick={() => setEditing(u)} aria-label={`Edit utility ${label}`}><Pencil size={15} aria-hidden="true" /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}

      {editing && (
        <Layer>
          <UtilityDialog kind={kind} ownerId={ownerId} record={editing === "new" ? null : editing} onClose={() => setEditing(null)}
            onSaved={(m) => {
              if (editing !== "new" && revealed?.id === editing.id) hide();
              setEditing(null); setMessage(m);
              void qc.invalidateQueries({ queryKey: siteKeys.utilities(kind, ownerId) });
            }} />
        </Layer>
      )}
      {stepUpFor && (
        <Layer>
          <StepUpDialog purpose="show utility portal passwords" logNote="Each password you show is recorded in the audit log."
            onClose={() => setStepUpFor(null)}
            onConfirmed={() => { const u = stepUpFor; setStepUpFor(null); void qc.invalidateQueries({ queryKey: documentKeys.stepUp }); void reveal(u); }} />
        </Layer>
      )}
    </div>
  );
}

type Values = { utilityType: UtilityType | ""; serviceProvider: string; accountNumber: string; websiteUrl: string; username: string; password: string; notes: string; status: SiteStatus };
type Errors = Partial<Record<keyof Values, string>>;

const initial = (u: Utility | null): Values => ({
  utilityType: u?.utilityType ?? "", serviceProvider: u?.serviceProvider ?? "", accountNumber: u?.accountNumber ?? "",
  websiteUrl: u?.websiteUrl ?? "", username: u?.username ?? "", password: "", notes: u?.notes ?? "", status: u?.status ?? "active",
});

export function validateUtility(v: Values): Errors {
  const e: Errors = {};
  if (!v.utilityType) e.utilityType = "Choose the utility type.";
  if (!v.serviceProvider.trim()) e.serviceProvider = "Enter the service provider.";
  if (v.websiteUrl.trim()) {
    let ok = false;
    try { ok = new URL(v.websiteUrl.trim()).protocol === "https:"; } catch { ok = false; }
    if (!ok) e.websiteUrl = "Enter a web address starting with https://.";
  }
  if (v.password.length > 200) e.password = "Use at most 200 characters.";
  return e;
}

/** "Add utility" / "Edit utility": two columns, password with show/hide. */
function UtilityDialog({ kind, ownerId, record, onClose, onSaved }: {
  kind: SiteKind; ownerId: string; record: Utility | null; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [v, setV] = useState<Values>(() => initial(record));
  const [errors, setErrors] = useState<Errors>({});
  const [showPw, setShowPw] = useState(false);
  const [clearPw, setClearPw] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const { busy, error, setError, run } = useSubmit((e) => sitesError(e, "utility"));
  const set = <K extends keyof Values>(key: K) => (e: { target: { value: string } }) => {
    setV((x) => ({ ...x, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateUtility(v);
    setErrors(errs);
    if (Object.keys(errs).length) { setError(""); failed(); return; }
    const empty = record ? null : undefined;
    const t = (s: string) => (s.trim() ? s.trim() : empty);
    const body: Record<string, unknown> = {
      utilityType: v.utilityType, serviceProvider: v.serviceProvider.trim(), accountNumber: t(v.accountNumber),
      websiteUrl: t(v.websiteUrl), username: t(v.username), notes: t(v.notes),
    };
    if (record) {
      body.status = v.status;
      if (clearPw) body.password = null;
      else if (v.password) body.password = v.password;
    } else if (v.password) body.password = v.password;
    void run(async () => {
      try {
        const clean = Object.fromEntries(Object.entries(body).filter(([, x]) => x !== undefined));
        if (record) await sitesApi.updateUtility(record.id, record.rowVersion, clean);
        else await sitesApi.createUtility(kind, ownerId, clean as never);
        onSaved(record ? "Utility saved." : "Utility added.");
      } catch (err) {
        failed();
        throw err;
      }
    });
  };

  return (
    <Dialog title={record ? "Edit utility" : "Add utility"} onClose={onClose} className="wide">
      <form ref={formRef} onSubmit={submit} noValidate autoComplete="off">
        <div className="formgrid cols2">
          <Field label="Account number" error={errors.accountNumber}>
            {(p) => <IconInput icon={Hash}><input {...p} value={v.accountNumber} onChange={set("accountNumber")} maxLength={100} spellCheck={false} data-autofocus /></IconInput>}
          </Field>
          <Field label="Username" error={errors.username}>
            {(p) => <IconInput icon={UserRound}><input {...p} value={v.username} onChange={set("username")} maxLength={200} spellCheck={false} autoComplete="off" /></IconInput>}
          </Field>
          <Field label="Password" error={errors.password}
            hint={record?.hasPassword ? "Leave empty to keep the stored password. Stored encrypted." : "Optional. Stored encrypted; shown only after you confirm it's you."}>
            {(p) => (
              <span className="pwinput">
                <IconInput icon={KeyRound}>
                  <input {...p} type={showPw ? "text" : "password"} value={v.password} onChange={set("password")} maxLength={200}
                    autoComplete="new-password" spellCheck={false} disabled={clearPw} />
                </IconInput>
                <button type="button" className="iconbtn sm pwtoggle" onClick={() => setShowPw((s) => !s)} aria-pressed={showPw}
                  aria-label={showPw ? "Hide password" : "Show password"}>
                  {showPw ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                </button>
              </span>
            )}
          </Field>
          <Field label="Utility type" error={errors.utilityType}>
            {(p) => (
              <select {...p} value={v.utilityType} onChange={set("utilityType")}>
                <option value="">Choose…</option>
                {UTILITY_TYPES.map((t) => <option key={t} value={t}>{UTILITY_LABELS[t]}</option>)}
              </select>
            )}
          </Field>
          <Field label="Service provider" error={errors.serviceProvider}>
            {(p) => <IconInput icon={Building}><input {...p} value={v.serviceProvider} onChange={set("serviceProvider")} maxLength={200} /></IconInput>}
          </Field>
          <Field label="Website URL" error={errors.websiteUrl}>
            {(p) => <IconInput icon={Link2}><input {...p} type="url" value={v.websiteUrl} onChange={set("websiteUrl")} maxLength={500} placeholder="https://" /></IconInput>}
          </Field>
          {record && (
            <Field label="Status">
              {(p) => (
                <select {...p} value={v.status} onChange={set("status")}>
                  <option value="active">Active</option><option value="inactive">Inactive</option>
                </select>
              )}
            </Field>
          )}
          {record?.hasPassword && (
            <div className="field checkfield">
              <label className="check"><input type="checkbox" checked={clearPw} onChange={(e) => setClearPw(e.target.checked)} /> Remove the stored password</label>
            </div>
          )}
          <div className="spanall">
            <Field label="Notes">{(p) => <textarea {...p} rows={3} maxLength={2000} value={v.notes} onChange={set("notes")} />}</Field>
          </div>
        </div>
        {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={() => { setV(initial(record)); setErrors({}); setError(""); setClearPw(false); }}>Reset</button>
          <button type="submit" className="btn primary" disabled={busy} aria-busy={busy || undefined}>{busy ? "Working…" : record ? "Save" : "Submit"}</button>
        </div>
      </form>
    </Dialog>
  );
}
