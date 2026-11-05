import { useEffect, useId, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { BedDouble, Building2, CircleCheck, Download, House, Plus, Receipt, Users, Wallet } from "lucide-react";
import type { Me } from "../api";
import { PALETTE, PieShare, TrendChart } from "../ui/Charts";
import { EditSiteDialog, SiteFormDialog } from "./SiteFormDialog";
import { SiteDrawer } from "./SiteDrawer";
import {
  exportUrl, fmtMoney, fmtMoneyShort, fmtMonth, fmtRent, last12Months, num, siteKeys, sitesApi, sitesError, utilityLabel,
  type BillsSummary, type Company, type CompanyStats, type Facility, type FacilityStats, type Site, type SiteKind,
} from "./sitesApi";
import { KIND, Kpi, StatusPill } from "./ui";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import { FilterBar } from "../ui/FilterBar";
import { useRoutedId, useSearchParams } from "../lib/router";
import { fmtDay, fromControl } from "../payments/cells";
import "./sites.css";

const PAGE_SIZE = 25;

type PageProps = { me: Pick<Me, "capabilities" | "roles">; initialOpenId?: string | null; onOpenChange?: (id: string | null) => void };
export const CompaniesPage = (p: PageProps) => <SitesPage kind="companies" {...p} />;
export const FacilitiesPage = (p: PageProps) => <SitesPage kind="facilities" {...p} />;

/**
 * Companies (the group's own entities) or facilities (rented guest houses) of the
 * caller's locations: KPI cards, the list with search, export and pagination, bill
 * charts, and a details drawer. Add and Edit show only with company:manage /
 * facility:manage; the API decides every action.
 */
export function SitesPage({ kind, me, initialOpenId = null, onOpenChange }: { kind: SiteKind } & PageProps) {
  const k = KIND[kind];
  const id = useId();
  const qc = useQueryClient();
  const caps = new Set(me.capabilities);
  const canManage = caps.has(kind === "companies" ? "company:manage" : "facility:manage");
  const canBills = caps.has("bill:read");
  const [p, setP] = useSearchParams(["q", "status"] as const);
  const search = p.q;
  const status = p.status === "active" || p.status === "inactive" ? p.status : "";
  const [text, setText] = useState(search);
  const pager = useCursorPager();
  const { page } = pager;
  const [openId, setOpenId] = useRoutedId(initialOpenId, onOpenChange);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    // Only a changed search resets paging; otherwise the mount-time run would undo an early Next.
    if (text.trim() === search) return;
    const t = setTimeout(() => { setP({ q: text.trim() }); pager.reset(); }, 300);
    return () => clearTimeout(t);
  }, [text, search]);

  const filters = { q: search, status, limit: PAGE_SIZE, cursor: pager.cursor ?? "" };
  const list = useQuery({
    queryKey: siteKeys.list(kind, filters),
    queryFn: () => sitesApi.list(kind, filters),
    placeholderData: keepPreviousData,
  });
  const stats = useQuery({ queryKey: siteKeys.stats(kind), queryFn: () => sitesApi.stats(kind) });
  const range = useMemo(() => last12Months(), []);
  const summary = useQuery({
    queryKey: siteKeys.summary(kind, range.from),
    queryFn: () => sitesApi.billsSummary(kind, { from: range.from, to: range.to, tz: range.tz }),
    enabled: canBills,
  });

  const items = (list.data?.items ?? []) as Site[];
  const billsBy = new Map((summary.data?.byOwner ?? []).map((o) => [o.id, o]));
  const saved = (m: string) => {
    setAdding(false); setEditId(null); setNotice(m);
    void qc.invalidateQueries({ queryKey: siteKeys.all(kind) });
  };
  const n = items.length;
  const countMsg = list.isLoading || list.error ? ""
    : `${n} ${n === 1 ? k.one : k.many} on page ${page + 1}${list.data?.nextCursor ? ", more on the next page" : ""}.`;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>{k.Many}</h1>
          <p className="sub">{kind === "companies"
            ? "The group's own companies and offices in your locations, with their employees, incharges, utilities and bills."
            : "Guest houses and other accommodation the group rents in your locations, with incharges, utilities and bills."}</p>
        </div>
        <div className="pageactions">
          {/* Export follows the search and status filter shown below (the API takes the same q and status). */}
          <a className="btn" href={exportUrl(kind, { q: search, status })} download>
            <Download size={16} aria-hidden="true" /><span className="btnlabel">{search || status ? "Export matches" : "Export"}</span><span className="sr-only"> {k.many} as CSV</span></a>
          {canManage && (
            <button type="button" className="btn primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />Add {k.one}</button>
          )}
        </div>
      </div>

      <section aria-label={`${k.Many} at a glance`}>
        <ul className="tiles kpis">
          {kind === "companies" ? <CompanyKpis s={stats.data as CompanyStats | undefined} /> : <FacilityKpis s={stats.data as FacilityStats | undefined} />}
          {canBills && (
            <Kpi icon={Receipt} tint="rose" label="Bills, last 12 months" value={summary.data ? fmtMoney(summary.data.totalAmount) : "…"}
              hint={summary.data ? `${summary.data.totalBills} bills · ${fmtMoney(summary.data.averagePerMonth)} a month on average` : undefined} />
          )}
        </ul>
      </section>

      <FilterBar label={`${k.One} filters`} hasFilters={Boolean(search || status)} onClear={() => { setText(""); setP({ q: "", status: "" }); pager.reset(); }}
        search={
          <div className="field inline fb-search">
            <label htmlFor={`${id}-q`}>Search {k.many}</label>
            <input id={`${id}-q`} type="search" placeholder="Name, city or zip" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
          </div>
        }
        primary={
          <div className="field inline">
            <label htmlFor={`${id}-st`}>Status</label>
            <select id={`${id}-st`} value={status} onChange={(e) => { setP({ status: e.target.value }); pager.reset(); }}>
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        }
        activeCount={status ? 1 : 0}
        chips={status ? [{ key: "status", label: `Status: ${status === "active" ? "Active" : "Inactive"}`, onRemove: () => { setP({ status: "" }); pager.reset(); } }] : []}
        moreCount={0}
        summaryEnd={!list.isLoading && !list.error ? <span className="muted si-count">{n}{list.data?.nextCursor ? "+" : ""} {n === 1 ? k.one : k.many}</span> : null} />

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <section className="card tablewrap listcard" aria-label={`${k.Many} list`}>
        {list.isLoading ? <Loading /> : list.error ? (
          <QueryError query={list} message={sitesError(list.error, k.one)} />
        ) : (
          <table className="dtable sitetable" aria-label={k.Many} aria-busy={list.isFetching || undefined}>
            <thead><tr>
              <th scope="col">{k.One}</th><th scope="col">Status</th><th scope="col">State</th><th scope="col">Zip</th>
              {kind === "facilities" && <><th scope="col" className="num">Rent</th><th scope="col" className="num">Capacity</th><th scope="col" className="p2">Lease</th></>}
              <th scope="col">Incharge</th>
              {kind === "companies" && <th scope="col" className="num">Employees</th>}
              {canBills && <th scope="col" className="num">Bills, 12 mo</th>}
              {canManage && <th scope="col" className="c-act"><span className="sr-only">Actions</span></th>}
            </tr></thead>
            <tbody>
              {items.map((s) => {
                const bills = billsBy.get(s.id);
                const place = s.city && s.city !== s.location.name ? `${s.city} · ${s.location.name}` : s.location.name;
                return (
                  <tr key={s.id} className="rowopen" onClick={(e) => { if (!fromControl(e)) setOpenId(s.id); }}>
                    <td className="c-primary">
                      <button type="button" className="linkbtn si-name" onClick={() => setOpenId(s.id)} aria-label={`Open ${k.one} ${s.name}`}><b>{s.name}</b></button>
                      <span className="block">{place}</span>
                    </td>
                    <td className="c-badge" data-label="Status"><StatusPill status={s.status} /></td>
                    <td data-label="State">{s.state ?? <span className="muted">—</span>}</td>
                    <td data-label="Zip">{s.zip ?? <span className="muted">—</span>}</td>
                    {kind === "facilities" && (() => {
                      const f = s as Facility;
                      return (
                        <>
                          <td className="num" data-label="Rent">{fmtRent(f)}</td>
                          <td className="num" data-label="Capacity">{f.capacity ?? "—"}{f.beds !== null && f.beds !== undefined && <span className="block">{f.beds} beds</span>}</td>
                          <td className="p2" data-label="Lease">{f.startDate ? fmtDay(f.startDate) : "—"}<span className="block">{f.endDate ? `to ${fmtDay(f.endDate)}` : "open-ended"}</span></td>
                        </>
                      );
                    })()}
                    <td data-label="Incharge">{s.incharges.length ? s.incharges.map((u) => u.name).join(", ") : <span className="muted">None</span>}</td>
                    {kind === "companies" && <td className="num" data-label="Employees">{(s as Company).employeeCount}</td>}
                    {canBills && <td className="num" data-label="Bills, 12 mo">{bills ? <>{fmtMoney(bills.amount)}<span className="block">{bills.count} {bills.count === 1 ? "bill" : "bills"}</span></> : <span className="muted">—</span>}</td>}
                    {canManage && (
                      <td className="c-act">
                        <button type="button" className="btn sm" onClick={() => setEditId(s.id)} aria-label={`Edit ${k.one} ${s.name}`}>Edit</button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr><td colSpan={12} className="empty">{search ? `No ${k.many} match this search.` : `No ${k.many} yet.`}</td></tr>
              )}
            </tbody>
          </table>
        )}
      </section>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <Pager pager={pager} label={`${k.One} pages`} nextCursor={list.data?.nextCursor} pending={list.isPlaceholderData} />
      </div>

      {canBills && (
        summary.error ? <p className="error" role="alert">{sitesError(summary.error)}</p>
          : <BillCharts kind={kind} summary={summary.data} months={range.months} />
      )}

      {openId && (
        <SiteDrawer kind={kind} id={openId} me={me} initial={items.find((s) => s.id === openId) ?? null}
          onClose={() => setOpenId(null)} onNotice={setNotice} />
      )}
      {adding && <SiteFormDialog kind={kind} me={me} record={null} onClose={() => setAdding(false)} onSaved={saved} />}
      {editId && <EditSiteDialog kind={kind} id={editId} me={me} onClose={() => setEditId(null)} onSaved={saved} />}
    </>
  );
}

const dash = (v: number | undefined) => (v === undefined ? "…" : v.toLocaleString("en-US"));

function CompanyKpis({ s }: { s: CompanyStats | undefined }) {
  return (
    <>
      <Kpi icon={Building2} tint="indigo" label="Total companies" value={dash(s?.total)} />
      <Kpi icon={CircleCheck} tint="teal" label="Active companies" value={dash(s?.active)} />
      <Kpi icon={Users} tint="amber" label="Employees assigned" value={dash(s?.employees)} />
    </>
  );
}

function FacilityKpis({ s }: { s: FacilityStats | undefined }) {
  return (
    <>
      <Kpi icon={House} tint="teal" label="Total facilities" value={dash(s?.total)} hint={s ? `${s.active} active` : undefined} />
      <Kpi icon={BedDouble} tint="violet" label="Capacity" value={dash(s?.capacity)} hint={s ? `${s.beds} beds` : undefined} />
      <Kpi icon={Wallet} tint="amber" label="Monthly rent" value={s ? fmtMoney(s.monthlyRent) : "…"} hint="Active facilities, as a monthly amount" />
    </>
  );
}

function BillCharts({ kind, summary, months }: { kind: SiteKind; summary: BillsSummary | undefined; months: string[] }) {
  const k = KIND[kind];
  if (!summary) return <p className="muted">Loading bill charts…</p>;
  const byMonth = new Map(summary.byMonth.map((m) => [m.month, num(m.amount)]));
  const trend = months.map((m) => ({ date: m, amount: byMonth.get(m) ?? 0 }));
  const types = [...summary.byType].sort((a, b) => num(b.amount) - num(a.amount));
  const owners = [...summary.byOwner].sort((a, b) => num(b.amount) - num(a.amount));
  const max = Math.max(1, ...owners.map((o) => num(o.amount)));
  return (
    <>
      <div className="chartgrid sitecharts">
        <section className="card chartcard" aria-labelledby={`${kind}-bym`}>
          <div><h2 id={`${kind}-bym`} className="charttitle">Bills by month</h2><p className="chartsub">Amount billed per month, last 12 months</p></div>
          <TrendChart data={trend} label="Bills by month" height={260}
            series={[{ key: "amount", label: "Amount", color: PALETTE[0]! }]}
            xFormat={fmtMonth} yFormat={fmtMoneyShort} valueFormat={(v) => fmtMoney(v)} />
        </section>
        <section className="card chartcard" aria-labelledby={`${kind}-byt`}>
          <div><h2 id={`${kind}-byt`} className="charttitle">Utility bills by type</h2><p className="chartsub">Share of the amount, last 12 months</p></div>
          {types.length === 0 ? <p className="muted">No bills in this period.</p> : (
            <PieShare label="Utility bills by type" centre="total"
              parts={types.map((t) => ({ key: t.utilityType, label: utilityLabel(t.utilityType), value: num(t.amount) }))}
              format={(v) => fmtMoney(v)} centreFormat={fmtMoneyShort} />
          )}
        </section>
      </div>
      <section className="card listcard" aria-labelledby={`${kind}-byo`}>
        <div className="cardhead"><h2 id={`${kind}-byo`}>Bills total by {k.one}</h2></div>
        {owners.length === 0 ? <p className="empty">No bills in this period.</p> : (
          <div className="tablewrap"><table aria-labelledby={`${kind}-byo`}>
            <thead><tr><th scope="col">{k.One}</th><th scope="col" className="num">Bills</th><th scope="col" className="num">Amount</th><th scope="col" className="sharecell"><span className="sr-only">Share</span></th></tr></thead>
            <tbody>
              {owners.map((o) => (
                <tr key={o.id}>
                  <td><b>{o.name}</b></td>
                  <td className="num">{o.count}</td>
                  <td className="num">{fmtMoney(o.amount)}</td>
                  <td className="sharecell"><span className="sharebar" aria-hidden="true"><span style={{ width: `${Math.round((num(o.amount) / max) * 100)}%` }} /></span></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
