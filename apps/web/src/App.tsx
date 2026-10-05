import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, setCsrf, type Me } from "./api";
import { SETTINGS_NAV, visibleNav, type NavItem } from "./nav";
import { SettingsPage } from "./settings/SettingsPage";
import { AccessPage } from "./admin/AccessPage";
import { DashboardPage } from "./dashboard/DashboardPage";
import { CandidateProfile } from "./sales/CandidateProfile";
import { CandidatesPage } from "./sales/CandidatesPage";
import { InterviewsPage } from "./interviews/InterviewsPage";
import { HotListPage } from "./sales/HotListPage";
import { PlacementsPage } from "./pipeline/PlacementsPage";
import { SubmissionsPage } from "./pipeline/SubmissionsPage";
import { PaperworkPage } from "./paperwork/PaperworkPage";
import { NotificationBell, type InboxItem } from "./notifications/Inbox";
import { EmployeesPage } from "./employees/EmployeesPage";
import { ReportsPage } from "./employees/JoiningsExitsReport";
import { CompaniesPage, FacilitiesPage } from "./sites/SitesPage";
import { DataHubPage } from "./datahub/DataHubPage";
import { TrainingPage } from "./training/TrainingPage";
import { CoursesPage } from "./training/CoursesPage";
import { ChatNavBadge, ChatPage } from "./chat/ChatPage";
import { JobsPage } from "./jobs/JobsPage";
import { ApplicationsPage } from "./jobs/ApplicationsPage";
import { ApplicantsPage } from "./jobs/ApplicantsPage";
import { Menu, Moon, PanelLeftClose, PanelLeftOpen, Sparkles, Sun } from "lucide-react";
import { useTheme } from "./shell/theme";
import { NAV_ICONS, ThemeSwitch, UserMenu } from "./shell/ui";

/** The Hot List screen (kept under its original name for existing callers). */
export const HotList = HotListPage;

const DEV_USERS = [
  ["r1a", "Recruiter (Team Rohit)"], ["l1", "Lead (Team Rohit)"], ["m1", "Manager"], ["ad", "Associate Director"],
  ["locD", "Location Ops Admin (Dallas)"], ["coach", "Interview Coach"], ["hr", "HR"], ["ceo", "CEO"], ["admin", "Org Admin"],
] as const;

/** Username and password sign-in (staging and local test environments; the server offers it via /api/auth/methods). */
function PasswordForm({ onSignedIn, onError }: { onSignedIn: () => void; onError: (m: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); onError("");
      try {
        await api("/api/auth/password-login", { method: "POST", body: JSON.stringify({ email: email.trim(), password }) });
        onSignedIn();
      } catch (er) {
        onError(er instanceof ApiError && er.status === 429
          ? "Too many attempts. Wait a few minutes and try again."
          : er instanceof ApiError && er.status === 401 ? "Invalid email or password." : (er as Error).message);
      } finally { setBusy(false); }
    }}>
      <p className="sub">Sign in with your email and password.</p>
      <div className="field"><label htmlFor="pw-email">Email</label>
        <input id="pw-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <div className="field"><label htmlFor="pw-pass">Password</label>
        <input id="pw-pass" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      <button type="submit" className="btn primary block" disabled={busy}>Sign in</button>
    </form>
  );
}

/** Shown instead of the app while a temporary (admin-set) password is still in use. */
export function ChangePassword({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const message = (e: unknown) => {
    const d = e instanceof ApiError ? e.detail : undefined;
    if (d === "current_password_incorrect") return "The current password is incorrect.";
    if (d === "password_weak") return "Use 10 to 72 characters with at least one letter and one number.";
    if (d === "password_unchanged") return "Choose a password different from the current one.";
    if (d === "account_locked") return "Too many attempts. Wait a few minutes and try again.";
    return e instanceof Error ? e.message : "Could not change the password.";
  };
  return (
    <div className="loginpage"><main className="loginpanel"><div className="loginbox">
      <h1>Choose a new password</h1>
      <p className="sub">Your password was set by an administrator. Choose your own to continue.</p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (next !== again) { setErr("The new passwords do not match."); return; }
        setBusy(true); setErr("");
        try {
          await api("/api/auth/password/change", { method: "POST", body: JSON.stringify({ currentPassword: cur, newPassword: next }) });
          onDone();
        } catch (er) { setErr(message(er)); } finally { setBusy(false); }
      }}>
        <div className="field"><label htmlFor="cp-cur">Current password</label>
          <input id="cp-cur" type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <div className="field"><label htmlFor="cp-new">New password</label>
          <input id="cp-new" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} /></div>
        <div className="field"><label htmlFor="cp-again">Repeat new password</label>
          <input id="cp-again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} /></div>
        <button type="submit" className="btn primary block" disabled={busy}>Change password</button>
        <button type="button" className="btn ghost block" onClick={onSignOut}>Sign out</button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
    </div></main></div>
  );
}

