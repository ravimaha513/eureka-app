import type { CSSProperties } from "react";
import "./heroscene.css";

/**
 * Animated isometric scene for the sign-in hero, built with CSS 3D transforms
 * (no WebGL, no extra dependencies). One 16s loop:
 *   team works around an open laptop → a portal opens on the screen and they
 *   walk in → the lid closes into the Eureka badge → it reopens and repeats.
 * Purely decorative (aria-hidden); prefers-reduced-motion shows a still frame.
 */

type Person = { x: number; y: number; tx: number; ty: number; d: number; shirt: string; pants: string; hair: string; long?: boolean };

// Positions are in laptop-base pixels (base is 340 × 230). tx/ty = where they walk to (the screen).
const PEOPLE: Person[] = [
  { x: 70, y: 150, tx: 150, ty: 30, d: 0, shirt: "#ef5a52", pants: "#2b3a8f", hair: "#c8322b", long: true },
  { x: 150, y: 175, tx: 165, ty: 28, d: 0.35, shirt: "#ffffff", pants: "#1b2152", hair: "#1b2152" },
  { x: 245, y: 140, tx: 180, ty: 30, d: 0.7, shirt: "#4b74e8", pants: "#1b2152", hair: "#2a1f3d", long: true },
  { x: 205, y: 95, tx: 172, ty: 26, d: 1.0, shirt: "#26306b", pants: "#3c4a9e", hair: "#1b1530" },
];

function Figure({ p }: { p: Person }) {
  return (
    <svg className="hs-fig" viewBox="0 0 30 80" width="30" height="80">
      <ellipse cx="15" cy="78" rx="9" ry="2.2" fill="rgba(10,14,40,.28)" />
      <g className="hs-leg hs-leg-a"><rect x="10" y="44" width="4.6" height="32" rx="2" fill={p.pants} /><rect x="8.5" y="74" width="7" height="3.4" rx="1.5" fill="#141833" /></g>
      <g className="hs-leg hs-leg-b"><rect x="15.4" y="44" width="4.6" height="32" rx="2" fill={p.pants} /><rect x="14.5" y="74" width="7" height="3.4" rx="1.5" fill="#141833" /></g>
      <rect x="8" y="20" width="14" height="27" rx="5" fill={p.shirt} />
      <g className="hs-arm"><rect x="5" y="22" width="4" height="19" rx="2" fill={p.shirt} /><circle cx="7" cy="41.5" r="2" fill="#f2c4a4" /></g>
      <g className="hs-arm hs-arm-b"><rect x="21" y="22" width="4" height="19" rx="2" fill={p.shirt} /><circle cx="23" cy="41.5" r="2" fill="#f2c4a4" /></g>
      <rect x="13" y="16" width="4" height="5" fill="#e9b693" />
      <circle cx="15" cy="11" r="6" fill="#f2c4a4" />
      {p.long
        ? <path d="M8.6 11a6.4 6.4 0 0 1 12.8 0v2c-1.2-2.8-3.6-4.2-6.4-4.2S9.8 10.2 8.6 13v9.5c-2-2.5-1.6-7.8 0-11.5z" fill={p.hair} />
        : <path d="M8.8 10.5a6.2 6.2 0 0 1 12.4 0c-1.8-1.7-3.9-2.3-6.2-2.3s-4.4.6-6.2 2.3z" fill={p.hair} />}
    </svg>
  );
}

function Plant({ big }: { big?: boolean }) {
  return (
    <svg className="hs-plantsvg" viewBox="0 0 60 90" width={big ? 60 : 46} height={big ? 90 : 69}>
      <ellipse cx="30" cy="87" rx="16" ry="3" fill="rgba(10,14,40,.3)" />
      <path d="M30 60C24 44 12 40 6 26c10 2 20 10 24 26 2-16 4-30 14-44 2 14-4 30-14 44 4-10 14-16 24-16-4 10-12 18-24 24z" fill="#2fdcb4" />
      <path d="M30 60C27 48 22 38 16 30c8 4 12 12 14 22 1-12 5-22 12-30-1 12-5 24-12 38z" fill="#14b892" />
      <path d="M18 60h24l-3 26H21z" fill="#eef1fb" /><path d="M18 60h24v4H18z" fill="#cfd6ee" />
    </svg>
  );
}

function DocCard() {
  return (
    <div className="hs-doc">
      <div className="hs-doc-av" /><i /><i /><i className="s" /><i /><i className="s" />
    </div>
  );
}

export function HeroScene() {
  return (
    <div className="hs" aria-hidden="true">
      <div className="hs-cam">
        <div className="hs-world">
          <div className="hs-floorglow" />
          <div className="hs-laptop">
            {/* base: top + sides */}
            <div className="hs-base">
              <div className="hs-face hs-front" />
              <div className="hs-face hs-right" />
              <div className="hs-face hs-left" />
              <div className="hs-top">
                <div className="hs-keys">{Array.from({ length: 48 }, (_, i) => <span key={i} />)}</div>
                <div className="hs-pad" />
              </div>
            </div>
            {/* lid hinged on the back edge */}
            <div className="hs-lid">
              <div className="hs-screen">
                <div className="hs-ui">
                  <div className="hs-ui-head"><div className="hs-ui-av" /><div><i /><i className="s" /></div></div>
                  {[0, 1, 2, 3].map((r) => <div key={r} className="hs-ui-row"><b>✓</b><i /><b>✓</b><i /></div>)}
                </div>
                <div className="hs-portal"><span /><span /><span /></div>
                <div className="hs-screenlogo"><span className="logo"><svg viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="1.5" width="12" height="2.4" rx=".5" /><rect x="1" y="5.8" width="9" height="2.4" rx=".5" /><rect x="1" y="10.1" width="12" height="2.4" rx=".5" /></svg></span></div>
              </div>
              <div className="hs-cover">
                <span className="logo"><svg viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="1.5" width="12" height="2.4" rx=".5" /><rect x="1" y="5.8" width="9" height="2.4" rx=".5" /><rect x="1" y="10.1" width="12" height="2.4" rx=".5" /></svg></span>
                <b>Eureka</b><small>Staffing</small>
              </div>
            </div>
            {PEOPLE.map((p, i) => (
              <div key={i} className="hs-person" style={{ "--x": `${p.x}px`, "--y": `${p.y}px`, "--tx": `${p.tx}px`, "--ty": `${p.ty}px`, animationDelay: `${p.d}s` } as CSSProperties}>
                <div className="hs-bb"><Figure p={p} /></div>
              </div>
            ))}
          </div>
          <div className="hs-prop hs-plant1"><div className="hs-bb"><Plant big /></div></div>
          <div className="hs-prop hs-plant2"><div className="hs-bb"><Plant /></div></div>
          <div className="hs-prop hs-card1"><div className="hs-bb"><DocCard /></div></div>
          <div className="hs-prop hs-card2"><div className="hs-bb"><DocCard /></div></div>
          <div className="hs-sparks"><div className="hs-bb"><i /><i /><i /></div></div>
        </div>
      </div>
    </div>
  );
}
