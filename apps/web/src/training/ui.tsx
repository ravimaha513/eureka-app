import {
  BookOpen, ChartColumn, Cloud, Code, Database, GraduationCap, Shield, Users, type LucideIcon,
} from "lucide-react";
import { BATCH_STATUS_LABELS, COVER_COLORS, COVER_ICONS, ICON_LABELS, type Cover } from "./trainingApi";
import { Field } from "../sales/ui";

export const COVER_ICON_MAP: Record<string, LucideIcon> = {
  book: BookOpen, code: Code, database: Database, cloud: Cloud, shield: Shield, chart: ChartColumn, users: Users, cap: GraduationCap,
};

/** Tinted cover with its icon (decorative; the card carries the name). */
export function CoverArt({ cover, caption, size = "md" }: { cover: Cover; caption?: string; size?: "sm" | "md" }) {
  const Icon = COVER_ICON_MAP[cover.icon] ?? BookOpen;
  const tint = (COVER_COLORS as readonly string[]).includes(cover.color) ? cover.color : "indigo";
  return (
    <div className={`tr-cover ${size} tint-${tint}`} aria-hidden="true">
      <Icon size={size === "sm" ? 18 : 26} strokeWidth={1.7} />
      {caption && size === "md" && <span>{caption}</span>}
    </div>
  );
}

export const BatchStatusPill = ({ status }: { status: string }) =>
  <span className={`badge tr-${status}`}>{BATCH_STATUS_LABELS[status] ?? status}</span>;

/** A labelled progress bar (role=progressbar) with the percentage beside it. */
export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <span className="tr-progress">
      <span className="tr-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}>
        <span className={p === 100 ? "done" : undefined} style={{ width: `${p}%` }} />
      </span>
      <b>{p}%</b>
    </span>
  );
}

/** Cover colour and icon pickers for the batch and course dialogs. */
export function CoverPicker({ value, onChange }: { value: Cover; onChange: (c: Cover) => void }) {
  return (
    <div className="grid2">
      <Field label="Cover colour">
        {(p) => (
          <select {...p} value={value.color} onChange={(e) => onChange({ ...value, color: e.target.value })}>
            {COVER_COLORS.map((c) => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
          </select>
        )}
      </Field>
      <Field label="Cover icon">
        {(p) => (
          <select {...p} value={value.icon} onChange={(e) => onChange({ ...value, icon: e.target.value })}>
            {COVER_ICONS.map((i) => <option key={i} value={i}>{ICON_LABELS[i]}</option>)}
          </select>
        )}
      </Field>
    </div>
  );
}

const DAY = 86_400_000;
const dayStart = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
};

/**
 * Where a batch is in its calendar (client-side, from startDate/endDate): "Week 3 of 8" and the
 * share of the planned days elapsed. Not student progress: the batch list API does not return it.
 * `pct` is null when there is no end date to measure against.
 */
export function schedule(b: { status: string; startDate: string; endDate: string | null }, now = new Date()): { label: string; pct: number | null } | null {
  if (b.status === "cancelled") return null;
  if (b.status === "completed") return { label: "Finished", pct: 100 };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start = dayStart(b.startDate);
  if (today < start) {
    const days = Math.round((start - today) / DAY);
    return { label: days === 1 ? "Starts tomorrow" : `Starts in ${days} days`, pct: b.endDate ? 0 : null };
  }
  const week = Math.floor((today - start) / DAY / 7) + 1;
  if (!b.endDate) return { label: `Week ${week}`, pct: null };
  const end = dayStart(b.endDate);
  const total = Math.max(1, Math.ceil((end - start + DAY) / DAY / 7));
  const pct = Math.max(0, Math.min(100, Math.round(((today - start) / Math.max(DAY, end - start)) * 100)));
  return { label: today > end ? "Past end date" : `Week ${Math.min(week, total)} of ${total}`, pct };
}

/** Elapsed share of a batch's calendar (0–100), or null without an end date / before start. For "behind" flags. */
export function elapsedPercent(b: { startDate: string; endDate: string | null }, now = new Date()): number | null {
  if (!b.endDate) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start = dayStart(b.startDate), end = dayStart(b.endDate);
  if (today < start) return null;
  return Math.max(0, Math.min(100, Math.round(((today - start) / Math.max(DAY, end - start)) * 100)));
}
