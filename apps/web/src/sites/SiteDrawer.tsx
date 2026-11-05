import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Pencil } from "lucide-react";
import type { Me } from "../api";
import { Drawer, fmtDate } from "../sales/ui";
import { BillsTab } from "./BillsTab";
import { EmployeesTab, InchargesTab } from "./PeopleTabs";
import { SiteFormDialog } from "./SiteFormDialog";
import { UtilitiesTab } from "./UtilitiesTab";
import {
  FEE_LABELS, addressLine, fmtRent, siteKeys, sitesApi, sitesError,
  type Company, type FacilityDetail, type Site, type SiteDetail, type SiteKind,
} from "./sitesApi";
import { KIND, Layer, LayerProvider, StatusPill, useLayers } from "./ui";
import { Tabs } from "../ui/Tabs";
import "./sites.css";
import { Loading } from "../ui/Loading";
import { fmtPhone } from "../payments/cells";

type TabKey = "overview" | "employees" | "incharges" | "utilities" | "bills";

/**
 * "Company details" / "Facility details": identity header (icon, name, status, address)
 * and pill tabs. Dialogs opened from a tab sit on top of the drawer (see Layer).
 */
export function SiteDrawer({ kind, id, initial, me, onClose, onNotice }: {
  kind: SiteKind; id: string; initial: Site | null; me: Pick<Me, "capabilities" | "roles">; onClose: () => void; onNotice: (m: string) => void;
}) {
  const qc = useQueryClient();
  const k = KIND[kind];
  const layers = useLayers();
  const [tab, setTab] = useState<TabKey>("overview");
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: siteKeys.detail(kind, id), queryFn: () => sitesApi.get(kind, id) });
  const caps = new Set(me.capabilities);
  const s: (Site & Partial<SiteDetail>) | undefined = q.data ?? initial ?? undefined;
  const canManage = q.data ? q.data.actions.manage : false;
  const tabs: { key: TabKey; label: string }[] = [
    { key: "overview", label: "Overview" },
    ...(kind === "companies" ? [{ key: "employees" as const, label: "Employees" }] : []),
    { key: "incharges", label: "Incharges" },
    ...(caps.has("utility:read") ? [{ key: "utilities" as const, label: "Utilities" }] : []),
    ...(caps.has("bill:read") ? [{ key: "bills" as const, label: "Bills" }] : []),
  ];

  return (
    <LayerProvider api={layers.api}>
      <Drawer title={s?.name ?? `${k.One} details`} onClose={onClose} wide closeLabel={`Close ${k.one} details`}
        suspended={layers.open || editing} isSuspended={layers.isOpen}>
        {!s ? (
          q.isLoading ? <Loading /> : <p className="error" role="alert">{sitesError(q.error, k.one)}</p>
        ) : (
          <>
            {/* Action strip: status and where it is, then Edit; the record name is the drawer title. */}
            <div className="actionstrip sitehead si-strip">
              <div className="as-status">
                <StatusPill status={s.status} />
                <span className="as-note addr"><MapPin size={14} aria-hidden="true" /><span>{addressLine(s) || "No address"}</span></span>
                {!addressLine(s).includes(s.location.name) && <span className="as-note">{s.location.name}</span>}
              </div>
              {canManage && (
                <div className="as-actions">
                  <button type="button" className="btn" onClick={() => setEditing(true)} aria-label={`Edit ${k.one} ${s.name}`}>
                    <Pencil size={14} aria-hidden="true" />Edit
                  </button>
                </div>
              )}
            </div>
            <Tabs label={`${k.One} sections`} tabs={tabs} value={tab} onChange={setTab} className="si-tabs" panelClassName="panel">
              {(t) => t === "overview" ? <Overview kind={kind} s={s} loaded={Boolean(q.data)} error={q.error} />
                : t === "employees" ? <EmployeesTab companyId={id} canManage={canManage && caps.has("company:manage")} />
                : t === "incharges" ? <InchargesTab kind={kind} ownerId={id} canManage={canManage} />
                : t === "utilities" ? <UtilitiesTab kind={kind} ownerId={id} canManage={caps.has("utility:manage")} canReveal={caps.has("utility.secret:read")} />
                : <BillsTab kind={kind} ownerId={id} canManage={caps.has("bill:manage")} />}
            </Tabs>
          </>
        )}
      </Drawer>
      {editing && q.data && (
        <Layer>
          <SiteFormDialog kind={kind} me={me} record={q.data} onClose={() => setEditing(false)}
            onSaved={(m) => {
              setEditing(false); onNotice(m);
              void qc.invalidateQueries({ queryKey: siteKeys.all(kind) });
            }} />
        </Layer>
      )}
    </LayerProvider>
  );
}

function Overview({ kind, s, loaded, error }: { kind: SiteKind; s: Site & Partial<SiteDetail>; loaded: boolean; error: unknown }) {
  const f = s as Partial<FacilityDetail>;
  return (
    <div className="tabpanel">
      <dl className="facts">
        <dt>Incharges</dt><dd>{s.incharges.length ? s.incharges.map((u) => u.name).join(", ") : "None"}</dd>
        {kind === "companies" && <><dt>Employees</dt><dd>{(s as Company).employeeCount}</dd></>}
        {kind === "facilities" && (
          <>
            <dt>Rent</dt><dd>{fmtRent(f as FacilityDetail)}{f.feeFrequency ? ` · ${FEE_LABELS[f.feeFrequency]}` : ""}</dd>
            <dt>Capacity</dt><dd>{f.capacity ?? "—"}{f.capacity !== null && f.capacity !== undefined ? " people" : ""}</dd>
            <dt>Beds / baths</dt><dd>{f.beds ?? "—"} / {f.baths === null || f.baths === undefined ? "—" : Number(f.baths)}</dd>
            <dt>Lease</dt><dd>{fmtDate(f.startDate)} – {f.endDate ? fmtDate(f.endDate) : "open"}</dd>
            {loaded && (
              <>
                <dt>Owner</dt><dd>{f.ownerName ?? "—"}</dd>
                <dt>Owner email</dt><dd>{f.ownerEmail ? <a href={`mailto:${f.ownerEmail}`}>{f.ownerEmail}</a> : "—"}</dd>
                <dt>Owner phone</dt><dd>{f.ownerPhone ? <a href={`tel:${f.ownerPhone}`}>{fmtPhone(f.ownerPhone)}</a> : "—"}</dd>
              </>
            )}
          </>
        )}
        {loaded && <><dt>Added</dt><dd>{fmtDate(s.createdAt)}</dd></>}
      </dl>
      {loaded ? (s.notes ? <><h3 className="minihead">Notes</h3><p className="notes">{s.notes}</p></> : null)
        : error ? <p className="error" role="alert">{sitesError(error)}</p> : <p className="muted">Loading details…</p>}
    </div>
  );
}
