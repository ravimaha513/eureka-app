import type { CSSProperties } from "react";

/*
 * Isometric scene for the landing page: a laptop holding a candidate record, a floating
 * document, plants and a few people at work. Drawn as plain SVG: each flat face is a rect
 * in its own plane, placed with an isometric matrix, so no image assets ship.
 * Animation lives in login.css (`.heroart`, `.is-entering`).
 */

const OX = 220; // screen x of the laptop's back-left corner
const OY = 214; // screen y of the same corner at desk level
const W = 220;  // laptop width (x)
const D = 150;  // keyboard depth (y)
const LID = 160; // screen height (z)

/** Ground point (x, y, z) to SVG coordinates. */
const iso = (x: number, y: number, z = 0): [number, number] => [OX + (x - y) * 0.866, OY + (x + y) * 0.5 - z];

/** Planes: draw ordinary rects inside and they land on that face. */
const plane = {
  /** Upward face at height z, rect coords (x, y). */
  top: (z: number, x0 = 0, y0 = 0) => `matrix(0.866 0.5 -0.866 0.5 ${OX + (x0 - y0) * 0.866} ${OY + (x0 + y0) * 0.5 - z})`,
  /** Face looking front-left (normal +y) at depth y, rect coords (x, -z). */
  front: (y: number, x0 = 0) => `matrix(0.866 0.5 0 1 ${OX + (x0 - y) * 0.866} ${OY + (x0 + y) * 0.5})`,
  /** Face looking front-right (normal +x) at x, rect coords (y, -z). */
  side: (x: number, y0 = 0) => `matrix(-0.866 0.5 0 1 ${OX + (x - y0) * 0.866} ${OY + (x + y0) * 0.5})`,
};

type Look = { shirt: string; pants: string; skin: string; hair: string; long?: boolean };
const LOOKS: Record<string, Look> = {
  coral: { shirt: "var(--ha-coral)", pants: "var(--ha-navy)", skin: "#f1c3a3", hair: "#e0533f", long: true },
  navy: { shirt: "var(--ha-navy)", pants: "#30365f", skin: "#c98f6c", hair: "#1d2140" },
  blue: { shirt: "var(--ha-blue)", pants: "var(--ha-navy)", skin: "#f1c3a3", hair: "#3a2a28", long: true },
  white: { shirt: "#f4f6ff", pants: "var(--ha-navy)", skin: "#e7b08e", hair: "#1d2140" },
};

/** A small figure standing at its feet (0, 0); `stride` spreads the legs for a walking pose. */
function Figure({ look, stride = 0, sit = false, flip = false }: { look: Look; stride?: number; sit?: boolean; flip?: boolean }) {
  const legs = sit ? "M-4 -18 L9 -16 L9 0 M3 -18 L15 -15 L15 -1" : `M-3 -20 L${-3 - stride} 0 M3 -20 L${3 + stride} 0`;
  return (
    <g transform={flip ? "scale(-1 1)" : undefined}>
      <path d={legs} fill="none" stroke={look.pants} strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M-8 -36 Q0 -40 8 -36 L7 -18 L-7 -18 Z" fill={look.shirt} />
      <path d={`M-8 -34 L${-11 - stride / 2} -22 M8 -34 L${11 + stride / 2} -23`} stroke={look.shirt} strokeWidth="3.6" strokeLinecap="round" />
      <circle cx={-11 - stride / 2} cy="-21" r="1.9" fill={look.skin} />
      <circle cx={11 + stride / 2} cy="-22" r="1.9" fill={look.skin} />
      <rect x="-1.8" y="-40" width="3.6" height="4" fill={look.skin} />
      <circle cy="-44" r="5.6" fill={look.skin} />
      <path d={look.long ? "M-6 -44 a6 6 0 0 1 12 0 l1 9 q-3 1 -4 -4 l-1 -5 q-4 -3 -8 1 z" : "M-5.8 -44.5 a5.8 5.8 0 0 1 11.6 0 q-5.8 -3 -11.6 0z"} fill={look.hair} />
    </g>
  );
}

