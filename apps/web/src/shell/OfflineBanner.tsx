import { useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";

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