export function Login({ onSignedIn, devMode = import.meta.env.DEV }: { onSignedIn: () => void; devMode?: boolean }) {
  const [who, setWho] = useState<string>(DEV_USERS[0][0]);
  const [err, setErr] = useState("");
  const methods = useQuery({
    queryKey: ["auth-methods"],
    queryFn: () => api<{ password: boolean; google: boolean; dev: boolean }>("/api/auth/methods").catch(() => null),
    staleTime: Infinity,
  });
  const passwordLogin = methods.data?.password === true;
  const [theme, setTheme] = useTheme();
  return (
    <div className="loginpage">
      <section className="loginhero" aria-hidden="true">
        <div className="herogrid" />
        <div className="heroshots">
          <div className="heroshot main">
            <div className="heroshot-bar"><span className="logo sm"><Sparkles size={12} /></span>Eureka<i /><i /><i /></div>
            <div className="heroshot-kpis">
              {[["Submissions", "48"], ["Interviews", "28"], ["Placements", "8"], ["Joined", "5"]].map(([l, v]) => (
                <div key={l}><small>{l}</small><b>{v}</b></div>
              ))}
            </div>
            <svg className="heroshot-line" viewBox="0 0 300 80" preserveAspectRatio="none">
              <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#14b8a6" stopOpacity=".35" /><stop offset="1" stopColor="#14b8a6" stopOpacity="0" /></linearGradient></defs>
              <path d="M0 60 C30 40 45 70 70 50 S110 20 135 42 S180 62 205 30 S255 22 300 12 L300 80 L0 80Z" fill="url(#hg)" />
              <path d="M0 60 C30 40 45 70 70 50 S110 20 135 42 S180 62 205 30 S255 22 300 12" fill="none" stroke="#14b8a6" strokeWidth="2.5" />
            </svg>
          </div>
          <div className="heroshot funnel">
            <b>Pipeline funnel</b>
            <svg viewBox="0 0 260 70" preserveAspectRatio="none">
              <defs><linearGradient id="hf" x1="0" x2="1"><stop offset="0" stopColor="#8b5cf6" /><stop offset=".5" stopColor="#6366f1" /><stop offset="1" stopColor="#5eead4" /></linearGradient></defs>
              <path d="M0 0 H70 C100 0 100 14 130 14 H170 C200 14 200 24 230 24 H260 V46 H230 C200 46 200 56 170 56 H130 C100 56 100 70 70 70 H0Z" fill="url(#hf)" />
            </svg>
            <div className="heroshot-steps"><span>48</span><span>28</span><span>14</span><span>8</span></div>
          </div>
        </div>
        <div className="herotext">
          <h2>Welcome to Eureka</h2>
          <p>Hot list, submissions, interviews and placements for your staffing teams, in one place.</p>
        </div>
      </section>
      <main className="loginpanel">
        <div className="loginbox">
          <div className="loginbar">
            <div className="brand"><span className="logo"><Sparkles size={16} aria-hidden="true" /></span>Eureka</div>
            <button type="button" className="btn ghost themechip" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
              {theme === "dark" ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}{theme === "dark" ? "Dark" : "Light"}
            </button>
          </div>
          <h1>Hi, welcome back!</h1>
          {passwordLogin && <PasswordForm onSignedIn={onSignedIn} onError={setErr} />}
          {devMode ? (
            <>
              <p className="sub">{passwordLogin ? "Or, for development: sign in as a fictional user." : "Development sign-in with fictional users."}</p>
              <div className="field">
                <label htmlFor="who">Sign in as</label>
                <select id="who" value={who} onChange={(e) => setWho(e.target.value)}>
                  {DEV_USERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </div>
              <button type="button" className="btn primary block" onClick={async () => {
                try {
                  await api("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ email: `${who}@eureka.example` }) });
                  onSignedIn();
                } catch (e) { setErr((e as Error).message); }
              }}>Sign in</button>
            </>
          ) : methods.data?.google === false ? null : (
            <>
              <p className="sub">{passwordLogin ? "Or sign in with your company Google account." : "Sign in with your company Google account."}</p>
              <a className="btn primary block googlebtn" href="/api/auth/login">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#fff" d="M21.35 11.1H12v2.9h5.35c-.25 1.5-1.7 4.4-5.35 4.4-3.2 0-5.85-2.65-5.85-5.9S8.8 6.6 12 6.6c1.85 0 3.05.8 3.75 1.45l2.55-2.45C16.7 4.1 14.55 3.1 12 3.1 7.05 3.1 3.1 7.05 3.1 12s3.95 8.9 8.9 8.9c5.15 0 8.55-3.6 8.55-8.7 0-.6-.05-1.05-.2-1.1z" /></svg>
                Sign in with Google
              </a>
            </>
          )}
          {err && <p className="error" role="alert">{err}</p>}
          <p className="loginfoot">Access is limited to your organisation's accounts. Every sign-in is recorded.</p>
        </div>
      </main>
    </div>
  );
}

const PLANNED: Record<string, string> = {
  payments: "Vendor invoices, payments and automatic delay alerts for Accounts.",
  performance: "Recruiter performance against targets, with alerts for managers.",
};

function Placeholder({ item }: { item: NavItem }) {
  return (
    <div>
      <h1>{item.label}</h1>
      <div className="card empty" role="status">
        <b>Coming soon</b>
        <p className="sub">{PLANNED[item.key] ?? "This area is planned for a later phase."}</p>
      </div>
    </div>
  );
}

export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const items = useMemo(() => visibleNav(me.capabilities), [me.capabilities]);
  const [active, setActive] = useState(items.find((i) => i.key === "hotlist")?.key ?? items[0]?.key);
  // Open candidate profile. The list stays mounted (hidden) so its filters, page
  // and scroll survive, and focus returns to the row that opened the profile.
  const [profileId, setProfileId] = useState<string | null>(null);
  // A placement to open when switching to Placements from another screen (e.g. right after creating it).
  const [placementId, setPlacementId] = useState<string | null>(null);
  const openPlacement = (id: string) => { setPlacementId(id); setActive("placements"); };
  // jobs-portal: an application to open when switching to Applications (from the inbox).
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const openProfile = (id: string) => { opener.current = document.activeElement as HTMLElement | null; setProfileId(id); };
  const closeProfile = () => { setProfileId(null); setRestoreFocus(true); };
  useEffect(() => {
    if (!restoreFocus) return;
    setRestoreFocus(false);
    const el = opener.current;
    if (el && el.isConnected && !el.closest("[hidden]")) el.focus();
    else document.querySelector<HTMLElement>(".content h1")?.focus();
  }, [restoreFocus]);
  // Inbox entries open the placement or the candidate profile when the user has that screen.
  const has = (key: string) => items.some((i) => i.key === key);
  const candidateScreen = has("candidates") ? "candidates" : has("hotlist") ? "hotlist" : null;
  // A chat conversation to open when switching to Chat (from a direct-message notification).
  const [chatId, setChatId] = useState<string | null>(null);
  const canOpenEntity = (e: InboxItem["entity"]) =>
    (e.type === "placement" ? has("placements") : e.type === "conversation" ? has("chat") : e.type === "application" ? has("applications") : candidateScreen !== null);
  const openEntity = (e: InboxItem["entity"]) => {
    if (e.type === "application") { setProfileId(null); setApplicationId(e.id); setActive("applications"); return; }
    if (e.type === "placement") { setProfileId(null); openPlacement(e.id); return; }
    if (e.type === "conversation") { setProfileId(null); setChatId(e.id); setActive("chat"); return; }
    if (!candidateScreen) return;
    setPlacementId(null);
    setActive(candidateScreen);
    openProfile(e.id);
  };
  const sections = [...new Set(items.map((i) => i.section))];
  const current = active === SETTINGS_NAV.key ? SETTINGS_NAV : items.find((i) => i.key === active);
  // Phones: the sidebar is an off-canvas drawer opened from the top bar's menu button.
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  // Desktop: the sidebar can shrink to icons; remembered on this device.
  const [collapsed, setCollapsedState] = useState(() => { try { return localStorage.getItem("eureka-nav") === "collapsed"; } catch { return false; } });
  const setCollapsed = (c: boolean) => { setCollapsedState(c); try { localStorage.setItem("eureka-nav", c ? "collapsed" : "open"); } catch { /* not remembered */ } };
  const menuBtn = useRef<HTMLButtonElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!navOpen) return;
    sideRef.current?.querySelector<HTMLElement>(".nav")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setNavOpen(false); menuBtn.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);
  return (
    <div className={collapsed ? "app collapsed" : "app"}>
      <aside id="mainnav" ref={sideRef} className={navOpen ? "side open" : "side"} aria-label="Main navigation">
        <div className="brandrow">
          <div className="brand"><span className="logo"><Sparkles size={16} aria-hidden="true" /></span><span className="brandtext">Eureka<small>Staffing pipeline</small></span></div>
          <button type="button" className="collapsebtn" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
          </button>
        </div>
        <nav className="navlist">
          {sections.map((s) => (
            <div key={s} className="navgroup">
              <div className="navsec">{s}</div>
              {items.filter((i) => i.section === s).map((i) => {
                const Icon = NAV_ICONS[i.key];
                return (
                  <button key={i.key} className="nav" title={collapsed ? i.label : undefined} aria-current={i.key === active ? "page" : undefined}
                    aria-describedby={i.key === "chat" ? "chat-nav-unread" : undefined}
                    onClick={() => { setActive(i.key); setProfileId(null); setPlacementId(null); setChatId(null); setApplicationId(null); setNavOpen(false); }}>
                    {Icon && <Icon className="navicon" size={19} strokeWidth={1.8} aria-hidden="true" />}<span className="navlabel">{i.label}</span>
                    {i.key === "chat" && <ChatNavBadge id="chat-nav-unread" part="badge" />}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        {items.some((i) => i.key === "chat") && <ChatNavBadge id="chat-nav-unread" part="text" />}
        <ThemeSwitch theme={theme} onChange={setTheme} />
      </aside>
      {navOpen && <div className="navscrim" aria-hidden="true" onClick={() => setNavOpen(false)} />}
      <main className="main">
        <div className="top">
          <button ref={menuBtn} type="button" className="menubtn" aria-label="Menu" aria-controls="mainnav" aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}><Menu size={19} aria-hidden="true" /></button>
          <span className="topbrand"><span className="logo"><Sparkles size={14} aria-hidden="true" /></span>Eureka</span>
          <div className="topright">
            <NotificationBell onOpen={openEntity} canOpen={canOpenEntity} />
            <UserMenu name={me.displayName} roles={me.roles.map((r) => r.label).join(", ")} onSignOut={onSignOut}
              onSettings={() => { setActive(SETTINGS_NAV.key); setProfileId(null); setPlacementId(null); setNavOpen(false); }} />
          </div>
        </div>
        <div className="content">
          {!current ? <p className="empty">Your role has no screens yet.</p>
            : current.key === "hotlist" || current.key === "candidates" ? (
              <>
                <div className="panel" hidden={profileId !== null}>
                  {current.key === "hotlist"
                    ? <HotListPage key="hotlist" me={me} onOpenProfile={openProfile} />
                    : <CandidatesPage key="candidates" me={me} onOpenProfile={openProfile} />}
                </div>
                {profileId && <CandidateProfile key={profileId} id={profileId} me={me} onBack={closeProfile} backLabel={`Back to ${current.label}`} />}
              </>
            )
            : current.key === "submissions" ? <SubmissionsPage me={me} onOpenPlacement={items.some((i) => i.key === "placements") ? openPlacement : undefined} />
            : current.key === "placements" ? <PlacementsPage key={placementId ?? "list"} me={me} initialOpenId={placementId} />
            : current.key === "interviews" ? <InterviewsPage me={me} />
            : current.key === "paperwork" ? <PaperworkPage me={me} />
            : current.key === "access" ? <AccessPage me={me} />
            : current.key === "employees" ? <EmployeesPage me={me} />
            : current.key === "reports" ? <ReportsPage me={me} />
            : current.key === "companies" ? <CompaniesPage key="companies" me={me} />
            : current.key === "facilities" ? <FacilitiesPage key="facilities" me={me} />
            : current.key === "datahub" ? <DataHubPage />
            : current.key === "training" ? <TrainingPage me={me} />
            : current.key === "courses" ? <CoursesPage me={me} />
            : current.key === "settings" ? <SettingsPage me={me} />
            : current.key === "chat" ? <ChatPage me={me} initialConversationId={chatId} />
            : current.key === "jobs" ? <JobsPage me={me} />
            : current.key === "applications" ? <ApplicationsPage key={applicationId ?? "list"} me={me} initialOpenId={applicationId} />
            : current.key === "applicants" ? <ApplicantsPage />
            : current.key === "dashboard" ? (
              <DashboardPage firstName={me.displayName.split(" ")[0]} canOpen={(t) => items.some((i) => i.key === t)}
                onOpen={(t, id) => { if (t === "placements") openPlacement(id); else setActive(t); }} />
            )
            : <Placeholder item={current} />}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const m = await api<Me>("/api/v1/me");
        setCsrf(m.csrfToken);
        return m;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
  if (me.isLoading) return <p className="empty">Loading…</p>;
  if (!me.data) return <Login onSignedIn={() => qc.invalidateQueries()} />;
  const signOut = async () => {
    // A 401 here means the session is already gone; either way the client must return to the sign-in screen.
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* already signed out */ }
    qc.clear();
    await qc.invalidateQueries();
  };
  if (me.data.mustChangePassword) return <ChangePassword onDone={() => qc.invalidateQueries()} onSignOut={signOut} />;
  return <Shell me={me.data} onSignOut={signOut} />;
}
