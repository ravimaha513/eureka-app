import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "../lib/router";

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  /** Optional count after the label (e.g. open items), tabular. */
  count?: number;
}

/**
 * Accessible tabs (WAI-ARIA tabs pattern) in the underline style (`[role="tablist"] .tab`:
 * muted text, selected = ink + 2px signal-red underline). Roving tabindex: only the selected
 * tab is in the Tab order; Left/Right move and select (automatic activation), Home/End jump.
 * One tabpanel renders `children(active)`, labelled by the selected tab.
 *
 * State: uncontrolled (`defaultValue`), controlled (`value` + `onChange`), or kept in the URL
 * with `urlKey` (`?tab=notes`, survives refresh/back; the default tab removes the parameter).
 *
 *   <Tabs label="Candidate sections" urlKey="tab" tabs={[{ key: "overview", label: "Overview" },
 *     { key: "docs", label: "Documents", count: 3 }]}>
 *     {(tab) => tab === "overview" ? <Overview /> : <Docs />}
 *   </Tabs>
 */
export function Tabs<K extends string>({ tabs, label, children, value, defaultValue, onChange, urlKey, className, panelClassName }: {
  tabs: readonly TabItem<K>[];
  /** Accessible name of the tablist, e.g. "Candidate sections". */
  label: string;
  children: (active: K) => ReactNode;
  value?: K;
  defaultValue?: K;
  onChange?: (key: K) => void;
  /** Query-string parameter that holds the selected tab. */
  urlKey?: string;
  /** Extra classes on the tablist (it always has "tabs"). */
  className?: string;
  panelClassName?: string;
}) {
  const id = useId();
  const first = defaultValue ?? tabs[0]?.key;
  const [local, setLocal] = useState<K | undefined>(first);
  const [params, setParams] = useSearchParams(urlKey ? [urlKey] : []);
  const fromUrl = urlKey ? (params[urlKey] as K | undefined) : undefined;
  const raw = value ?? (urlKey ? fromUrl || first : local);
  const active = (tabs.some((t) => t.key === raw) ? raw : first) as K;

  const select = (key: K) => {
    if (urlKey) setParams({ [urlKey]: key === first ? "" : key });
    else if (value === undefined) setLocal(key);
    onChange?.(key);
  };
  const tabId = (k: K) => `${id}-tab-${k}`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === active);
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length
      : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const key = tabs[next]!.key;
    select(key);
    document.getElementById(tabId(key))?.focus();
  };

  return (
    <>
      <div className={["tabs", className ?? ""].filter(Boolean).join(" ")} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button key={t.key} id={tabId(t.key)} type="button" role="tab" className="tab"
            aria-selected={t.key === active} aria-controls={`${id}-panel`} tabIndex={t.key === active ? 0 : -1}
            onClick={() => select(t.key)}>
            {t.label}{t.count !== undefined && <span className="tabcount">{t.count}</span>}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={tabId(active)} tabIndex={0} className={panelClassName}>
        {children(active)}
      </div>
    </>
  );
}
