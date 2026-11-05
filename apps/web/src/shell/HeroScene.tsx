import { useEffect, useRef, useState } from "react";
import "./heroscene.css";

/**
 * Sign-in hero product shot. The three.js scene (./hero3d) is loaded lazily so
 * it never blocks the sign-in form; without WebGL the panel simply stays empty.
 * Decorative only (aria-hidden). prefers-reduced-motion skips the intro and idle motion.
 */
export function HeroScene() {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let gone = false;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    import("./hero3d")
      .then((m) => { if (!gone && ref.current) dispose = m.mountHero(ref.current, { reduced, onReady: () => setReady(true) }); })
      .catch(() => {});
    return () => { gone = true; dispose?.(); };
  }, []);
  return <div ref={ref} className={ready ? "hs ready" : "hs"} aria-hidden="true" />;
}
