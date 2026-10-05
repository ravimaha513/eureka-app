import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  BadgeCheck, BookOpen, BriefcaseBusiness, Building2, CalendarClock, ChevronDown, Database, FileBarChart, FileCheck2, FolderOpen, Flame, LayoutDashboard, LogOut, MessageCircle, Moon,
  GraduationCap, House, Send, Settings, ShieldCheck, Sun, TrendingUp, Users, UserRoundCheck, UserRoundSearch, Wallet, type LucideIcon,
} from "lucide-react";
import type { Theme } from "./theme";

/** One icon per screen in the sidebar (decorative; the label carries the name). */
export const NAV_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard, hotlist: Flame, candidates: Users, submissions: Send, interviews: CalendarClock,
  placements: BadgeCheck, paperwork: FileCheck2, employees: UserRoundCheck, payments: Wallet,
  companies: Building2, facilities: House, performance: TrendingUp, reports: FileBarChart, access: ShieldCheck, settings: Settings,
  // datahub
  datahub: Database,
  // training
  training: GraduationCap, courses: BookOpen,
  // chat
  chat: MessageCircle,
  // jobs-portal
  jobs: BriefcaseBusiness, applications: FolderOpen, applicants: UserRoundSearch,
};

const TINTS = ["indigo", "teal", "amber", "rose", "violet", "sky"] as const;

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0]![0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "")).toUpperCase();
}

/**
 * Initials in a tinted circle; the tint is stable for a name. The initials are drawn by CSS
 * (attr), so they never join the text of a table cell or a button's name.
 */
export function Avatar({ name, size = "md" }: { name: string | null | undefined; size?: "sm" | "md" }) {
  let h = 0;
  for (const ch of name ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return <span className={`avatar ${size} tint-${TINTS[h % TINTS.length]}`} data-initials={initials(name)} aria-hidden="true" />;
}

/** A name with its avatar, for table cells. */
export function Person({ name, children }: { name: string | null | undefined; children: ReactNode }) {
  return <span className="person"><Avatar name={name} size="sm" /><span className="persontext">{children}</span></span>;
}

/** Light / Dark segmented switch at the foot of the sidebar. */
export function ThemeSwitch({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="themeswitch" role="group" aria-label="Theme">
      <button type="button" aria-pressed={theme === "light"} onClick={() => onChange("light")}><Sun size={15} aria-hidden="true" /><span>Light</span></button>
      <button type="button" aria-pressed={theme === "dark"} onClick={() => onChange("dark")}><Moon size={15} aria-hidden="true" /><span>Dark</span></button>
    </div>
  );
}

/** The signed-in user in the top bar; opens a small panel with Sign out. */
export function UserMenu({ name, roles, onSignOut, onSettings }: { name: string; roles: string; onSignOut: () => void; onSettings?: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="usermenu" ref={wrap}>
      <button ref={btn} type="button" className="userchip" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        aria-label={`Account: ${name}`}>
        <Avatar name={name} />
        <span className="userchip-text"><b>{name}</b><small>{roles}</small></span>
        <ChevronDown size={16} aria-hidden="true" className="userchip-caret" />
      </button>
      {open && (
        <div id={id} className="userpanel">
          <div className="userpanel-head"><Avatar name={name} /><span><b>{name}</b><small>{roles}</small></span></div>
          {onSettings && <button type="button" className="userpanel-item" onClick={() => { setOpen(false); onSettings(); }}><Settings size={16} aria-hidden="true" />Settings</button>}
          <button type="button" className="userpanel-item" onClick={onSignOut}><LogOut size={16} aria-hidden="true" />Sign out</button>
        </div>
      )}
    </div>
  );
}
