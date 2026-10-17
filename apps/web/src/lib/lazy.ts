import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const RELOADED = "eureka-chunk-reload";

/**
 * Loads a chunk. A deploy replaces the hashed chunk files, so a tab opened before it
 * can ask for one that is gone: reload once to pick up the new index.html, and only
 * fail if the chunk is still missing after that.
 */
async function loadChunk<M>(load: () => Promise<M>): Promise<M> {
  try {
    const m = await load();
    try { sessionStorage.removeItem(RELOADED); } catch { /* storage unavailable */ }
    return m;
  } catch (e) {
    let first = true;
    try { first = sessionStorage.getItem(RELOADED) === null; sessionStorage.setItem(RELOADED, "1"); } catch { first = false; }
    if (!first) throw e;
    window.location.reload();
    return new Promise<M>(() => undefined);
  }
}

/** React.lazy for a named export: the module becomes its own chunk, loaded on first render. */
export function lazyNamed<M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K): LazyExoticComponent<M[K]> {
  return lazy(async () => ({ default: (await loadChunk(load))[name] }));
}

/** React.lazy for a default export, with the same reload-once recovery. */
export function lazyDefault<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyExoticComponent<T> {
  return lazy(() => loadChunk(load));
}
