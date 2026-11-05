import { useEffect, useRef, useState } from "react";
import { ArrowRight, Layers, Lock, Moon, Sun, Users, Zap } from "lucide-react";
import { navigate } from "../lib/router";
import { useTheme } from "../shell/theme";
import { BrandMark } from "../shell/ui";
import { HeroArt } from "./HeroArt";

const SEEN = "eureka-landing-seen";

/** First visit on this device to `/` while signed out shows the landing page; afterwards `/` goes straight to sign-in. */
export function shouldShowLanding(): boolean {
  if (new URLSearchParams(window.location.search).has("error")) return false;
  try { return localStorage.getItem(SEEN) !== "1"; } catch { return true; }
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const FEATURES = [
  { icon: Users, title: "Build your talent bench", text: "Keep a ready pool of qualified candidates" },
  { icon: Zap, title: "Manage the full pipeline", text: "Track submissions, interviews and placements" },
  { icon: Layers, title: "Handle paperwork end-to-end", text: "BGCs, contracts, compliance and payments" },
] as const;

export function Landing() {
  const [theme, setTheme] = useTheme();
  const [entering, setEntering] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const toSignIn = (animate: boolean) => {
    try { localStorage.setItem(SEEN, "1"); } catch { /* shown again next time; harmless */ }
    if (!animate || reducedMotion()) { navigate("/login"); return; }
    setEntering(true);
    timer.current = window.setTimeout(() => navigate("/login"), 1500);
  };

  return (
    <div className={`landing${entering ? " is-entering" : ""}`}>
      <header className="landbar">
        <div className="brand landbrand"><BrandMark size={34} /><span className="landname">Eureka<small>Staffing</small></span></div>
        <div className="landactions">
          <button type="button" className="btn ghost themechip" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}{theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
          <button type="button" className="btn landsignin" onClick={() => toSignIn(false)}>Sign in</button>
        </div>
      </header>

      <main className="landhero">
        <div className="landcopy">
          <h1>The bench, the pipeline and the paperwork, in one record.</h1>
          <p className="landlede">A unified staffing platform to source, screen, manage and place talent, faster.</p>
          <button type="button" className="btn ctabtn landcta" onClick={() => toSignIn(true)} disabled={entering}>
            Get started <ArrowRight size={17} aria-hidden="true" />
          </button>
        </div>
        <div className="landart"><HeroArt entering={entering} /></div>
      </main>

      <ul className="landfeatures" aria-label="What Eureka does">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <li key={title}>
            <span className="feaicon"><Icon size={19} aria-hidden="true" /></span>
            <span><b>{title}</b><small>{text}</small></span>
          </li>
        ))}
      </ul>

      <footer className="landfoot"><Lock size={13} aria-hidden="true" /> Authorized team members only.</footer>
    </div>
  );
}
