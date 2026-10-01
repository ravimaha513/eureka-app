import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * Recharts wrappers for the dashboard. Each chart sits in a role="img" figure with a text
 * alternative, because the SVG itself is not readable by assistive technology; the data
 * tables stay on the page for exact values.
 */

/** Categorical palette, readable on white and distinguishable in grayscale order. */
export const PALETTE = ["#4f46e5", "#0891b2", "#f59e0b", "#e11d48", "#16a34a", "#9333ea", "#64748b"];
const AXIS = { fontSize: 11, fill: "#64748b" };
const GRID = "#eef0f3";

const shortDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Figure({ label, height, children }: { label: string; height: number; children: ReactNode }) {
  return (
    <div className="chart" role="img" aria-label={label} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height }}>{children as never}</ResponsiveContainer>
    </div>
  );
}

export interface Series { key: string; label: string; color: string }

/** Lines over time, one per series. `data` rows carry `date` and a value per series key. */
export function TrendChart({ data, series, label }: { data: ({ date: string } & Record<string, number | string>)[]; series: Series[]; label: string }) {
  const total = (k: string) => data.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  return (
    <Figure height={260} label={`${label}: ${series.map((s) => `${s.label} ${total(s.key)} in total`).join(", ")}`}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDay} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
        <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
        <Tooltip labelFormatter={(d) => shortDay(String(d))} />
                {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color}
            strokeWidth={2} dot={data.length <= 14} activeDot={{ r: 4 }} isAnimationActive={false} />
        ))}
      </LineChart>
    </Figure>
  );
}

/** A donut of parts of a whole: total in the middle, an HTML legend beside it. */
export function PieShare({ parts, label, centre }: { parts: { key: string; label: string; value: number }[]; label: string; centre: string }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const colour = (key: string) => PALETTE[Math.max(0, parts.findIndex((p) => p.key === key)) % PALETTE.length]!;
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div className="piefig" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
      <div className="piewrap">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 180, height: 180 }}>
          <PieChart>
            <Pie data={shown.length ? shown : [{ key: "none", label: "No data", value: 1 }]} dataKey="value" nameKey="label"
              innerRadius="62%" outerRadius="100%" paddingAngle={shown.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
              {shown.length ? shown.map((p) => <Cell key={p.key} fill={colour(p.key)} />) : <Cell fill={GRID} />}
            </Pie>
            {shown.length > 0 && <Tooltip />}
          </PieChart>
        </ResponsiveContainer>
        <div className="piecentre"><b>{total}</b><span>{centre}</span></div>
      </div>
      <div className="legend" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key} className="legenditem"><i className="swatch" style={{ background: colour(p.key) }} />{p.label} <b>{p.value}</b></span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal funnel bars, one colour per stage. */
export function FunnelBars({ stages, label }: { stages: { key: string; label: string; value: number }[]; label: string }) {
  return (
    <Figure height={Math.max(120, stages.length * 44)} label={`${label}: ${stages.map((s) => `${s.label} ${s.value}`).join(", ")}`}>
      <BarChart data={stages} layout="vertical" margin={{ top: 0, right: 28, bottom: 0, left: 8 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" width={118} tick={{ ...AXIS, fill: "#334155" }} tickLine={false} axisLine={false} />
        <Tooltip cursor={{ fill: GRID }} />
        <Bar dataKey="value" name="Count" radius={4} barSize={18} isAnimationActive={false} label={{ position: "right", fontSize: 12, fill: "#0f172a" }}>
          {stages.map((s, i) => <Cell key={s.key} fill={PALETTE[i % PALETTE.length]} />)}
        </Bar>
      </BarChart>
    </Figure>
  );
}
