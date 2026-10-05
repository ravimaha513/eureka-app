import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Building2, House, type LucideIcon } from "lucide-react";
import { BILL_STATUS_LABELS, type BillStatus, type SiteKind } from "./sitesApi";

/** Words used on screen for each kind of site. */
export const KIND: Record<SiteKind, { one: string; One: string; many: string; Many: string; icon: LucideIcon; tint: string }> = {
  companies: { one: "company", One: "Company", many: "companies", Many: "Companies", icon: Building2, tint: "indigo" },
  facilities: { one: "facility", One: "Facility", many: "facilities", Many: "Facilities", icon: House, tint: "teal" },
};

/** The tinted icon avatar next to a company or facility name (decorative). */
export function SiteIcon({ kind, size = "sm" }: { kind: SiteKind; size?: "sm" | "lg" }) {
  const { icon: Icon, tint } = KIND[kind];
  return <span className={`siteicon ${size} tint-${tint}`} aria-hidden="true"><Icon size={size === "lg" ? 24 : 16} strokeWidth={1.9} /></span>;
}

export const StatusPill = ({ status }: { status: string }) =>
  <span className={`badge pill ${status === "active" ? "active" : "inactive"}`}>{status === "active" ? "Active" : "Inactive"}</span>;

export const BillStatusPill = ({ status }: { status: BillStatus }) =>
  <span className={`badge pill bill-${status}`}>{BILL_STATUS_LABELS[status] ?? status}</span>;

/** A KPI card: tinted icon on top, label, big value, a hint. */
export function Kpi({ icon: Icon, tint, label, value, hint }: { icon: LucideIcon; tint: string; label: string; value: ReactNode; hint?: string }) {
  return (
    <li className="tile card kpi">
      <span className={`tileicon tint-${tint}`}><Icon size={18} strokeWidth={1.9} aria-hidden="true" /></span>
      <span className="tilelabel">{label}</span>
      <span className="tilevalue">{value}</span>
      {hint && <span className="tilehint">{hint}</span>}
    </li>
  );
}

/** An input with a decorative icon (or a text prefix like "$") inside it. */
export function IconInput({ icon: Icon, prefix, children }: { icon?: LucideIcon; prefix?: string; children: ReactNode }) {
  return (
    <span className="iconinput">
      {Icon ? <Icon className="inicon" size={16} aria-hidden="true" /> : <span className="inicon prefix" aria-hidden="true">{prefix}</span>}
      {children}
    </span>
  );
}

/**
 * Dialogs opened from inside the details drawer are portaled to the body and tell the
 * drawer they are on top, so the drawer leaves focus and Escape to them.
 */
interface LayerApi { enter: () => void; leave: () => void }
const LayerContext = createContext<LayerApi | null>(null);

export function useLayers() {
  const count = useRef(0);
  const [open, setOpen] = useState(0);
  const api = useRef<LayerApi>({
    enter: () => { count.current += 1; setOpen(count.current); },
    leave: () => { count.current = Math.max(0, count.current - 1); setOpen(count.current); },
  }).current;
  return { api, open: open > 0, isOpen: () => count.current > 0 };
}

export const LayerProvider = ({ api, children }: { api: LayerApi; children: ReactNode }) =>
  <LayerContext.Provider value={api}>{children}</LayerContext.Provider>;

export function Layer({ children }: { children: ReactNode }) {
  const api = useContext(LayerContext);
  // A layout effect runs before the dialog's own (passive) focus effect.
  useLayoutEffect(() => {
    api?.enter();
    return () => api?.leave();
  }, [api]);
  return api ? createPortal(children, document.body) : <>{children}</>;
}

/** Pill tabs (ARIA tabs pattern, arrow keys move between them). */
export function PillTabs<T extends string>({ tabs, value, onChange, label, idPrefix }: {
  tabs: { key: T; label: string }[]; value: T; onChange: (t: T) => void; label: string; idPrefix: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const target = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : delta ? (i + delta + tabs.length) % tabs.length : -1;
    if (target < 0) return;
    e.preventDefault();
    const next = tabs[target]!.key;
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="tabs wrap pilltabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button key={t.key} ref={(el) => { refs.current[t.key] = el; }} type="button" className="tab" role="tab" id={`${idPrefix}-tab-${t.key}`}
          aria-selected={value === t.key} aria-controls={`${idPrefix}-panel`} tabIndex={value === t.key ? 0 : -1}
          onClick={() => onChange(t.key)} onKeyDown={(e) => onKey(e, i)}>{t.label}</button>
      ))}
    </div>
  );
}
