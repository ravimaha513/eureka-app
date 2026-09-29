import { useCallback, useMemo, useRef, useState } from "react";
import type { Me } from "../api";
import { AccessContext } from "./shared";
import { UsersTab } from "./UsersTab";
import { ApprovalsTab } from "./ApprovalsTab";
import { TeamsTab } from "./TeamsTab";

const TABS = [
  { key: "users", label: "Users" },
  { key: "approvals", label: "Approvals" },
  { key: "teams", label: "Teams" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** Users & Access (capability `access:manage`). The API enforces every rule; this screen explains them. */
export function AccessPage({ me, initialTab = "users" }: { me: Me; initialTab?: TabKey }) {
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [message, setMessage] = useState("");
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Re-announce identical messages: clear first, then set shortly after.
  const announce = useCallback((msg: string) => {
    setMessage("");
    setTimeout(() => setMessage(msg), 30);
  }, []);
  const ctx = useMemo(() => ({ me, announce }), [me, announce]);

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const target = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : delta ? (i + delta + TABS.length) % TABS.length : -1;
    if (target < 0) return;
    e.preventDefault();
    const next = TABS[target]!.key;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <AccessContext.Provider value={ctx}>
      <div>
        <h1>Users &amp; Access</h1>
        <p className="sub">Create people, grant and revoke roles, and manage teams. You can't change your own access; restricted roles need a second admin.</p>
      </div>
      <div className="tabs" role="tablist" aria-label="Users & Access sections">
        {TABS.map((t, i) => (
          <button key={t.key} ref={(el) => { tabRefs.current[t.key] = el; }} className="tab" role="tab" id={`access-tab-${t.key}`}
            aria-selected={tab === t.key} aria-controls={`access-panel-${t.key}`} tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)} onKeyDown={(e) => onTabKey(e, i)}>{t.label}</button>
        ))}
      </div>
      <div className="livemsg" role="status" aria-live="polite">{message}</div>
      <section role="tabpanel" id={`access-panel-${tab}`} aria-labelledby={`access-tab-${tab}`} className="panel">
        {tab === "users" ? <UsersTab /> : tab === "approvals" ? <ApprovalsTab /> : <TeamsTab />}
      </section>
    </AccessContext.Provider>
  );
}
