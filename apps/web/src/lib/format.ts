/** "offer_letter" → "Offer letter", "i9" → "I9" (document types are snake_case keys). */
export const docTypeLabel = (t: string) => { const s = t.replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };

/** "Jan 5, 2026, 9:30 AM": a timestamp in the viewer's locale and time zone. */
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "Jan 5, 2026": the date of a timestamp in the viewer's locale and time zone. */
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$1,234.50": US dollars with a thousands separator and 2 decimals. */
export const formatUsd = (n: number) => USD.format(n);
