import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Me } from "../api";
import { useSearchParams } from "../lib/router";
import { Tabs } from "../ui/Tabs";
import { adminApi } from "./adminApi";
import { AccessContext, keys } from "./shared";
import { USER_FILTER_KEYS, UsersTab } from "./UsersTab";
import { ApprovalsTab } from "./ApprovalsTab";
import { TeamsTab } from "./TeamsTab";
import { LocationsTab } from "./LocationsTab";
import { RolesTab } from "./RolesTab";
import { OrgChartTab } from "./OrgChartTab";
import "./admin.css";

const TABS = [
  { key: "users", label: "Users" },
  { key: "approvals", label: "Approvals" },
  { key: "teams", label: "Teams" },
  { key: "locations", label: "Locations" },
  { key: "roles", label: "Roles" },
  { key: "orgchart", label: "Org chart" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const PARAMS = ["tab", ...USER_FILTER_KEYS] as const;

/** Users & Access (capability `access:manage`). The API enforces every rule; this screen explains them. */
export function AccessPage({ me, initialTab = "users" }: { me: Me; initialTab?: TabKey }) {
  // The open tab and the Users filters live in the URL (?tab=approvals, ?team=none&status=active).
  const [params, setParams] = useSearchParams(PARAMS);
  const tab: TabKey = TABS.some((t) => t.key === params.tab) ? (params.tab as TabKey) : initialTab;
  const selectTab = (k: TabKey) => setParams({ tab: k === initialTab ? "" : k });
  const [message, setMessage] = useState("");
  // Re-announce identical messages: clear first, then set shortly after.
  const announce = useCallback((msg: string) => {
    setMessage("");
    setTimeout(() => setMessage(msg), 30);
  }, []);
  const ctx = useMemo(() => ({ me, announce }), [me, announce]);
  // Same query (and cache entry) as the Approvals tab's default "Pending" view: the tab shows how many wait.
  const pending = useQuery({ queryKey: [...keys.requests, "pending"], queryFn: () => adminApi.roleRequests("pending") });
  const pendingCount = pending.data?.items.length ?? 0;
  const tabs = TABS.map((t) => (t.key === "approvals" && pendingCount > 0
    ? { key: t.key, label: <>{t.label}<span className="sr-only">, pending:</span></>, count: pendingCount }
    : { key: t.key, label: t.label }));

  return (
    <AccessContext.Provider value={ctx}>
      <div className="pagehead ua-head">
        <div>
          <h1>Users &amp; Access</h1>
          <p className="sub">Create people, grant and revoke roles, manage teams and define roles. You can't change your own access; restricted roles need a second admin.</p>
        </div>
      </div>
      <div className="livemsg" role="status" aria-live="polite">{message}</div>
      <Tabs label="Users & Access sections" tabs={tabs} value={tab} onChange={selectTab} className="ua-tabs" panelClassName="panel ua-panel">
        {(active) => active === "users" ? <UsersTab />
          : active === "approvals" ? <ApprovalsTab />
          : active === "teams" ? <TeamsTab onShowUnassigned={() => setParams({
            tab: initialTab === "users" ? "" : "users", q: "", dept: "", role: "", loc: "", team: "none", status: "active",
          })} />
          : active === "locations" ? <LocationsTab />
          : active === "roles" ? <RolesTab />
          : <OrgChartTab />}
      </Tabs>
    </AccessContext.Provider>
  );
}
