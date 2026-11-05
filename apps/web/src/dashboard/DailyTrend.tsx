import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Series } from "../ui/Charts";

const shortDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Daily counts as straight lines between real points (no smoothing, which would imply
 * fractional events between days), with a dot on every day when there are few enough to
 * read. Same text alternative and theme hooks as ui/Charts TrendChart (`.chart` figure).
 * Local to the dashboard until TrendChart takes a curve option (shared request).
 */
export function DailyTrend({ data, series, label, height = 260 }: {
  data: ({ date: string } & Record<string, number | string>)[]; series: Series[]; label: string; height?: number;
}) {
  const total = (k: string) => data.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  const dots = data.length <= 31;
  return (
    <div className="chart" role="img" style={{ height }}
      aria-label={`${label}: ${series.map((s) => `${s.label} ${total(s.key)} in total`).join(", ")}`}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height }}>
        <LineChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: -14 }}>
          <CartesianGrid vertical={false} strokeDasharray="4 4" />
          <XAxis dataKey="date" tickFormatter={shortDay} tickLine={false} axisLine={false} minTickGap={24} dy={6} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={44} />
          <Tooltip labelFormatter={(d) => shortDay(String(d))} cursor={{ strokeDasharray: "4 4" }} />
          {series.map((s) => (
            <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
              dot={dots ? { r: 2.5, strokeWidth: 0, fill: s.color } : false} activeDot={{ r: 5, strokeWidth: 2 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
