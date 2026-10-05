import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, LogOut, ShieldCheck, UserRound } from "lucide-react";
import type { Me } from "../api";
import { ConfirmDialog } from "../admin/Dialog";
import { Field, useFocusAfterFailure } from "../sales/ui";
import { Avatar } from "../shell/ui";
import { DEVICE_LABELS, settingsApi, settingsError, settingsKeys, type Preference, type Profile, type SessionRow } from "./settingsApi";

type Tab = "profile" | "notifications" | "security";
const TABS: { key: Tab; label: string; Icon: typeof Bell }[] = [
  { key: "profile", label: "Profile", Icon: UserRound },
  { key: "notifications", label: "Notifications", Icon: Bell },
  { key: "security", label: "Security", Icon: ShieldCheck },
];

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Settings & Preferences (avatar menu -> Settings): the signed-in staff
 * member's own profile, in-app notification choices and sign-in sessions.
 * Education, skills and resumes belong to candidate profiles, not staff
 * accounts, so they are not here.
 */
export function SettingsPage({ me }: { me: Pick<Me, "displayName"> }) {
  const id = useId();
  const [tab, setTab] = useState<Tab>("profile");
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ profile: null, notifications: null, security: null });
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.key === tab);
    const next = e.key === "ArrowDown" || e.key === "ArrowRight" ? (i + 1) % TABS.length
      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length
        : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!.key);
    refs.current[TABS[next]!.key]?.focus();
  };
  return (
    <>
      <div>
        <h1 tabIndex={-1}>Settings &amp; Preferences</h1>
        <p className="sub">Your own profile, notifications and sign-in activity. Changes here affect only your account.</p>
      </div>
      <div className="settings">
        <div className="card settingsnav" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={onKey}>
          {TABS.map(({ key, label, Icon }) => (
            <button key={key} ref={(el) => { refs.current[key] = el; }} type="button" role="tab" id={`${id}-${key}`}
              aria-selected={tab === key} aria-controls={`${id}-${key}-panel`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)}>
              <Icon size={16} aria-hidden="true" />{label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}`} className="card pad">
          {tab === "profile" && <ProfileSection fallbackName={me.displayName} />}
          {tab === "notifications" && <NotificationsSection />}
          {tab === "security" && <SecuritySection />}
        </div>
      </div>
    </>
  );
}

function ProfileSection({ fallbackName }: { fallbackName: string }) {
  const q = useQuery({ queryKey: settingsKeys.profile, queryFn: settingsApi.profile });
  if (q.isLoading) return <p className="empty">Loading…</p>;
  if (q.error || !q.data) return <p className="error" role="alert">{settingsError(q.error)}</p>;
  return <ProfileForm p={q.data} fallbackName={fallbackName} />;
}

function ProfileForm({ p, fallbackName }: { p: Profile; fallbackName: string }) {
  const qc = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const focusFailure = useFocusAfterFailure(formRef);
  const [phone, setPhone] = useState(p.phone ?? "");
  const [bio, setBio] = useState(p.bio ?? "");
  const [saved, setSaved] = useState("");
  const save = useMutation({
    mutationFn: () => settingsApi.saveProfile(p.rowVersion, { phone: phone.trim() || null, bio: bio.trim() || null }),
    onSuccess: (next) => { qc.setQueryData(settingsKeys.profile, next); setSaved("Profile saved."); },
    onError: () => focusFailure(),
  });
  const err = save.error ? settingsError(save.error) : "";
  return (
    <form ref={formRef} onSubmit={(e) => { e.preventDefault(); setSaved(""); save.mutate(); }} aria-labelledby="profile-h">
      <h2 id="profile-h">Profile</h2>
      <div className="drawerperson"><Avatar name={p.displayName || fallbackName} /><div><b>{p.displayName}</b><span className="block">{p.email}</span></div></div>
      <dl className="infogrid">
        <div><dt>Display name</dt><dd>{p.displayName} <span className="muted">(from your Google account)</span></dd></div>
        <div><dt>Designation</dt><dd>{p.designation ?? "—"} <span className="muted">(set by your manager)</span></dd></div>
        <div><dt>Location</dt><dd>{p.location ?? "—"}</dd></div>
      </dl>
      <Field label="Work phone" hint="International format, e.g. +1 469 555 0142. HR and administrators can see it."
        error={err && /phone|country|format/i.test(err) ? err : undefined}>
        {(a) => <input {...a} type="tel" autoComplete="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />}
      </Field>
      <Field label="Short bio" hint={`${bio.length}/500 characters. Keep it to work: no personal details.`}>
        {(a) => <textarea {...a} rows={4} maxLength={500} value={bio} onChange={(e) => setBio(e.target.value)} />}
      </Field>
      {err && <p className="error formerr" role="alert" tabIndex={-1}>{err}</p>}
      <p role="status" className="livemsg">{saved}</p>
      <div className="actions left"><button type="submit" className="btn primary" disabled={save.isPending} aria-busy={save.isPending || undefined}>{save.isPending ? "Saving…" : "Save profile"}</button></div>
      <p className="hint">Education, skills, certifications and resumes are kept on candidate profiles, not on staff accounts.</p>
    </form>
  );
}

function NotificationsSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: settingsKeys.preferences, queryFn: settingsApi.preferences });
  const [msg, setMsg] = useState("");
  const set = useMutation({
    mutationFn: (v: { type: string; inApp: boolean }) => settingsApi.setPreference(v.type, v.inApp),
    onSuccess: (data, v) => { qc.setQueryData(settingsKeys.preferences, data); setMsg(`${data.items.find((i) => i.type === v.type)?.label ?? "Notification"} turned ${v.inApp ? "on" : "off"}.`); },
  });
  return (
    <section aria-labelledby="notif-h">
      <h2 id="notif-h">Notifications</h2>
      <p className="hint">In-app notifications in the bell. Emails follow your role and are not changed here.</p>
      {q.isLoading && <p className="empty">Loading…</p>}
      {q.error && <p className="error" role="alert">{settingsError(q.error)}</p>}
      {set.error && <p className="error" role="alert">{settingsError(set.error)}</p>}
      <p role="status" className="livemsg">{msg}</p>
      {q.data?.items.map((p) => <PreferenceRow key={p.type} p={p} busy={set.isPending && set.variables?.type === p.type}
        onChange={(inApp) => { setMsg(""); set.mutate({ type: p.type, inApp }); }} />)}
    </section>
  );
}

function PreferenceRow({ p, busy, onChange }: { p: Preference; busy: boolean; onChange: (inApp: boolean) => void }) {
  const id = useId();
  return (
    <div className="prefrow">
      <div><b id={`${id}-l`}>{p.label}</b><p id={`${id}-d`} className="hint">{p.description}{p.mandatory ? " Required: can't be turned off." : ""}</p></div>
      <button type="button" role="switch" aria-checked={p.inApp} aria-labelledby={`${id}-l`} aria-describedby={`${id}-d`}
        className={`switch ${p.inApp ? "on" : ""}`} disabled={busy || p.mandatory} aria-busy={busy || undefined} onClick={() => onChange(!p.inApp)}>
        <span className="knob" aria-hidden="true" /> <span>{p.inApp ? "On" : "Off"}</span>
      </button>
    </div>
  );
}

function SecuritySection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: settingsKeys.sessions, queryFn: settingsApi.sessions });
  const [confirm, setConfirm] = useState<SessionRow | "others" | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { if (msg) void qc.invalidateQueries({ queryKey: settingsKeys.sessions }); }, [msg, qc]);
  const others = (q.data?.items ?? []).filter((s) => !s.current && s.status === "active");
  const signIn = q.data?.signIn;
  return (
    <section aria-labelledby="sec-h">
      <h2 id="sec-h">Security</h2>
      {signIn && <p className="signinnote"><ShieldCheck size={16} aria-hidden="true" />
        {signIn.provider === "google" ? `Signed in with Google${signIn.domain ? ` (${signIn.domain})` : ""}. Your password and two-step verification are managed by Google.` : "Development sign-in (no password)."}</p>}
      <h3>Login activity</h3>
      <p className="hint">Your sign-ins from the last 30 days. IP addresses are shortened; device and browser are read from the browser's own description.</p>
      <p role="status" className="livemsg">{msg}</p>
      {q.isLoading && <p className="empty">Loading…</p>}
      {q.error && <p className="error" role="alert">{settingsError(q.error)}</p>}
      {q.data && (
        <div className="tablewrap"><table aria-label="Login activity">
          <thead><tr><th>Signed in</th><th>Device</th><th>IP address</th><th>Last seen</th><th><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {q.data.items.map((s) => (
              <tr key={s.id}>
                <td><time dateTime={s.signedInAt}>{when(s.signedInAt)}</time></td>
                <td>{DEVICE_LABELS[s.device]} · {s.browser}{s.current && <span className="tag">Current session</span>}</td>
                <td>{s.ip ?? "—"}</td>
                <td>{s.status === "active" ? <time dateTime={s.lastSeenAt}>{when(s.lastSeenAt)}</time> : <span className="muted">{s.status === "signed_out" ? "Signed out" : "Expired"}</span>}</td>
                <td className="rowactions">{!s.current && s.status === "active" && (
                  <button type="button" className="btn sm" aria-label={`Sign out the ${DEVICE_LABELS[s.device]} ${s.browser} session from ${when(s.signedInAt)}`}
                    onClick={() => setConfirm(s)}><LogOut size={14} aria-hidden="true" /> Sign out</button>)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {others.length > 0 && <div className="actions left"><button type="button" className="btn danger" onClick={() => setConfirm("others")}>Sign out of all other sessions</button></div>}
      {confirm === "others" && (
        <ConfirmDialog title="Sign out of all other sessions?" confirmLabel="Sign out others" danger formatError={settingsError}
          action={async () => { const r = await settingsApi.revokeOthers(); setMsg(`Signed out ${r.revoked} other ${r.revoked === 1 ? "session" : "sessions"}.`); }}
          onClose={() => setConfirm(null)} onDone={() => setConfirm(null)}>
          <p>Every other browser and device signed in to your account is signed out now. This session stays signed in.</p>
        </ConfirmDialog>
      )}
      {confirm && confirm !== "others" && (
        <ConfirmDialog title="Sign out this session?" confirmLabel="Sign out" danger formatError={settingsError}
          action={async () => { await settingsApi.revoke(confirm.id); setMsg("Session signed out."); }}
          onClose={() => setConfirm(null)} onDone={() => setConfirm(null)}>
          <p>{DEVICE_LABELS[confirm.device]} · {confirm.browser}, signed in {when(confirm.signedInAt)}{confirm.ip ? ` from ${confirm.ip}` : ""}. It will have to sign in again.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
