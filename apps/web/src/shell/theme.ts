import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "eureka-theme";

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* storage blocked: fall back to the system setting */ }
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Light or dark theme: the user's choice is remembered on this device; until then the system setting decides. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(initial);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const choose = useCallback((t: Theme) => {
    set(t);
    try { localStorage.setItem(KEY, t); } catch { /* not remembered; still applied */ }
  }, []);
  return [theme, choose];
}
