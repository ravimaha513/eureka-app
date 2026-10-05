import { useEffect, useId, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { BedDouble, Building2, CircleCheck, Download, House, Plus, Receipt, Search, Users, Wallet } from "lucide-react";
import type { Me } from "../api";
import { PALETTE, PieShare, TrendChart } from "../dashboard/Charts";
import { fmtDate } from "../sales/ui";
import { EditSiteDialog, SiteFormDialog } from "./SiteFormDialog";
import { SiteDrawer } from "./SiteDrawer";
import {
  exportUrl, fmtMoney, fmtMoneyShort, fmtMonth, fmtRent, last12Months, num, siteKeys, sitesApi, sitesError, utilityLabel,
  type BillsSummary, type Company, type CompanyStats, type Facility, type FacilityStats, type Site, type SiteKind,
} from "./sitesApi";
import { KIND, Kpi, SiteIcon, StatusPill } from "./ui";

const PAGE_SIZE = 25;

export const CompaniesPage = ({ me }: { me: Pick<Me, "capabilities" | "roles"> }) => <SitesPage kind="companies" me={me} />;
export const FacilitiesPage = ({ me }: { me: Pick<Me, "capabilities" | "roles"> }) => <SitesPage kind="facilities" me={me} />;

/**
 * Companies (the group's own entities) or facilities (rented guest houses) of the
 * caller's locations: KPI cards, the list with search, export and pagination, bill
 * charts, and a details drawer. Add and Edit show only with company:manage /
 * facility:manage; the API decides every action.
 */
export function SitesPage({ kind, me }: { kind: SiteKind; me: Pick<Me, "capabilities" | "roles"> }) {
  const k = KIND[kind];
  const id = useId();
  const qc = useQueryClient();
  const caps = new Set(me.capabilities);
  const canManage = caps.has(kind === "companies" ? "company:manage" : "facility:manage");
  const canBills = caps.has("bill:read");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const page = cursors.length - 1;

  useEffect(() => {
    const t = setTimeout(() => { setSearch(text.trim()); setCursors([null]); }, 300);
    return () => clearTimeout(t);
  }, [text]);

  const filters = { q: search, limit: PAGE_SIZE, cursor: cursors[page] ?? "" };
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
        {canManage && (
          <button type="button" className="btn primary push" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />Add {k.one}</button>
        )}
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

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <section className="card listcard" aria-labelledby={`${id}-title`}>
        <div className="cardhead">
          <h2 id={`${id}-title`}>{k.Many} List</h2>
          <div className="cardtools">
            <div className="searchbox">
              <Search size={16} className="inicon" aria-hidden="true" />
              <label htmlFor={`${id}-q`} className="sr-only">Search {k.many}</label>
              <input id={`${id}-q`} type="search" placeholder="Search" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
            </div>
            <a className="btn outline" href={exportUrl(kind)} download><Download size={16} aria-hidden="true" />Export<span className="sr-only"> {k.many} as CSV</span></a>
          </div>
        </div>
        {list.isLoading ? <p className="empty">Loading…</p> : list.error ? (
          <p className="empty error" role="alert">{sitesError(list.error, k.one)} <button type="button" className="btn sm" onClick={() => void list.refetch()}>Retry</button></p>
        ) : (
          <div className="tablewrap"><table aria-label={k.Many} aria-busy={list.isFetching || undefined}>
            <thead><tr>
              <th scope="col">{k.One}</th><th scope="col">State</th><th scope="col">Zip</th>
              {kind === "facilities" && <><th scope="col" className="num">Rent</th><th scope="col" className="num">Capacity</th><th scope="col">Lease</th></>}
              <th scope="col">Incharge</th>
              {kind === "companies" && <th scope="col" className="num">Employees</th>}
              <th scope="col">Status</th>
              {canManage && <th scope="col"><span className="sr-only">Actions</span></th>}
            </tr></thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="clickrow" onClick={() => setOpenId(s.id)}>
                  <td>
                    <span className="person">
                      <SiteIcon kind={kind} />
                      <span className="persontext">
                        <button type="button" className="linkbtn" onClick={(e) => { e.stopPropagation(); setOpenId(s.id); }} aria-label={`Open ${k.one} ${s.name}`}><b>{s.name}</b></button>
                        <span className="block small">{[s.city, s.location.name].filter(Boolean).join(" · ")}</span>
                      </span>
                    </span>
                  </td>
                  <td>{s.state ?? <span className="muted">—</span>}</td>
                  <td>{s.zip ?? <span className="muted">—</span>}</td>
                  {kind === "facilities" && (() => {
                    const f = s as Facility;
                    return (
                      <>
                        <td className="num">{fmtRent(f)}</td>
                        <td className="num">{f.capacity ?? "—"}{f.beds !== null && f.beds !== undefined && <span className="block small">{f.beds} beds</span>}</td>
                        <td>{f.startDate ? fmtDate(f.startDate) : "—"}<span className="block small">{f.endDate ? `to ${fmtDate(f.endDate)}` : "open-ended"}</span></td>
                      </>
                    );
                  })()}
                  <td>{s.incharges.length ? s.incharges.map((u) => u.name).join(", ") : <span className="muted">None</span>}</td>
                  {kind === "companies" && <td className="num">{(s as Company).employeeCount}</td>}
                  <td><StatusPill status={s.status} /></td>
                  {canManage && (
                    <td className="rowactions">
                      <button type="button" className="linkbtn editlink" onClick={(e) => { e.stopPropagation(); setEditId(s.id); }} aria-label={`Edit ${k.one} ${s.name}`}>Edit</button>
                    </td>
                  )}
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={12} className="empty">{search ? `No ${k.many} match this search.` : `No ${k.many} yet.`}</td></tr>
              )}
            </tbody>
          </table></div>
        )}
        <div className="listfoot cardfoot">
          <p role="status" aria-live="polite" className="muted">{countMsg}</p>
          <nav className="pager" aria-label={`${k.One} pages`}>
            <button type="button" className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>Previous</button>
            <span>Page {page + 1}</span>
            <button type="button" className="btn sm" disabled={!list.data?.nextCursor || list.isPlaceholderData}
              onClick={() => { const nx = list.data?.nextCursor; if (nx) setCursors((c) => [...c, nx]); }}>Next</button>
          </nav>
        </div>
      </section>

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
                  <td><span className="person"><SiteIcon kind={kind} /><b>{o.name}</b></span></td>
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
