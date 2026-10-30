import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * A minimal History API router: the address bar is the navigation state, so
 * refresh, back/forward and shared links work. Screens are mapped to paths in
 * nav.ts; this only tracks and changes the pathname.
 */

const CHANGE = "eureka:navigate";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

/** The current pathname; re-renders on navigate() and on back/forward. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** Moves to `path` (a new history entry unless `replace`); a no-op when already there. */
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}) {
  if (path === window.location.pathname) return;
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(CHANGE));
}

/**
 * A screen's open record (a drawer or conversation) kept in step with the URL: `routeId`
 * comes from the path and changes are reported through `onChange`, so back/forward open and
 * close it. Without `onChange` (a screen rendered on its own) it is plain state seeded from `routeId`.
 */
export function useRoutedId(routeId: string | null, onChange?: (id: string | null) => void): [string | null, (id: string | null) => void] {
  const [id, setId] = useState(routeId);
  useEffect(() => { setId(routeId); }, [routeId]);
  const report = useRef(onChange);
  report.current = onChange;
  useEffect(() => { report.current?.(id); }, [id]);
  return [id, setId];
}

/**
 * One query-string parameter of the current URL as state ("" when absent), so a screen's
 * filters survive refresh and can be shared as a link. Setting it replaces the history entry
 * (typing in a filter should not fill the back stack); an empty value removes the parameter.
 */
export function useSearchParam(name: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(subscribe, () => new URLSearchParams(window.location.search).get(name) ?? "");
  const set = (next: string) => {
    const params = new URLSearchParams(window.location.search);
    if (next) params.set(name, next); else params.delete(name);
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new Event(CHANGE));
  };
  return [value, set];
}
