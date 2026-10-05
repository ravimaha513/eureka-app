import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, setCsrf, type Me } from "./api";
import { visibleNav, type NavItem } from "./nav";
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
import { TrainingPage } from "./training/TrainingPage";
import { CoursesPage } from "./training/CoursesPage";
import { Menu, Moon, PanelLeftClose, PanelLeftOpen, Sparkles, Sun } from "lucide-react";
import { useTheme } from "./shell/theme";
import { NAV_ICONS, ThemeSwitch, UserMenu } from "./shell/ui";

/** The Hot List screen (kept under its original name for existing callers). */
export const HotList = HotListPage;

const DEV_USERS = [
  ["r1a", "Recruiter (Team Rohit)"], ["l1", "Lead (Team Rohit)"], ["m1", "Manager"], ["ad", "Associate Director"],
  ["locD", "Location Ops Admin (Dallas)"], ["coach", "Interview Coach"], ["hr", "HR"], ["ceo", "CEO"], ["admin", "Org Admin"],
] as const;

export function Login({ onSignedIn, devMode = import.meta.env.DEV }: { onSignedIn: () => void; devMode?: boolean }) {
  const [who, setWho] = useState<string>(DEV_USERS[0][0]);
  const [err, setErr] = useState("");
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
          {devMode ? (
            <>
              <p className="sub">Development sign-in with fictional users.</p>
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
          ) : (
            <>
              <p className="sub">Sign in with your company Google account.</p>
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

function Placeholder({ item }: { item: NavItem }) {
  return <div><h1>{item.label}</h1><p className="sub">Planned in a later phase (see implementation plan).</p></div>;
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
  const canOpenEntity = (e: InboxItem["entity"]) => (e.type === "placement" ? has("placements") : candidateScreen !== null);
  const openEntity = (e: InboxItem["entity"]) => {
    if (e.type === "placement") { setProfileId(null); openPlacement(e.id); return; }
    if (!candidateScreen) return;
    setPlacementId(null);
    setActive(candidateScreen);
    openProfile(e.id);
  };
  const sections = [...new Set(items.map((i) => i.section))];
  const current = items.find((i) => i.key === active);
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
                    onClick={() => { setActive(i.key); setProfileId(null); setPlacementId(null); setNavOpen(false); }}>
                    {Icon && <Icon className="navicon" size={19} strokeWidth={1.8} aria-hidden="true" />}<span className="navlabel">{i.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
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
            <UserMenu name={me.displayName} roles={me.roles.map((r) => r.label).join(", ")} onSignOut={onSignOut} />
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
            : current.key === "training" ? <TrainingPage me={me} />
            : current.key === "courses" ? <CoursesPage me={me} />
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
  return <Shell me={me.data} onSignOut={async () => { await api("/api/auth/logout", { method: "POST" }); qc.clear(); await qc.invalidateQueries(); }} />;
}
