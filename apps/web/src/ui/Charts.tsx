import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * Charts for the dashboard. Each chart sits in a role="img" figure with a text
 * alternative, because the SVG itself is not readable by assistive technology; the data
 * tables stay on the page for exact values. Axis, grid and tooltip colours come from
 * the theme (styles.css), so the charts follow light and dark mode.
 */

/**
 * Categorical palette: the `--chart-1..6` tokens (styles.css), redefined for dark theme, so a
 * series keeps its hue in both themes. Values are CSS `var()` strings, usable as SVG fill/stroke
 * and inline `background`. No red: red means error.
 */
export const PALETTE = [1, 2, 3, 4, 5, 6].map((n) => `var(--chart-${n})`);

const shortDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Figure({ label, height, children }: { label: string; height: number; children: ReactNode }) {
  return (
    <div className="chart" role="img" aria-label={label} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height }}>{children as never}</ResponsiveContainer>
    </div>
  );
}

export interface Series { key: string; label: string; color: string }

/** Smooth areas over time, one per series. `data` rows carry `date` and a value per series key. */
export function TrendChart({ data, series, label, xFormat = shortDay, yFormat, valueFormat, height = 280 }: {
  data: ({ date: string } & Record<string, number | string>)[]; series: Series[]; label: string;
  /** Tick and tooltip label of the x value (default: a short day, e.g. "Oct 5"). */
  xFormat?: (x: string) => string;
  /** Y-axis ticks, e.g. short money. */
  yFormat?: (n: number) => string;
  /** Values in the tooltip and the text alternative (default: the plain number). */
  valueFormat?: (n: number) => string;
  height?: number;
}) {
  const total = (k: string) => data.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  const fmt = valueFormat ?? String;
  return (
    <Figure height={height} label={`${label}: ${series.map((s) => `${s.label} ${fmt(total(s.key))} in total`).join(", ")}`}>
      <AreaChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: -14 }}>
        <CartesianGrid vertical={false} strokeDasharray="4 4" />
        <XAxis dataKey="date" tickFormatter={xFormat} tickLine={false} axisLine={false} minTickGap={24} dy={6} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={yFormat ? 56 : 44} tickFormatter={yFormat} />
        <Tooltip labelFormatter={(d) => xFormat(String(d))} cursor={{ strokeDasharray: "4 4" }}
          formatter={valueFormat ? (v) => valueFormat(Number(v)) : undefined} />
        {series.map((s) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2.25}
            fill={s.color} fillOpacity={0.08} dot={false} activeDot={{ r: 5, strokeWidth: 2 }} isAnimationActive={false} />
        ))}
      </AreaChart>
    </Figure>
  );
}

/** A donut of parts of a whole: total in the middle, a legend beside it. */
export function PieShare({ parts, label, centre, format = String, centreFormat }: {
  parts: { key: string; label: string; value: number }[]; label: string; centre: string;
  /** Values in the legend, tooltip and text alternative (e.g. money). */
  format?: (n: number) => string;
  /** The total in the middle (default: `format`). */
  centreFormat?: (n: number) => string;
}) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const colour = (key: string) => PALETTE[Math.max(0, parts.findIndex((p) => p.key === key)) % PALETTE.length]!;
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div className="piefig" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${format(p.value)}`).join(", ")}`}>
      <div className="piewrap">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 180, height: 180 }}>
          <PieChart>
            <Pie data={shown.length ? shown : [{ key: "none", label: "No data", value: 1 }]} dataKey="value" nameKey="label"
              innerRadius="70%" outerRadius="100%" paddingAngle={shown.length > 1 ? 3 : 0} cornerRadius={6} stroke="none" isAnimationActive={false}>
              {shown.length ? shown.map((p) => <Cell key={p.key} fill={colour(p.key)} />) : <Cell className="pieempty" />}
            </Pie>
            {shown.length > 0 && <Tooltip formatter={(v) => format(Number(v))} />}
          </PieChart>
        </ResponsiveContainer>
        <div className="piecentre"><b>{(centreFormat ?? format)(total)}</b><span>{centre}</span></div>
      </div>
      <div className="legend" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key} className="legenditem"><i className="swatch" style={{ background: colour(p.key) }} />{p.label} <b>{format(p.value)}</b></span>
        ))}
      </div>
    </div>
  );
}

/**
 * The pipeline as a funnel: one column per stage with its count on top, a flat band (solid
 * `--chart-n`) whose height follows the count, and smooth necks between stages.
 */
export function FunnelBars({ stages, label }: { stages: { key: string; label: string; value: number }[]; label: string }) {
  const W = 100 * stages.length, H = 200, mid = H / 2, neck = 26;
  const max = Math.max(1, ...stages.map((s) => s.value));
  const half = (v: number) => Math.max(8, (v / max) * (H / 2 - 6));
  // Each stage is a flat band; between stages a cubic curve narrows to the next height.
  const bandPath = (i: number, pad: number) => {
    const x0 = i * 100, x1 = x0 + 100;
    const h = half(stages[i]!.value) + pad;
    const next = i + 1 < stages.length ? half(stages[i + 1]!.value) + pad : h;
    const xs = x1 - neck;
    return `M${x0} ${mid - h} H${xs} C${x1 - neck / 2} ${mid - h} ${x1 - neck / 2} ${mid - next} ${x1} ${mid - next}`
      + ` V${mid + next} C${x1 - neck / 2} ${mid + next} ${x1 - neck / 2} ${mid + h} ${xs} ${mid + h} H${x0} Z`;
  };
  return (
    <div className="funnel" role="img" aria-label={`${label}: ${stages.map((s) => `${s.label} ${s.value}`).join(", ")}`}>
      <div className="funnelheads" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${stages.length}, 1fr)` }}>
        {stages.map((s) => <div key={s.key}><span>{s.label}</span><b>{s.value}</b></div>)}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {stages.map((s, i) => <path key={s.key} d={bandPath(i, 0)} fill={PALETTE[i % PALETTE.length]} />)}
        {stages.slice(1).map((s, i) => <line key={`l-${s.key}`} x1={(i + 1) * 100} x2={(i + 1) * 100} y1={0} y2={H} className="funneldiv" vectorEffect="non-scaling-stroke" />)}
      </svg>
    </div>
  );
}
