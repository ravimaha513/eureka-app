import type { CSSProperties } from "react";

/** Dependency-free chart pieces: CSS bars and an SVG donut. Each carries a text alternative; the data tables stay on the page. */

const pct = (n: number, max: number) => (max > 0 ? Math.max(n > 0 ? 2 : 0, Math.round((n / max) * 100)) : 0);

export interface Bar { key: string; label: string; value: number; hint?: string }

/** Horizontal bars scaled to the largest value. */
export function BarChart({ bars, label, tone = 0, scaleTo }: { bars: Bar[]; label: string; tone?: number; scaleTo?: number }) {
  const max = scaleTo ?? Math.max(0, ...bars.map((b) => b.value));
  return (
    <div className="chart bars" role="img" aria-label={`${label}: ${bars.map((b) => `${b.label} ${b.value}`).join(", ")}`}>
      {bars.map((b, i) => (
        <div key={b.key} className="barrow" aria-hidden="true">
          <span className="barlabel" title={b.label}>{b.label}</span>
          <span className="bartrack">
            <span className={`barfill c${(tone + i) % 6}`} style={{ width: `${pct(b.value, max)}%` } as CSSProperties} />
          </span>
          <span className="barvalue">{b.value}{b.hint && <span className="barhint"> {b.hint}</span>}</span>
        </div>
      ))}
      {bars.length === 0 && <p className="muted">No data.</p>}
    </div>
  );
}

/** A funnel: bars scaled to the first stage, with the step-to-step conversion. */
export function Funnel({ stages, label }: { stages: { key: string; label: string; value: number }[]; label: string }) {
  const top = stages[0]?.value ?? 0;
  const bars = stages.map((s, i) => {
    const prev = stages[i - 1]?.value;
    const hint = i > 0 && prev ? `(${Math.round((s.value / prev) * 100)}% of ${stages[i - 1]!.label.toLowerCase()})` : undefined;
    return { ...s, hint };
  });
  return <BarChart bars={bars} label={label} scaleTo={top} />;
}

/** Donut of parts of a whole, with a legend. */
export function Donut({ parts, label, centre }: { parts: { key: string; label: string; value: number }[]; label: string; centre: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const R = 42, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="chart donut" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={R} className="donuttrack" />
        {total > 0 && parts.map((p, i) => {
          const len = (p.value / total) * C;
          const el = (
            <circle key={p.key} cx="50" cy="50" r={R} className={`donutseg c${i % 6}`}
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform="rotate(-90 50 50)" />
          );
          offset += len;
          return el;
        })}
        <text x="50" y="49" textAnchor="middle" className="donutnum">{total}</text>
        <text x="50" y="62" textAnchor="middle" className="donutcap">{centre}</text>
      </svg>
      <div className="legend" aria-hidden="true">
        {parts.map((p, i) => (
          <span key={p.key} className="legenditem"><i className={`swatch c${i % 6}`} />{p.label} <b>{p.value}</b></span>
        ))}
      </div>
    </div>
  );
}
