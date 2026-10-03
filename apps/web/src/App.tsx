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

/** The Hot List screen (kept under its original name for existing callers). */
export const HotList = HotListPage;

const DEV_USERS = [
  ["r1a", "Recruiter (Team Rohit)"], ["l1", "Lead (Team Rohit)"], ["m1", "Manager"], ["ad", "Associate Director"],
  ["locD", "Location Ops Admin (Dallas)"], ["coach", "Interview Coach"], ["hr", "HR"], ["ceo", "CEO"], ["admin", "Org Admin"],
] as const;

export function Login({ onSignedIn, devMode = import.meta.env.DEV }: { onSignedIn: () => void; devMode?: boolean }) {
  const [who, setWho] = useState<string>(DEV_USERS[0][0]);
  const [err, setErr] = useState("");
  return (
    <main className="login">
      <div className="brand" style={{ color: "var(--text)" }}><span className="logo">✦</span>Eureka</div>
      {devMode ? (
        <>
          <label htmlFor="who">Development sign-in (fictional users)</label>
          <select id="who" value={who} onChange={(e) => setWho(e.target.value)}>
            {DEV_USERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <button onClick={async () => {
            try {
              await api("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ email: `${who}@eureka.example` }) });
              onSignedIn();
            } catch (e) { setErr((e as Error).message); }
          }}>Sign in</button>
        </>
      ) : (
        <a href="/api/auth/login"><button style={{ width: "100%" }}>Sign in with Google</button></a>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </main>
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
  return (
    <div className="app">
      <aside className="side" aria-label="Main navigation">
        <div className="brand"><span className="logo">✦</span>Eureka</div>
        {sections.map((s) => (
          <div key={s}>
            <div className="navsec">{s}</div>
            {items.filter((i) => i.section === s).map((i) => (
              <button key={i.key} className="nav" aria-current={i.key === active ? "page" : undefined} onClick={() => { setActive(i.key); setProfileId(null); setPlacementId(null); }}>{i.label}</button>
            ))}
          </div>
        ))}
        <div className="sidefoot">{me.displayName}<small>{me.roles.map((r) => r.label).join(", ")}</small>
          <button className="nav" onClick={onSignOut}>Sign out</button></div>
      </aside>
      <main className="main">
        <div className="top">
          <span className="rolepill">{me.roles.map((r) => r.label).join(" · ")}</span>
          <NotificationBell onOpen={openEntity} canOpen={canOpenEntity} />
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
            : current.key === "dashboard" ? (
              <DashboardPage canOpen={(t) => items.some((i) => i.key === t)}
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