type Spot = { x: number; y: number; z?: number; look: keyof typeof LOOKS; stride?: number; sit?: boolean; flip?: boolean; s?: number; delay: number };
const PEOPLE: Spot[] = [
  { x: 150, y: -4, z: LID + 4, look: "coral", sit: true, s: 1, delay: 0 },
  { x: 150, y: 58, z: 10, look: "navy", delay: 0.4, flip: true },
  { x: 176, y: 96, z: 10, look: "blue", stride: 3, delay: 0.9 },
  { x: 98, y: 112, z: 10, look: "white", stride: 4, delay: 0.2, flip: true },
  { x: -10, y: 196, look: "coral", stride: 5, delay: 0.7, s: 1.1 },
  { x: 268, y: 62, look: "blue", delay: 1.1, s: 1.05 },
];

/** Where people head for when the portal opens: the middle of the screen. */
const [PX, PY] = iso(W / 2, 0, LID / 2 + 10);

function Plant({ x, y, s = 1, tint = "a" }: { x: number; y: number; s?: number; tint?: "a" | "b" }) {
  const [px, py] = iso(x, y);
  const leaf = tint === "a" ? "var(--ha-leaf)" : "var(--ha-leaf2)";
  return (
    <g transform={`translate(${px} ${py}) scale(${s})`} className="ha-plant">
      <ellipse cy="1" rx="15" ry="5" fill="var(--ha-shadow)" />
      <g className="ha-sway">
        {[-38, -18, 0, 18, 38].map((r, i) => (
          <ellipse key={r} cx="0" cy={-34 - (i % 2) * 6} rx="6" ry="20" fill={leaf} opacity={i % 2 ? 0.85 : 1} transform={`rotate(${r} 0 -16)`} />
        ))}
      </g>
      <path d="M-11 -18 L11 -18 L8 0 L-8 0 Z" fill="var(--ha-pot)" />
      <rect x="-12" y="-21" width="24" height="5" rx="1.5" fill="var(--ha-pot2)" />
    </g>
  );
}

/** A candidate record on the laptop screen: photo, name, and a checklist. */
function ScreenContent() {
  const rows = [0, 1, 2, 3];
  return (
    <g>
      <rect x="14" y={-LID + 6} width={W - 28} height={LID - 16} rx="5" fill="url(#ha-screen)" />
      <rect x="26" y={-LID + 18} width="44" height="44" rx="5" fill="var(--ha-card)" />
      <circle cx="48" cy={-LID + 34} r="8" fill="var(--ha-blue)" />
      <path d={`M34 ${-LID + 58} q14 -16 28 0z`} fill="var(--ha-blue)" />
      <rect x="80" y={-LID + 22} width="80" height="7" rx="3.5" fill="var(--ha-card)" />
      <rect x="80" y={-LID + 36} width="104" height="5" rx="2.5" fill="var(--ha-card)" opacity=".6" />
      <rect x="80" y={-LID + 48} width="60" height="5" rx="2.5" fill="var(--ha-card)" opacity=".6" />
      {rows.map((r) => (
        <g key={r} transform={`translate(26 ${-LID + 76 + r * 17})`}>
          <rect width="12" height="12" rx="3" fill="var(--ha-card)" />
          <path d="M3 6.2 L5.3 8.6 L9.3 3.6" fill="none" stroke="var(--ha-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="ha-check" style={{ animationDelay: `${0.6 + r * 0.35}s` }} />
          <rect x="20" y="3.5" width={120 - r * 18} height="5" rx="2.5" fill="var(--ha-card)" opacity=".75" />
        </g>
      ))}
    </g>
  );
}

