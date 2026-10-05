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
import { KIND, Layer, LayerProvider, PillTabs, SiteIcon, StatusPill, useLayers } from "./ui";

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
  const panelId = `site-${id}`;

  return (
    <LayerProvider api={layers.api}>
      <Drawer title={`${k.One} details`} onClose={onClose} wide closeLabel={`Close ${k.one} details`}
        suspended={layers.open || editing} isSuspended={layers.isOpen}>
        {!s ? (
          q.isLoading ? <p className="empty">Loading…</p> : <p className="error" role="alert">{sitesError(q.error, k.one)}</p>
        ) : (
          <>
            <div className="sitehead">
              <SiteIcon kind={kind} size="lg" />
              <div className="siteheadtext">
                <div className="sitename"><b>{s.name}</b> <StatusPill status={s.status} /></div>
                <span className="addr"><MapPin size={14} aria-hidden="true" /><span>{addressLine(s) || "No address"}</span></span>
                <span className="muted small">{s.location.name}</span>
              </div>
              {canManage && (
                <button type="button" className="btn sm outline" onClick={() => setEditing(true)} aria-label={`Edit ${k.one} ${s.name}`}>
                  <Pencil size={14} aria-hidden="true" />Edit
                </button>
              )}
            </div>
            <PillTabs tabs={tabs} value={tab} onChange={setTab} label={`${k.One} sections`} idPrefix={panelId} />
            <section role="tabpanel" id={`${panelId}-panel`} aria-labelledby={`${panelId}-tab-${tab}`} className="panel">
              {tab === "overview" ? <Overview kind={kind} s={s} loaded={Boolean(q.data)} error={q.error} />
                : tab === "employees" ? <EmployeesTab companyId={id} canManage={canManage && caps.has("company:manage")} />
                : tab === "incharges" ? <InchargesTab kind={kind} ownerId={id} canManage={canManage} />
                : tab === "utilities" ? <UtilitiesTab kind={kind} ownerId={id} canManage={caps.has("utility:manage")} canReveal={caps.has("utility.secret:read")} />
                : <BillsTab kind={kind} ownerId={id} canManage={caps.has("bill:manage")} />}
            </section>
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
        <dt>Location</dt><dd>{s.location.name}</dd>
        <dt>Address</dt><dd>{addressLine(s) || "—"}</dd>
        <dt>Incharges</dt><dd>{s.incharges.length ? s.incharges.map((u) => u.name).join(", ") : "None"}</dd>
        {kind === "companies" && <><dt>Employees</dt><dd>{(s as Company).employeeCount}</dd></>}
        {kind === "facilities" && (
          <>
            <dt>Rent</dt><dd>{fmtRent(f as FacilityDetail)}{f.feeFrequency ? ` (${FEE_LABELS[f.feeFrequency].toLowerCase()})` : ""}</dd>
            <dt>Capacity</dt><dd>{f.capacity ?? "—"}{f.capacity !== null && f.capacity !== undefined ? " people" : ""}</dd>
            <dt>Beds / baths</dt><dd>{f.beds ?? "—"} / {f.baths === null || f.baths === undefined ? "—" : Number(f.baths)}</dd>
            <dt>Lease</dt><dd>{fmtDate(f.startDate)} – {f.endDate ? fmtDate(f.endDate) : "open"}</dd>
            {loaded && (
              <>
                <dt>Owner</dt><dd>{f.ownerName ?? "—"}</dd>
                <dt>Owner email</dt><dd>{f.ownerEmail ? <a href={`mailto:${f.ownerEmail}`}>{f.ownerEmail}</a> : "—"}</dd>
                <dt>Owner phone</dt><dd>{f.ownerPhone ? <a href={`tel:${f.ownerPhone}`}>{f.ownerPhone}</a> : "—"}</dd>
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
