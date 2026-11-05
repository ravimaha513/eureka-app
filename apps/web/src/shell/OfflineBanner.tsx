import { useEffect, useState, useSyncExternalStore } from "react";
import { Hourglass, WifiOff } from "lucide-react";
import { BUSY_EVENT } from "../api";

/**
 * "Busy, retrying" while any read waits out a 503's Retry-After before its one retry (api.ts).
 * It clears by itself; if the retry fails too, the screen shows its own error.
 */
export function BusyBanner() {
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    const on = (e: Event) => setWaiting((n) => Math.max(0, n + Number((e as CustomEvent<number>).detail)));
    window.addEventListener(BUSY_EVENT, on);
    return () => window.removeEventListener(BUSY_EVENT, on);
  }, []);
  return (
    <div role="status" aria-live="polite" className={waiting ? "offline-banner" : "sr-only"}>
      {waiting > 0 && <><Hourglass size={16} aria-hidden="true" />The server is busy. Retrying in a moment…</>}
    </div>
  );
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

/** The browser's connection state (true while the browser reports a network). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}

/**
 * Warns while the browser is offline: saves would fail, and lists may be stale.
 * React Query refetches on reconnect, so nothing else needs doing when it clears.
 */
export function OfflineBanner() {
  const online = useOnline();
  return (
    <div role="status" aria-live="polite" className={online ? "sr-only" : "offline-banner"}>
      {!online && <><WifiOff size={16} aria-hidden="true" />You're offline. Changes won't be saved until the connection is back.</>}
    </div>
  );
}