export function HeroArt({ entering = false }: { entering?: boolean }) {
  const keys: [number, number][] = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 11; c++) keys.push([28 + c * 15, 18 + r * 15]);
  return (
    <svg className={`heroart${entering ? " is-entering" : ""}`} viewBox="0 0 540 470" role="img" aria-label="Recruiters working together on a candidate record in Eureka">
      <defs>
        <linearGradient id="ha-screen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--ha-screen1)" />
          <stop offset="1" stopColor="var(--ha-screen2)" />
        </linearGradient>
        <radialGradient id="ha-glow">
          <stop offset="0" stopColor="#fff" stopOpacity=".95" />
          <stop offset=".45" stopColor="var(--ha-portal)" stopOpacity=".7" />
          <stop offset="1" stopColor="var(--ha-portal)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx={iso(W / 2, D / 2)[0]} cy={iso(W / 2, D / 2)[1] + 18} rx="230" ry="92" fill="var(--ha-floor)" />
      <Plant x={-44} y={6} s={1.05} />

      <g className="ha-scene">
        {/* Lid: back, right edge, top edge, then the screen face. */}
        <g transform={plane.side(W, -8)}><rect x="0" y={-LID - 10} width="8" height={LID} fill="var(--ha-metal3)" /></g>
        <g transform={plane.top(LID + 10, 0, -8)}><rect width={W} height="8" fill="var(--ha-metal1)" /></g>
        <g transform={plane.front(0)}>
          <rect x="0" y={-LID - 10} width={W} height={LID} rx="6" fill="var(--ha-metal2)" />
          <g transform="translate(0 -10)"><ScreenContent /></g>
          <ellipse className="ha-portal" cx={W / 2} cy={-LID / 2 - 12} rx="64" ry="58" fill="url(#ha-glow)" />
        </g>

        {/* Base: keyboard deck and its two visible edges. */}
        <g transform={plane.side(W)}><rect width={D} height="10" y="-10" fill="var(--ha-metal3)" /></g>
        <g transform={plane.front(D)}><rect width={W} height="10" y="-10" fill="var(--ha-metal2)" /></g>
        <g transform={plane.top(10)}>
          <rect width={W} height={D} rx="6" fill="var(--ha-metal1)" />
          {keys.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="12" height="12" rx="2.5" fill="var(--ha-key)" />)}
          <rect x="84" y="98" width="54" height="36" rx="5" fill="var(--ha-key)" />
        </g>
      </g>

      {/* A floating paper: the paperwork part of the record. */}
      <g className="ha-doc">
        <g transform={plane.front(-40, 236)}>
          <rect x="0" y="-150" width="58" height="76" rx="5" fill="var(--ha-card)" stroke="var(--ha-line)" />
          <circle cx="29" cy="-128" r="9" fill="var(--ha-blue)" opacity=".85" />
          <rect x="12" y="-112" width="34" height="4" rx="2" fill="var(--ha-line)" />
          <rect x="10" y="-102" width="38" height="3.5" rx="1.75" fill="var(--ha-line)" />
          <rect x="10" y="-94" width="30" height="3.5" rx="1.75" fill="var(--ha-line)" />
        </g>
      </g>

      {PEOPLE.map((p, i) => {
        const [x, y] = iso(p.x, p.y, p.z ?? 0);
        const style = { "--tx": `${PX - x}px`, "--ty": `${PY - y}px`, "--d": `${p.delay}s`, "--i": i } as CSSProperties;
        return (
          <g key={i} transform={`translate(${x} ${y}) scale(${p.s ?? 0.9})`}>
            <g className="ha-person" style={style}>
              <ellipse cy="1" rx="9" ry="3" fill="var(--ha-shadow)" />
              <Figure look={LOOKS[p.look]!} stride={p.stride} sit={p.sit} flip={p.flip} />
            </g>
          </g>
        );
      })}

      <Plant x={250} y={150} s={1.15} tint="b" />

      {/* The closing beat: the record becomes Eureka. */}
      <g className="ha-mark" transform={`translate(${PX} ${PY + 40})`}>
        <rect x="-38" y="-38" width="76" height="76" rx="16" fill="var(--brand)" />
        <rect x="-20" y="-20" width="40" height="9" rx="2" fill="#fff" />
        <rect x="-20" y="-4" width="30" height="9" rx="2" fill="#fff" />
        <rect x="-20" y="12" width="40" height="9" rx="2" fill="#fff" />
      </g>
    </svg>
  );
}
