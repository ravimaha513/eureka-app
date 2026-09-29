import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, setCsrf, type Candidate, type Me } from "./api";
import { visibleNav, type NavItem } from "./nav";
import { AccessPage } from "./admin/AccessPage";

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

export function HotList() {
  const [tab, setTab] = useState<"mine" | "all_teams">("mine");
  const q = useQuery({
    queryKey: ["hotlist", tab],
    queryFn: () => api<{ items: Candidate[] }>(`/api/v1/hotlist?limit=200${tab === "all_teams" ? "&visibility=all_teams" : ""}`),
  });
  return (
    <>
      <div><h1>Hot List</h1><p className="sub">Candidates ready for marketing. Visibility follows your team, plus anyone marked “Open to all teams”.</p></div>
      <div className="tabs">
        <button className="tab" aria-pressed={tab === "mine"} onClick={() => setTab("mine")}>Visible to me</button>
        <button className="tab" aria-pressed={tab === "all_teams"} onClick={() => setTab("all_teams")}>Open to all teams</button>
      </div>
      <div className="card">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="empty error">{(q.error as Error).message}</p> : (
          <table>
            <thead><tr><th>Candidate</th><th>Technology</th><th>Status</th><th>Pri</th><th>Team</th><th>Recruiter</th><th>Location</th><th>Phone</th></tr></thead>
            <tbody>
              {q.data!.items.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.name}</b></td>
                  <td>{c.technology}</td>
                  <td>
                    <span className={`badge ${c.status}`}>{c.status.replace(/_/g, " ")}</span>{" "}
                    {c.visibility === "all_teams" && <span className="badge all_teams">all teams</span>}
                  </td>
                  <td><span className={`prio ${c.priority}`}>{c.priority}</span></td>
                  <td>{c.team.name}</td>
                  <td>{c.recruiter?.name ?? "Unassigned"}</td>
                  <td>{c.location.name}</td>
                  <td className={c.phoneMasked ? "masked" : ""} title={c.phoneMasked ? "Masked: not your team's candidate" : undefined}>{c.phone ?? "—"}</td>
                </tr>
              ))}
              {q.data!.items.length === 0 && <tr><td colSpan={8} className="empty">No candidates in your scope.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Placeholder({ item }: { item: NavItem }) {
  return <div><h1>{item.label}</h1><p className="sub">Planned in a later phase (see implementation plan).</p></div>;
}

export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const items = useMemo(() => visibleNav(me.capabilities), [me.capabilities]);
  const [active, setActive] = useState(items.find((i) => i.key === "hotlist")?.key ?? items[0]?.key);
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
              <button key={i.key} className="nav" aria-current={i.key === active ? "page" : undefined} onClick={() => setActive(i.key)}>{i.label}</button>
            ))}
          </div>
        ))}
        <div className="sidefoot">{me.displayName}<small>{me.roles.map((r) => r.label).join(", ")}</small>
          <button className="nav" onClick={onSignOut}>Sign out</button></div>
      </aside>
      <main className="main">
        <div className="top"><span className="rolepill">{me.roles.map((r) => r.label).join(" · ")}</span></div>
        <div className="content">
          {!current ? <p className="empty">Your role has no screens yet.</p>
            : current.key === "hotlist" || current.key === "candidates" ? <HotList />
            : current.key === "access" ? <AccessPage me={me} />
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
